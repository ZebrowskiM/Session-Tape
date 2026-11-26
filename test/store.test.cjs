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

test("a failed second migration rolls back the entire upgrade and can be retried", t => {
  const path = temporaryProfile(t);
  const seed = new DatabaseSync(path);
  try {
    // An existing table forces SQLite to reject the second migration after the first one ran.
    seed.exec("CREATE TABLE note_versions (marker TEXT); INSERT INTO note_versions VALUES ('kept');");
  } finally { seed.close(); }

  assert.throws(() => new Store(path), /note_versions already exists/);
  const reopened = new DatabaseSync(path);
  try {
    assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 0);
    assert.deepEqual(reopened.prepare("SELECT name FROM sqlite_schema").all().map(row => row.name),
      ["note_versions"]);
    assert.equal(reopened.prepare("SELECT marker FROM note_versions").get().marker, "kept");
    reopened.exec("DROP TABLE note_versions");
  } finally { reopened.close(); }

  const store = new Store(path);
  try {
    store.start("Retry after rollback");
    assert.equal(store.snapshot("").active.title, "Retry after rollback");
  } finally { store.close(); }
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

test("live event order and original IDs survive reopen, edits after finish and save retries", t => {
  const path = temporaryProfile(t);
  let db = new Store(path);
  try {
    db.start("CSV handoff");
    const sessionId = db.snapshot("").active.id;
    const note = { id: randomUUID(), sessionId, body: "Keep both orders." };
    db.addNote(note);
    const first = db.sessionEvents({ sessionId });
    assert.deepEqual(first.map(e => e.kind), ["session.started", "note.added"]);
    assert.equal(first[1].id, note.id);
    assert.equal(first[0].elapsedMs, 0);
    assert.ok(first[1].elapsedMs >= 0 && first[1].phase === "focus");
    assert.equal(first[1].utcOffsetMinutes + new Date(first[1].occurredAt).getTimezoneOffset(), 0);
    db.close();
    db = new Store(path);
    const query = { sessionId };
    assert.deepEqual(db.sessionEvents(query), first);
    db.addNote(note);
    db.finish(sessionId);
    const edit = { id: note.id, body: "Only the delivery dates were blank.",
      expectedUpdatedAt: db.snapshot("").notes[0].updatedAt };
    db.editNote(edit);
    db.editNote(edit);
    db.addNote(note);
    assert.throws(() => db.addNote({ ...note, body: edit.body }), /different entry/);
    const events = db.sessionEvents(query);
    assert.deepEqual(events.map(e => e.sequence), [1, 2, 3, 4]);
    assert.deepEqual(events.map(e => e.kind), ["session.started", "note.added", "session.finished", "note.edited"]);
    assert.equal(events[2].elapsedMs, null);
    assert.equal(events[3].phase, "finished");
    assert.equal(events[3].elapsedMs, null);
    assert.deepEqual(events[3].payload, { noteId: note.id, body: edit.body });
    assert.ok(events.every(e => e.payloadVersion === 1 && e.sequenceSource === "recorded"));
    db.close();
    db = new Store(path);
    assert.deepEqual(db.sessionEvents(query), events);
  } finally { db.close(); }
});

test("a rejected event rolls back the note, its version history and the sequence", t => {
  const path = temporaryProfile(t);
  const db = new Store(path);
  const connection = new DatabaseSync(path);
  try {
    db.start("Atomic writes");
    const sessionId = db.snapshot("").active.id;
    const note = { id: randomUUID(), sessionId, body: "Original" };
    connection.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON session_events
      BEGIN SELECT RAISE(ABORT, 'event write failed'); END;`);
    assert.throws(() => db.addNote(note), /event write failed/);
    assert.deepEqual(db.snapshot("").notes, []);
    connection.exec("DROP TRIGGER fail_event");
    db.addNote(note);
    const original = db.snapshot("").notes[0];
    connection.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON session_events
      BEGIN SELECT RAISE(ABORT, 'event write failed'); END;`);
    const edit = { id: note.id, body: "Corrected", expectedUpdatedAt: original.updatedAt };
    assert.throws(() => db.editNote(edit), /event write failed/);
    assert.throws(() => db.finish(sessionId), /event write failed/);
    assert.equal(db.snapshot("").active.id, sessionId);
    assert.deepEqual(db.snapshot("").notes[0], original);
    connection.exec("DROP TRIGGER fail_event");
    db.editNote(edit);
    assert.deepEqual(db.sessionEvents({ sessionId }).map(e => e.sequence), [1, 2, 3]);
  } finally { connection.close(); db.close(); }
});

test("event pages use a per-session sequence and include events past the archive cap", t => {
  const db = new Store(temporaryProfile(t));
  try {
    db.start("First session");
    const sessionId = db.snapshot("").active.id;
    for (let i = 0; i < 101; i++) db.addNote({ id: randomUUID(), sessionId, body: "Decision " + i });
    db.finish(sessionId);
    db.start("Second session");
    const page = db.sessionEvents({ sessionId });
    assert.equal(page.length, 100);
    const next = db.sessionEvents({ sessionId, afterSequence: page.at(-1).sequence });
    assert.deepEqual(next.map(e => e.sequence), [101, 102, 103]);
    assert.deepEqual(db.sessionEvents({ sessionId, afterSequence: 103 }), []);
    assert.deepEqual(db.sessionEvents({ sessionId: db.snapshot("").active.id }).map(e => e.sequence), [1]);
    assert.throws(() => db.sessionEvents({ sessionId, afterSequence: -1 }), /sequence/);
    assert.throws(() => db.sessionEvents({ sessionId: "unknown" }), /invalid ID/);
  } finally { db.close(); }
});

