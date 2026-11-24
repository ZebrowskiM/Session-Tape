const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Store } = require("../dist/store.js");

function temporaryProfile(t) {
  const dir = mkdtempSync(join(tmpdir(), "session-tape-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "session-tape.sqlite");
}

test("active session and committed note survive reopening and are searchable", t => {
  const path = temporaryProfile(t);
  let db = new Store(path);
  db.start("CSV import");
  const sessionId = db.snapshot("").active.id;
  const note = { id: randomUUID(), sessionId, body: "Only the dates were blank." };
  db.addNote(note);
  db.close();
  db = new Store(path);
  try {
    assert.equal(db.snapshot("").active.id, sessionId);
    assert.equal(db.snapshot("blank").notes[0].id, note.id);
    assert.equal(db.snapshot("CSV").notes[0].body, note.body);
    db.finish(sessionId);
    assert.equal(db.snapshot("").active, null);
    assert.equal(db.snapshot("").notes.length, 1);
  } finally { db.close(); }
});

test("retry is idempotent and an old panel cannot add to a finished session", t => {
  const db = new Store(temporaryProfile(t));
  try {
    db.start("First");
    assert.throws(() => db.start("Other"), /Finish the current session/);
    const note = { id: randomUUID(), sessionId: db.snapshot("").active.id, body: "Look at 50%." };
    db.addNote(note);
    db.finish(note.sessionId);
    db.start("Second");
    db.addNote(note);
    assert.equal(db.snapshot("%").notes.length, 1);
    assert.equal(db.snapshot("_").notes.length, 0);
    assert.throws(() => db.addNote({ ...note, body: "Different" }), /different entry/);
    assert.throws(() => db.addNote({ ...note, id: randomUUID() }), /session has finished/);
    assert.equal(db.snapshot("").notes.length, 1);
  } finally { db.close(); }
});

test("reject empty titles, empty notes and malformed requests", t => {
  const db = new Store(temporaryProfile(t));
  try {
    assert.throws(() => db.start(" "), /session title/);
    db.start("Notes");
    assert.throws(() => db.addNote(null), /Enter a note/);
    assert.throws(() => db.addNote({ id: randomUUID(), sessionId: db.snapshot("").active.id, body: " " }), /valid note/);
    assert.throws(() => db.snapshot({}), /search term/);
    assert.deepEqual(db.snapshot("").notes, []);
  } finally { db.close(); }
});

test("editing a saved note preserves timestamped versions and rejects stale edits", t => {
  const db = new Store(temporaryProfile(t));
  try {
    db.start("Research");
    const note = { id: randomUUID(), sessionId: db.snapshot("").active.id, body: "First version" };
    db.addNote(note);
    const original = db.snapshot("").notes[0];
    db.editNote({ id: note.id, body: "Second version", expectedUpdatedAt: original.updatedAt });
    const edited = db.snapshot("").notes[0];
    assert.equal(edited.body, "Second version");
    assert.notEqual(edited.updatedAt, original.updatedAt);
    assert.deepEqual(edited.versions, [
      { body: "Second version", savedAt: edited.updatedAt },
      { body: "First version", savedAt: original.createdAt },
    ]);

    db.finish(note.sessionId);
    db.editNote({ id: note.id, body: "Third version", expectedUpdatedAt: edited.updatedAt });
    const latest = db.snapshot("").notes[0];
    assert.deepEqual(latest.versions.map(version => version.body), [
      "Third version", "Second version", "First version",
    ]);
    assert.throws(
      () => db.editNote({ id: note.id, body: "Stale edit", expectedUpdatedAt: original.updatedAt }),
      /changed elsewhere/
    );
    db.editNote({ id: note.id, body: "Third version", expectedUpdatedAt: original.updatedAt });
    assert.equal(db.snapshot("").notes[0].body, "Third version");
  } finally { db.close(); }
});

test("upgrades existing version 1 databases without losing notes", t => {
  const path = temporaryProfile(t);
  const sessionId = randomUUID();
  const noteId = randomUUID();
  const oldDb = new DatabaseSync(path);
  oldDb.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE UNIQUE INDEX only_one_active ON sessions ((1)) WHERE finished_at IS NULL;
    CREATE TABLE notes (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX notes_by_session ON notes(session_id);
    PRAGMA user_version = 1;
  `);
  oldDb.prepare("INSERT INTO sessions(id, title, started_at) VALUES (?, ?, ?)").run(
    sessionId, "Existing session", "2024-01-01T00:00:00.000Z"
  );
  oldDb.prepare("INSERT INTO notes(id, session_id, body, created_at) VALUES (?, ?, ?, ?)").run(
    noteId, sessionId, "Existing note", "2024-01-01T01:00:00.000Z"
  );
  oldDb.close();

  const db = new Store(path);
  try {
    const note = db.snapshot("").notes[0];
    assert.equal(note.id, noteId);
    assert.equal(note.body, "Existing note");
    assert.equal(note.updatedAt, note.createdAt);
    assert.deepEqual(note.versions, [
      { body: "Existing note", savedAt: note.createdAt },
    ]);
    db.editNote({ id: noteId, body: "Edited note", expectedUpdatedAt: note.updatedAt });
    assert.deepEqual(db.snapshot("").notes[0].versions.map(version => version.body), [
      "Edited note", "Existing note",
    ]);
  } finally { db.close(); }
});
