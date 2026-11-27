import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Note, NoteVersion, PhaseChange, PhaseTotals, Session, SessionEvent, SessionEventData, SessionEventPage, Snapshot } from "./contracts";
import { saveMigrationSnapshot } from "./migration-snapshot";
import { migrateSessionEvents } from "./session-events";

const CURRENT_SCHEMA_VERSION = 5;
const EVENT_PAGE_SIZE = 100;

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
  readonly upgradeCopyPath: string | null;
  // Only the process that saw the session start has a monotonic origin.
  private clockOrigin: { sessionId: string; monotonicMs: number } | null = null;

  private phaseAnchor: { sessionId: string; sequence: number; at: number } | null = null;

  constructor(path: string, private readonly monotonicNow: () => number = () => performance.now()) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.upgradeCopyPath = this.upgrade();
      // Only intervals observed in this process can extend the last committed phase totals.
      const active = this.active();
      if (active?.phase) {
        this.phaseAnchor = { sessionId: active.id, sequence: active.phaseSequence, at: Math.floor(this.monotonicNow()) };
      }
    } catch (error) {
      // Closing rolls back any uncommitted migration.
      this.db.close();
      throw error;
    }
  }

  private upgrade(): string | null {
    const schemaVersion = this.db.prepare("PRAGMA user_version");
    if (schemaVersion.get()?.user_version === CURRENT_SCHEMA_VERSION) return null;
    let snapshotPath: string | undefined;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      // Another connection may have completed the upgrade before we acquired the write lock.
      let version = schemaVersion.get()?.user_version;
      if (typeof version === "number" && version > 0 && version < CURRENT_SCHEMA_VERSION) {
        const sourcePath = this.db.location();
        if (sourcePath) snapshotPath = saveMigrationSnapshot(sourcePath, version);
      }
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
      if (version === 2 || version === 3 || version === 4) {
        migrateSessionEvents(this.db, version);
        this.db.exec("PRAGMA user_version = 5");
      } else if (version !== CURRENT_SCHEMA_VERSION) {
        throw new Error("This database was created by a different version of Session Tape.");
      }
      if (this.db.prepare("PRAGMA foreign_key_check").get()) {
        throw new Error("The upgraded archive contains a broken record reference.");
      }
      this.db.exec("COMMIT");
      return snapshotPath ?? null;
    } catch (error) {
      if (snapshotPath) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Upgrade failed. The verified pre-upgrade copy is at\n${snapshotPath}\n\n${reason}`, { cause: error });
      }
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
                      phase: SessionEvent["phase"], elapsedMs: number | null): number {
    const row = this.db.prepare(`
      INSERT INTO session_events
        (id, session_id, sequence, occurred_at, utc_offset_minutes, elapsed_ms, phase, kind, payload)
      SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?, ?
      FROM session_events WHERE session_id = ? RETURNING sequence
    `).get(id, sessionId, at.toISOString(), -at.getTimezoneOffset(), elapsedMs, phase,
      event.kind, JSON.stringify(event.payload), sessionId);
    return row!.sequence as number;
  }

  private elapsed(sessionId: string, now = this.monotonicNow()): number | null {
    if (this.clockOrigin?.sessionId !== sessionId) return null;
    return Math.floor(now) - this.clockOrigin.monotonicMs;
  }

  sessionEvents(raw: unknown): SessionEventPage {
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
      FROM session_events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
    `).all(sessionId, after, EVENT_PAGE_SIZE + 1);
    const events = rows.slice(0, EVENT_PAGE_SIZE).map(row =>
      ({ ...row, payload: JSON.parse(row.payload as string) }) as SessionEvent);
    const nextSequence = rows.length > EVENT_PAGE_SIZE ? events[events.length - 1].sequence : null;
    return { events, nextSequence };
  }

  private active(): Session | null {
    const row = this.db.prepare(`
      SELECT s.id, s.title, s.started_at AS startedAt, e.phase, e.sequence AS phaseSequence,
        coalesce(json_extract(e.payload, '$.focusMs'), 0) AS focusMs,
        coalesce(json_extract(e.payload, '$.pausedMs'), 0) AS pausedMs
      FROM sessions s JOIN session_events e ON e.session_id = s.id
      WHERE s.finished_at IS NULL AND e.kind IN ('session.started', 'session.paused', 'session.resumed')
      ORDER BY e.sequence DESC LIMIT 1
    `).get();
    return row ? row as unknown as Session : null;
  }

  private phaseTotals(active: Session, now: number): PhaseTotals {
    const totals = { focusMs: active.focusMs, pausedMs: active.pausedMs };
    const anchor = this.phaseAnchor;
    if (anchor?.sessionId === active.id && anchor.sequence === active.phaseSequence) {
      const duration = now - anchor.at;
      if (active.phase === "focus") totals.focusMs += duration;
      if (active.phase === "paused") totals.pausedMs += duration;
    }
    return totals;
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
    const origin = this.transaction("write", () => {
      if (this.active()) throw new InputError("Finish the current session before starting another.");
      const sessionId = randomUUID();
      const at = new Date();
      const monotonicMs = Math.floor(this.monotonicNow());
      this.db.prepare("INSERT INTO sessions(id, title, started_at) VALUES (?, ?, ?)")
        .run(sessionId, title, at.toISOString());
      this.appendEvent(sessionId + ":start", sessionId, at,
        { kind: "session.started", payload: { title } }, "focus", 0);
      return { sessionId, monotonicMs };
    });
    this.clockOrigin = origin;
    this.phaseAnchor = { sessionId: origin.sessionId, sequence: 1, at: origin.monotonicMs };
  }

  changePhase(raw: unknown): void {
    if (!raw || typeof raw !== "object") throw new InputError("Select a session phase.");
    const { sessionId, phase, expectedSequence } = raw as Partial<PhaseChange>;
    const id = uuid(sessionId);
    if ((phase !== "focus" && phase !== "paused") || typeof expectedSequence !== "number" ||
        !Number.isSafeInteger(expectedSequence) || expectedSequence < 1) {
      throw new InputError("Invalid phase change.");
    }
    const anchor = this.transaction("write", () => {
      const active = this.active();
      if (active?.id !== id) throw new InputError("That session is already closed or unavailable.");
      if (active.phase === phase) return null;
      if (active.phaseSequence !== expectedSequence) throw new InputError("The session phase changed. Try again.");
      const now = Math.floor(this.monotonicNow());
      const sequence = this.appendEvent(randomUUID(), id, new Date(), {
        kind: phase === "paused" ? "session.paused" : "session.resumed",
        payload: this.phaseTotals(active, now),
      }, phase, this.elapsed(id, now));
      return { sessionId: id, sequence, at: now };
    });
    if (anchor) this.phaseAnchor = anchor;
  }

  finish(rawId: unknown): void {
    const id = uuid(rawId);
    this.transaction("write", () => {
      const active = this.active();
      if (active?.id !== id) throw new InputError("That session is already closed or unavailable.");
      const now = Math.floor(this.monotonicNow());
      const at = new Date();
      this.db.prepare(
        "UPDATE sessions SET finished_at = ? WHERE id = ? AND finished_at IS NULL"
      ).run(at.toISOString(), id);
      this.appendEvent(id + ":finish", id, at, { kind: "session.finished", payload: this.phaseTotals(active, now) },
        "finished", this.elapsed(id, now));
    });
    this.clockOrigin = null;
    this.phaseAnchor = null;
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
        this.active()!.phase, elapsedMs);
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
      const phase = existing.finished_at ? "finished" : this.active()!.phase;
      this.appendEvent(id + ":edit:" + previous.lastInsertRowid, sessionId, at,
        { kind: "note.edited", payload: { noteId: id, body } }, phase, elapsedMs);
    });
  }

  close(): void {
    this.db.close();
  }
}
