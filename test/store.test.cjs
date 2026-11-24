const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
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
