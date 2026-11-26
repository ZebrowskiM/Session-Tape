import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Note, NoteVersion, Session, SessionEvent, SessionEventData, Snapshot } from "./contracts";
import { migrateSessionEvents } from "./session-events";

const CURRENT_SCHEMA_VERSION = 3;

export class InputError extends Error {}

function textField(raw: unknown, name: string, maxLength: number, allowEmpty = false): string {
  if (typeof raw !== "string" || raw.length > maxLength || (!allowEmpty && !raw.trim())) {
    throw new InputError(`Enter a valid ${name} (up to ${maxLength} characters).`);
  }
  return raw.trim();
}

function uuid(raw: unknown): string {
  if (typeof raw !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new InputError("This entry has an invalid ID. Reopen the window and try again.");
  }
  return raw;
}

export class Store {
  private readonly db: DatabaseSync;
  // Only the process that saw the session start has a monotonic origin.
  private clockOrigin: { sessionId: string; monotonicMs: number } | null = null;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      const schemaVersion = this.db.prepare("PRAGMA user_version");
      if (schemaVersion.get()?.user_version === CURRENT_SCHEMA_VERSION) return;

      this.db.exec("BEGIN IMMEDIATE");
      // Another connection may have completed the upgrade before we acquired the write lock.
      let version = schemaVersion.get()?.user_version;
      if (version === 0) {
        this.db.exec(`
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY NOT NULL,
            title TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT
          );
          CREATE UNIQUE INDEX only_one_active ON sessions ((1)) WHERE finished_at IS NULL;
          CREATE TABLE notes (
            id TEXT PRIMARY KEY NOT NULL,
            session_id TEXT NOT NULL REFERENCES sessions(id),
            body TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX notes_by_session ON notes(session_id);
          PRAGMA user_version = 1;
        `);
        version = 1;
      }
      if (version === 1) {
        this.db.exec(`
          ALTER TABLE notes ADD COLUMN updated_at TEXT;
          CREATE TABLE note_versions (
            id INTEGER PRIMARY KEY,
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            saved_at TEXT NOT NULL
          );
          CREATE INDEX note_versions_by_note ON note_versions(note_id);
          PRAGMA user_version = 2;
        `);
        version = 2;
      }
      if (version === 2) {
        migrateSessionEvents(this.db);
        this.db.exec("PRAGMA user_version = 3");
      } else if (version !== CURRENT_SCHEMA_VERSION) {
        throw new Error("This database was created by a different version of Session Tape.");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      // Closing the connection rolls back any uncommitted schema and data changes.
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(mode: "read" | "write", action: () => T): T {
    this.db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendEvent(id: string, sessionId: string, at: Date, event: SessionEventData,
                      phase: SessionEvent["phase"], elapsedMs: number | null): void {
    this.db.prepare(`
      INSERT INTO session_events
        (id, session_id, sequence, occurred_at, utc_offset_minutes, elapsed_ms, phase, kind, payload)
      SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?, ?
      FROM session_events WHERE session_id = ?
    `).run(id, sessionId, at.toISOString(), -at.getTimezoneOffset(), elapsedMs, phase,
      event.kind, JSON.stringify(event.payload), sessionId);
  }

  private elapsed(sessionId: string): number | null {
    if (this.clockOrigin?.sessionId !== sessionId) return null;
    return Math.floor(performance.now() - this.clockOrigin.monotonicMs);
  }

  sessionEvents(raw: unknown): SessionEvent[] {
    if (!raw || typeof raw !== "object") throw new InputError("Select a session.");
    const query = raw as Record<string, unknown>;
    const sessionId = uuid(query.sessionId);
    const after = query.afterSequence === undefined ? 0 : query.afterSequence;
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
      throw new InputError("Invalid event sequence.");
    }
    const rows = this.db.prepare(`
      SELECT id, session_id AS sessionId, sequence, sequence_source AS sequenceSource, occurred_at AS occurredAt,
        utc_offset_minutes AS utcOffsetMinutes, elapsed_ms AS elapsedMs, phase,
        kind, payload_version AS payloadVersion, payload
      FROM session_events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT 100
    `).all(sessionId, after);
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload as string) }) as SessionEvent);
  }

  private active(): Session | null {
    const row = this.db.prepare(
      "SELECT id, title, started_at AS startedAt FROM sessions WHERE finished_at IS NULL"
    ).get();
    return row ? row as unknown as Session : null;
  }

  snapshot(rawQuery: unknown): Snapshot {
    const query = textField(rawQuery, "search term", 200, true);
    return this.transaction("read", () => this.readSnapshot(query));
  }

  private readSnapshot(query: string): Snapshot {
    const rows = this.db.prepare(`
      SELECT n.id, n.session_id AS sessionId, s.title AS sessionTitle, n.body,
        n.created_at AS createdAt, COALESCE(n.updated_at, n.created_at) AS updatedAt
      FROM notes n JOIN sessions s ON s.id = n.session_id
      WHERE instr(lower(n.body), lower(?)) > 0 OR instr(lower(s.title), lower(?)) > 0
      ORDER BY n.rowid DESC LIMIT 100
    `).all(query, query);
    const notes = rows as unknown as Note[];
    if (notes.length) {
      const placeholders = notes.map(() => "?").join(", ");
      const history = this.db.prepare(`
        SELECT note_id AS noteId, body, saved_at AS savedAt
        FROM note_versions
        WHERE note_id IN (${placeholders})
        ORDER BY id DESC
      `).all(...notes.map(note => note.id)) as unknown as (NoteVersion & { noteId: string })[];
      const byNote = new Map<string, NoteVersion[]>();
      for (const version of history) {
        const versions = byNote.get(version.noteId) ?? [];
        versions.push({ body: version.body, savedAt: version.savedAt });
        byNote.set(version.noteId, versions);
      }
      for (const note of notes) {
        note.versions = [
          { body: note.body, savedAt: note.updatedAt },
          ...(byNote.get(note.id) ?? []),
        ];
      }
    }
    return { active: this.active(), notes };
  }

  start(rawTitle: unknown): void {
    const title = textField(rawTitle, "session title", 120);
    this.clockOrigin = this.transaction("write", () => {
      if (this.active()) throw new InputError("Finish the current session before starting another.");
      const sessionId = randomUUID();
      const at = new Date();
      const monotonicMs = performance.now();
      this.db.prepare("INSERT INTO sessions(id, title, started_at) VALUES (?, ?, ?)")
        .run(sessionId, title, at.toISOString());
      this.appendEvent(sessionId + ":start", sessionId, at,
        { kind: "session.started", payload: { title } }, "focus", 0);
      return { sessionId, monotonicMs };
    });
  }

  finish(rawId: unknown): void {
    const id = uuid(rawId);
    this.transaction("write", () => {
      const at = new Date();
      const result = this.db.prepare(
        "UPDATE sessions SET finished_at = ? WHERE id = ? AND finished_at IS NULL"
      ).run(at.toISOString(), id);
      if (!result.changes) throw new InputError("That session is already closed or unavailable.");
      this.appendEvent(id + ":finish", id, at, { kind: "session.finished", payload: {} },
        "finished", this.elapsed(id));
    });
    this.clockOrigin = null;
  }

  addNote(raw: unknown): void {
    if (!raw || typeof raw !== "object") throw new InputError("Enter a note first.");
    const fields = raw as Record<string, unknown>;
    const id = uuid(fields.id);
    const sessionId = uuid(fields.sessionId);
    const body = textField(fields.body, "note", 16000);
    this.transaction("write", () => {
      const original = this.db.prepare(`
        SELECT session_id, json_extract(payload, '$.body') AS body FROM session_events WHERE id = ?
      `).get(id);
      if (original) {
        if (original.session_id === sessionId && original.body === body) return;
        throw new InputError("This note ID already belongs to a different entry.");
      }
      const at = new Date();
      const result = this.db.prepare(`
        INSERT INTO notes(id, session_id, body, created_at)
        SELECT ?, id, ?, ? FROM sessions WHERE id = ? AND finished_at IS NULL
      `).run(id, body, at.toISOString(), sessionId);
      if (!result.changes) throw new InputError("This session has finished. Your text is still in the editor.");
      const elapsedMs = this.elapsed(sessionId);
      this.appendEvent(id, sessionId, at, { kind: "note.added", payload: { noteId: id, body } },
        elapsedMs === null ? null : "focus", elapsedMs);
    });
  }

  editNote(raw: unknown): void {
    if (!raw || typeof raw !== "object") throw new InputError("Enter a note first.");
    const fields = raw as Record<string, unknown>;
    const id = uuid(fields.id);
    const body = textField(fields.body, "note", 16000);
    const expectedUpdatedAt = textField(fields.expectedUpdatedAt, "note version", 40);

    this.transaction("write", () => {
      const existing = this.db.prepare(`
        SELECT n.body, n.created_at, n.updated_at, n.session_id, s.finished_at
        FROM notes n JOIN sessions s ON s.id = n.session_id WHERE n.id = ?
      `).get(id);
      if (!existing) throw new InputError("This note is unavailable.");
      const currentVersion = existing.updated_at ?? existing.created_at;
      if (existing.body === body) return;
      if (currentVersion !== expectedUpdatedAt) {
        throw new InputError("This note changed elsewhere. Reload it before saving your edit.");
      }

      const at = new Date();
      const currentTime = Date.parse(currentVersion);
      const updatedAt = new Date(Math.max(at.getTime(), currentTime + 1)).toISOString();
      const previous = this.db.prepare(
        "INSERT INTO note_versions(note_id, body, saved_at) VALUES (?, ?, ?)"
      ).run(id, existing.body, currentVersion);
      this.db.prepare("UPDATE notes SET body = ?, updated_at = ? WHERE id = ?").run(body, updatedAt, id);
      const sessionId = existing.session_id as string;
      const elapsedMs = existing.finished_at ? null : this.elapsed(sessionId);
      const phase = existing.finished_at ? "finished" : elapsedMs === null ? null : "focus";
      this.appendEvent(id + ":edit:" + previous.lastInsertRowid, sessionId, at,
        { kind: "note.edited", payload: { noteId: id, body } }, phase, elapsedMs);
    });
  }

  close(): void {
    this.db.close();
  }
}
