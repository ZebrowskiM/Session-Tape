import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Note, NoteVersion, Session, Snapshot } from "./contracts";

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

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      let version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 0) {
        this.db.exec(`
          BEGIN IMMEDIATE;
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
          COMMIT;
        `);
        version = 1;
      }
      if (version === 1) {
        this.db.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE notes ADD COLUMN updated_at TEXT;
          CREATE TABLE note_versions (
            id INTEGER PRIMARY KEY,
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            saved_at TEXT NOT NULL
          );
          CREATE INDEX note_versions_by_note ON note_versions(note_id);
          PRAGMA user_version = 2;
          COMMIT;
        `);
      } else if (version !== 2) {
        throw new Error("This database was created by a different version of Session Tape.");
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private active(): Session | null {
    const row = this.db.prepare(
      "SELECT id, title, started_at AS startedAt FROM sessions WHERE finished_at IS NULL"
    ).get();
    return row ? row as unknown as Session : null;
  }

  snapshot(rawQuery: unknown): Snapshot {
    const query = textField(rawQuery, "search term", 200, true);
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
    if (this.active()) throw new InputError("Finish the current session before starting another.");
    this.db.prepare("INSERT INTO sessions(id, title, started_at) VALUES (?, ?, ?)")
      .run(randomUUID(), title, new Date().toISOString());
  }

  finish(rawId: unknown): void {
    const id = uuid(rawId);
    const result = this.db.prepare(
      "UPDATE sessions SET finished_at = ? WHERE id = ? AND finished_at IS NULL"
    ).run(new Date().toISOString(), id);
    if (!result.changes) throw new InputError("That session is already closed or unavailable.");
  }

  addNote(raw: unknown): void {
    if (!raw || typeof raw !== "object") throw new InputError("Enter a note first.");
    const fields = raw as Record<string, unknown>;
    const id = uuid(fields.id);
    const sessionId = uuid(fields.sessionId);
    const body = textField(fields.body, "note", 16000);
    const existing = this.db.prepare("SELECT session_id, body FROM notes WHERE id = ?").get(id);
    if (existing) {
      if (existing.session_id === sessionId && existing.body === body) return;
      throw new InputError("This note ID already belongs to a different entry.");
    }
    const result = this.db.prepare(`
      INSERT INTO notes(id, session_id, body, created_at)
      SELECT ?, id, ?, ? FROM sessions WHERE id = ? AND finished_at IS NULL
    `).run(id, body, new Date().toISOString(), sessionId);
    if (!result.changes) throw new InputError("This session has finished. Your text is still in the editor.");
  }

  editNote(raw: unknown): void {
    if (!raw || typeof raw !== "object") throw new InputError("Enter a note first.");
    const fields = raw as Record<string, unknown>;
    const id = uuid(fields.id);
    const body = textField(fields.body, "note", 16000);
    const expectedUpdatedAt = textField(fields.expectedUpdatedAt, "note version", 40);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(
        "SELECT body, created_at, updated_at FROM notes WHERE id = ?"
      ).get(id);
      if (!existing) throw new InputError("This note is unavailable.");
      const currentVersion = existing.updated_at ?? existing.created_at;
      if (existing.body === body) {
        this.db.exec("COMMIT");
        return;
      }
      if (currentVersion !== expectedUpdatedAt) {
        throw new InputError("This note changed elsewhere. Reload it before saving your edit.");
      }

      const currentTime = Date.parse(currentVersion);
      const updatedAt = new Date(Math.max(Date.now(), currentTime + 1)).toISOString();
      this.db.prepare(
        "INSERT INTO note_versions(note_id, body, saved_at) VALUES (?, ?, ?)"
      ).run(id, existing.body, currentVersion);
      this.db.prepare(
        "UPDATE notes SET body = ?, updated_at = ? WHERE id = ?"
      ).run(body, updatedAt, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
