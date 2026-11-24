import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Note, Session, Snapshot } from "./contracts";

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
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
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
      } else if (version !== 1) {
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
      SELECT n.id, n.session_id AS sessionId, s.title AS sessionTitle, n.body, n.created_at AS createdAt
      FROM notes n JOIN sessions s ON s.id = n.session_id
      WHERE instr(lower(n.body), lower(?)) > 0 OR instr(lower(s.title), lower(?)) > 0
      ORDER BY n.rowid DESC LIMIT 100
    `).all(query, query);
    return { active: this.active(), notes: rows as unknown as Note[] };
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

  close(): void {
    this.db.close();
  }
}