test("v2 migration preserves original wording, all saved revisions and unknown clock data", t => {
  const path = temporaryProfile(t);
  const sessionId = randomUUID();
  const editedId = randomUUID();
  const plainId = randomUUID();
  const start = "2024-06-03T09:00:00.000Z";
  const created = "2024-06-03T09:01:00.000Z";
  const revised = "2024-06-03T09:02:00.000Z";
  const later = "2024-06-04T11:20:00.000Z";
  const old = new DatabaseSync(path);
  // A frozen v2 profile independent of the migration being tested.
  try {
    old.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
      CREATE UNIQUE INDEX only_one_active ON sessions ((1)) WHERE finished_at IS NULL;
      CREATE TABLE notes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT);
      CREATE INDEX notes_by_session ON notes(session_id);
      CREATE TABLE note_versions (id INTEGER PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id),
        body TEXT NOT NULL, saved_at TEXT NOT NULL);
      CREATE INDEX note_versions_by_note ON note_versions(note_id);
      PRAGMA user_version = 2;
    `);
    old.prepare("INSERT INTO sessions VALUES (?, 'CSV', ?, ?)").run(sessionId, start, revised);
    const insert = old.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?)");
    insert.run(editedId, sessionId, "Only the delivery dates were blank.", created, later);
    insert.run(plainId, sessionId, "Keep both orders.", created, null);
    const version = old.prepare("INSERT INTO note_versions(note_id,body,saved_at) VALUES (?,?,?)");
    version.run(editedId, "Two blank rows.", created);
    version.run(editedId, "Two orders flagged.", revised);
    // Simulate a damaged archive missing the timestamp of its latest edit.
    old.prepare("UPDATE notes SET updated_at = NULL WHERE id = ?").run(editedId);
    assert.throws(() => new Store(path), /NOT NULL constraint failed/);
    assert.equal(old.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(old.prepare("SELECT count(*) AS n FROM note_versions").get().n, 2);
    assert.equal(old.prepare("SELECT 1 FROM sqlite_schema WHERE name='session_events'").get(), undefined);
    old.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(later, editedId);
  } finally { old.close(); }

  let db = new Store(path);
  try {
    const query = { sessionId };
    const events = db.sessionEvents(query);
    assert.deepEqual(events.map(e => [e.kind, e.occurredAt, e.payload.body ?? e.payload.title]), [
      ["session.started", start, "CSV"],
      ["note.added", created, "Two blank rows."],
      ["note.added", created, "Keep both orders."],
      ["note.edited", revised, "Two orders flagged."],
      ["session.finished", revised, undefined],
      ["note.edited", later, "Only the delivery dates were blank."],
    ]);
    assert.deepEqual(events.map(e => e.sequence), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(events.filter(e => e.kind === "note.added").map(e => e.id), [editedId, plainId]);
    assert.ok(events.filter(e => e.kind === "note.edited").every(e => e.payload.noteId === editedId));
    assert.ok(events.every(e => e.sequenceSource === "reconstructed"));
    assert.ok(events.every(e => e.elapsedMs === null && e.utcOffsetMinutes === null && e.phase === null));
    assert.equal(new Set(events.map(e => e.id)).size, events.length);
    const archive = db.snapshot("");
    assert.deepEqual(archive.notes.find(n => n.id === editedId).versions.map(v => v.body),
      ["Only the delivery dates were blank.", "Two orders flagged.", "Two blank rows."]);
    db.close();
    db = new Store(path);
    assert.deepEqual(db.sessionEvents(query), events);
    assert.deepEqual(db.snapshot(""), archive);
    db.addNote({ id: editedId, sessionId, body: "Two blank rows." });
    assert.deepEqual(db.sessionEvents(query), events);
  } finally { db.close(); }
});

test("live sequence follows commit order through a wall-clock rollback", t => {
  const start = "2026-02-02T10:30:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(start) });
  const db = new Store(temporaryProfile(t));
  try {
    db.start("Clock change");
    const sessionId = db.snapshot("").active.id;
    const id = randomUUID();
    db.addNote({ id, sessionId, body: "First" });
    const earlier = "2026-02-02T09:00:00.000Z";
    t.mock.timers.setTime(Date.parse(earlier));
    db.editNote({ id, body: "Second", expectedUpdatedAt: start });
    const events = db.sessionEvents({ sessionId });
    assert.deepEqual(events.map(e => e.occurredAt), [start, start, earlier]);
    assert.deepEqual(events.map(e => e.sequence), [1, 2, 3]);
    assert.ok(events[2].elapsedMs >= events[1].elapsedMs);
  } finally { db.close(); }
});
