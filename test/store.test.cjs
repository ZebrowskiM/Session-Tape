const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { DatabaseSync, StatementSync } = require("node:sqlite");
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
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
    assert.equal(db.upgradeCopyPath, path + ".before-v1-upgrade.sqlite");
    assert.ok(existsSync(db.upgradeCopyPath));
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
    const first = db.sessionEvents({ sessionId }).events;
    assert.deepEqual(first.map(e => e.kind), ["session.started", "note.added"]);
    assert.equal(first[1].id, note.id);
    assert.equal(first[0].elapsedMs, 0);
    assert.ok(first[1].elapsedMs >= 0 && first[1].phase === "focus");
    assert.equal(first[1].utcOffsetMinutes + new Date(first[1].occurredAt).getTimezoneOffset(), 0);
    db.close();
    db = new Store(path);
    const query = { sessionId };
    assert.deepEqual(db.sessionEvents(query).events, first);
    db.addNote(note);
    db.finish(sessionId);
    const edit = { id: note.id, body: "Only the delivery dates were blank.",
      expectedUpdatedAt: db.snapshot("").notes[0].updatedAt };
    db.editNote(edit);
    db.editNote(edit);
    db.addNote(note);
    assert.throws(() => db.addNote({ ...note, body: edit.body }), /different entry/);
    const events = db.sessionEvents(query).events;
    assert.deepEqual(events.map(e => e.sequence), [1, 2, 3, 4]);
    assert.deepEqual(events.map(e => e.kind), ["session.started", "note.added", "session.finished", "note.edited"]);
    assert.equal(events[2].elapsedMs, null);
    assert.equal(events[3].phase, "finished");
    assert.equal(events[3].elapsedMs, null);
    assert.deepEqual(events[3].payload, { noteId: note.id, body: edit.body });
    assert.ok(events.every(e => e.payloadVersion === 1 && e.sequenceSource === "recorded"));
    db.close();
    db = new Store(path);
    assert.deepEqual(db.sessionEvents(query).events, events);
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
    assert.deepEqual(db.sessionEvents({ sessionId }).events.map(e => e.sequence), [1, 2, 3]);
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
    assert.equal(page.events.length, 100);
    assert.equal(page.nextSequence, 100);
    const next = db.sessionEvents({ sessionId, afterSequence: page.nextSequence });
    assert.deepEqual(next.events.map(e => e.sequence), [101, 102, 103]);
    assert.equal(next.nextSequence, null);
    const exact = db.sessionEvents({ sessionId, afterSequence: 3 });
    assert.equal(exact.events.length, 100);
    assert.equal(exact.nextSequence, null);
    assert.deepEqual(db.sessionEvents({ sessionId, afterSequence: 103 }), { events: [], nextSequence: null });
    assert.deepEqual(db.sessionEvents({ sessionId: db.snapshot("").active.id }).events.map(e => e.sequence), [1]);
    assert.throws(() => db.sessionEvents({ sessionId, afterSequence: -1 }), /sequence/);
    assert.throws(() => db.sessionEvents({ sessionId: "unknown" }), /invalid ID/);
  } finally { db.close(); }
});

function seedV2(old) {
  const sessionId = randomUUID();
  const editedId = randomUUID();
  const plainId = randomUUID();
  const start = "2024-06-03T09:00:00.000Z";
  const created = "2024-06-03T09:01:00.000Z";
  const revised = "2024-06-03T09:02:00.000Z";
  const later = "2024-06-04T11:20:00.000Z";
  // A frozen v2 profile independent of the migration being tested.
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
  return { sessionId, editedId, plainId, start, created, revised, later };
}

test("v2 migration preserves original wording, all saved revisions and unknown clock data", t => {
  const path = temporaryProfile(t);
  const old = new DatabaseSync(path);
  const { sessionId, editedId, plainId, start, created, revised, later } = seedV2(old);
  try {
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
    const events = db.sessionEvents(query).events;
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
    assert.deepEqual(db.sessionEvents(query).events, events);
    assert.deepEqual(db.snapshot(""), archive);
    db.addNote({ id: editedId, sessionId, body: "Two blank rows." });
    assert.deepEqual(db.sessionEvents(query).events, events);
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
    const events = db.sessionEvents({ sessionId }).events;
    assert.deepEqual(events.map(e => e.occurredAt), [start, start, earlier]);
    assert.deepEqual(events.map(e => e.sequence), [1, 2, 3]);
    assert.ok(events[2].elapsedMs >= events[1].elapsedMs);
  } finally { db.close(); }
});

test("a failed upgrade reports a standalone snapshot including edits committed only to the WAL", t => {
  const path = temporaryProfile(t);
  const snapshotPath = path + ".before-v2-upgrade.sqlite";
  const writer = new DatabaseSync(path);
  const { sessionId, editedId } = seedV2(writer);
  try {
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE);");
    const checkpoint = readFileSync(path);
    writer.prepare("UPDATE note_versions SET body = ? WHERE id = 1").run("Original in the WAL");
    assert.deepEqual(readFileSync(path), checkpoint);
    assert.ok(readFileSync(path + "-wal").length > 0);

    const exec = DatabaseSync.prototype.exec;
    const fault = t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
      if (sql === "PRAGMA user_version = 5") throw new Error("injected migration failure");
      return exec.call(this, sql);
    });
    assert.throws(() => new Store(path), error =>
      error.message.includes(snapshotPath) && error.message.includes("injected migration failure"));
    fault.mock.restore();
    assert.equal(writer.prepare("PRAGMA user_version").get().user_version, 2);

    const restoredPath = temporaryProfile(t);
    copyFileSync(snapshotPath, restoredPath);
    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      assert.equal(restored.prepare("PRAGMA user_version").get().user_version, 2);
      for (const table of ["sessions", "notes", "note_versions"]) {
        const sql = "SELECT rowid, * FROM " + table + " ORDER BY rowid";
        assert.deepEqual(restored.prepare(sql).all(), writer.prepare(sql).all());
      }
    } finally { restored.close(); }
    const store = new Store(restoredPath);
    try {
      const note = store.snapshot("").notes.find(n => n.id === editedId);
      assert.deepEqual(note.versions.map(v => v.body),
        ["Only the delivery dates were blank.", "Two orders flagged.", "Original in the WAL"]);
      assert.equal(store.sessionEvents({ sessionId }).events.length, 6);
    } finally { store.close(); }
  } finally { writer.close(); }
});

test("a failed snapshot check preserves the last verified file and leaves the live schema alone", t => {
  const path = temporaryProfile(t);
  const snapshotPath = path + ".before-v2-upgrade.sqlite";
  const writer = new DatabaseSync(path);
  const { editedId, later } = seedV2(writer);
  try {
    writer.prepare("UPDATE notes SET updated_at = NULL WHERE id = ?").run(editedId);
    assert.throws(() => new Store(path), /Upgrade failed/);
    const goodCopy = readFileSync(snapshotPath);
    writer.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(later, editedId);
    writer.exec("PRAGMA foreign_keys = OFF");
    writer.prepare("UPDATE note_versions SET note_id = ? WHERE id = 1").run(randomUUID());
    assert.throws(() => new Store(path), /Could not save and verify[\s\S]*broken record reference/);
    assert.equal(writer.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(writer.prepare("SELECT 1 FROM sqlite_schema WHERE name='session_events'").get(), undefined);
    assert.deepEqual(readFileSync(snapshotPath), goodCopy);
    assert.equal(existsSync(snapshotPath + ".partial"), false);
    writer.prepare("UPDATE note_versions SET note_id = ? WHERE id = 1").run(editedId);
    const retried = new Store(path);
    try { assert.equal(retried.snapshot("").notes.length, 2); } finally { retried.close(); }
    const latest = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      assert.equal(latest.prepare("SELECT updated_at FROM notes WHERE id = ?").get(editedId).updated_at, later);
    } finally { latest.close(); }
  } finally { writer.close(); }
});

test("a publication error stops the upgrade and an interrupted staging file can be retried", t => {
  const path = temporaryProfile(t);
  const destination = path + ".before-v2-upgrade.sqlite";
  const writer = new DatabaseSync(path);
  try {
    seedV2(writer);
    // A directory blocks the final rename even on systems that ignore POSIX permissions.
    mkdirSync(destination);
    assert.throws(() => new Store(path), error =>
      error.message.includes("Could not save and verify") && error.message.includes(destination) &&
      error.message.includes("upgrade stopped before changing the archive"));
    assert.equal(writer.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(existsSync(destination + ".partial"), false);
    rmSync(destination, { recursive: true });
    writeFileSync(destination + ".partial", "interrupted copy");
    const store = new Store(path);
    try { assert.equal(store.snapshot("").notes.length, 2); } finally { store.close(); }
    assert.equal(existsSync(destination + ".partial"), false);
  } finally { writer.close(); }
});

test("fresh, current and unsupported newer profiles do not produce upgrade copies", t => {
  const path = temporaryProfile(t);
  new Store(path).close();
  new Store(path).close();
  const newer = new DatabaseSync(path);
  try { newer.exec("PRAGMA user_version = 6"); } finally { newer.close(); }
  assert.throws(() => new Store(path), /different version/);
  assert.deepEqual(readdirSync(dirname(path)), ["session-tape.sqlite"]);
});

test("retry after process death between note commit and acknowledgement keeps the original event", t => {
  const path = temporaryProfile(t);
  const setup = new Store(path);
  let sessionId;
  let startEvent;
  try {
    setup.start("Review flagged rows");
    sessionId = setup.snapshot("").active.id;
    [startEvent] = setup.sessionEvents({ sessionId }).events;
  } finally { setup.close(); }
  const note = { id: randomUUID(), sessionId, body: "Keep both rows." };
  // Kill the writer before it can close the database or tell its caller the save succeeded.
  const saveWithoutReply = `
    const { Store } = require("../dist/store.js");
    const [path, note] = process.argv.slice(1);
    const db = new Store(path);
    db.addNote(JSON.parse(note));
    process.kill(process.pid, "SIGKILL");
  `;
  const crash = spawnSync(process.execPath, ["-e", saveWithoutReply, path, JSON.stringify(note)], {
    cwd: __dirname, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.ifError(crash.error);
  // Windows reports a forced exit as a status instead of a POSIX signal.
  if (process.platform === "win32") assert.notEqual(crash.status, 0);
  else assert.equal(crash.signal, "SIGKILL", crash.stderr);

  const reopened = new Store(path);
  try {
    const archive = reopened.snapshot("");
    const events = reopened.sessionEvents({ sessionId }).events;
    assert.equal(archive.active.id, sessionId);
    assert.deepEqual(archive.notes.map(n => [n.id, n.body]), [[note.id, note.body]]);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], startEvent);
    assert.equal(events[1].sequence, 2);
    assert.equal(events[1].kind, "note.added");
    assert.equal(events[1].id, note.id);
    reopened.addNote(note);
    assert.deepEqual(reopened.snapshot(""), archive);
    assert.deepEqual(reopened.sessionEvents({ sessionId }).events, events);
  } finally { reopened.close(); }
});

test("a snapshot stays consistent when another connection edits and finishes during the read", t => {
  const path = temporaryProfile(t);
  const reader = new Store(path);
  const writer = new Store(path);
  try {
    writer.start("Review");
    const sessionId = writer.snapshot("").active.id;
    const id = randomUUID();
    writer.addNote({ id, sessionId, body: "Two rows were flagged." });
    const before = reader.snapshot("");

    // Commit between the snapshot's first result set and its remaining reads.
    const all = StatementSync.prototype.all;
    let committed = false;
    const interleave = t.mock.method(StatementSync.prototype, "all", function (...args) {
      const rows = all.apply(this, args);
      if (!committed) {
        committed = true;
        writer.editNote({ id, body: "Only dates were blank.", expectedUpdatedAt: before.notes[0].updatedAt });
        writer.finish(sessionId);
      }
      return rows;
    });
    try { assert.deepEqual(reader.snapshot(""), before); }
    finally { interleave.mock.restore(); }
    assert.ok(committed);

    const after = reader.snapshot("");
    assert.equal(after.active, null);
    assert.deepEqual(after.notes[0].versions.map(v => v.body), ["Only dates were blank.", "Two rows were flagged."]);
    assert.deepEqual(after, writer.snapshot(""));
    assert.deepEqual(reader.sessionEvents({ sessionId }).events.map(e => [e.sequence, e.kind]), [
      [1, "session.started"], [2, "note.added"], [3, "note.edited"], [4, "session.finished"],
    ]);
  } finally { writer.close(); reader.close(); }
});

test("a failed start releases the live session slot and a stale finish leaves the next session open", t => {
  const path = temporaryProfile(t);
  const first = new Store(path);
  const second = new Store(path);
  const observer = new DatabaseSync(path);
  try {
    observer.exec(`CREATE TRIGGER reject_start BEFORE INSERT ON session_events
      WHEN NEW.kind = 'session.started' BEGIN SELECT RAISE(ABORT, 'start event rejected'); END;`);
    assert.throws(() => first.start("Aborted"), /start event rejected/);
    assert.equal(second.snapshot("").active, null);
    assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
    assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM session_events").get().count, 0);
    observer.exec("DROP TRIGGER reject_start");

    second.start("First session");
    const firstId = first.snapshot("").active.id;
    assert.throws(() => first.start("Competing start"), /Finish the current session/);
    first.finish(firstId);
    first.start("Next session");
    const nextId = first.snapshot("").active.id;
    assert.throws(() => second.finish(firstId), /already closed/);
    assert.equal(second.snapshot("").active.id, nextId);
    assert.deepEqual(second.sessionEvents({ sessionId: firstId }).events.map(e => [e.sequence, e.kind]), [
      [1, "session.started"], [2, "session.finished"],
    ]);
    assert.deepEqual(second.sessionEvents({ sessionId: nextId }).events.map(e => [e.sequence, e.kind]), [
      [1, "session.started"],
    ]);
  } finally { observer.close(); second.close(); first.close(); }
});

test("a migrated active session accepts live notes without inventing a clock origin", t => {
  const path = temporaryProfile(t);
  const legacy = new DatabaseSync(path);
  const openId = randomUUID();
  const oldNoteId = randomUUID();
  const startedAt = "2024-06-05T12:00:00.000Z";
  let closedId;
  try {
    closedId = seedV2(legacy).sessionId;
    legacy.prepare("INSERT INTO sessions(id, title, started_at) VALUES (?, ?, ?)").run(openId, "Unfinished", startedAt);
    legacy.prepare("INSERT INTO notes(id, session_id, body, created_at) VALUES (?, ?, ?, ?)")
      .run(oldNoteId, openId, "Original entry.", startedAt);
  } finally { legacy.close(); }

  const db = new Store(path);
  try {
    assert.equal(db.snapshot("").active.id, openId);
    const closed = db.sessionEvents({ sessionId: closedId }).events;
    const history = db.sessionEvents({ sessionId: openId }).events;
    assert.deepEqual(history.map(e => [e.sequence, e.kind, e.occurredAt]), [
      [1, "session.started", startedAt], [2, "note.added", startedAt],
    ]);
    assert.equal(history[1].id, oldNoteId);
    assert.ok(history.every(e => e.sequenceSource === "reconstructed" && e.utcOffsetMinutes === null &&
      e.elapsedMs === null && e.phase === null));

    const id = randomUUID();
    db.addNote({ id, sessionId: openId, body: "Follow-up entry." });
    db.finish(openId);
    const events = db.sessionEvents({ sessionId: openId }).events;
    assert.deepEqual(events.slice(0, 2), history);
    assert.deepEqual(events.slice(2).map(e => [e.sequence, e.kind, e.sequenceSource, e.elapsedMs, e.phase]), [
      [3, "note.added", "recorded", null, null], [4, "session.finished", "recorded", null, "finished"],
    ]);
    assert.equal(events[2].id, id);
    assert.equal(events[2].utcOffsetMinutes + new Date(events[2].occurredAt).getTimezoneOffset(), 0);
    assert.deepEqual(db.sessionEvents({ sessionId: closedId }).events, closed);
  } finally { db.close(); }
});

test("legacy replay preserves note creation and revision order across backward timestamps", t => {
  const path = temporaryProfile(t);
  const old = new DatabaseSync(path);
  const { sessionId, editedId, created } = seedV2(old);
  const early = "2024-06-03T08:15:00.000Z";
  const earlier = "2024-06-03T08:00:00.000Z";
  try {
    old.prepare("UPDATE note_versions SET saved_at = ? WHERE id = 2").run(early);
    old.prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(earlier, editedId);
  } finally { old.close(); }

  const db = new Store(path);
  try {
    const history = db.sessionEvents({ sessionId }).events.filter(e => e.payload.noteId === editedId);
    assert.deepEqual(history.map(e => [e.kind, e.occurredAt, e.payload.body]), [
      ["note.added", created, "Two blank rows."],
      ["note.edited", early, "Two orders flagged."],
      ["note.edited", earlier, "Only the delivery dates were blank."],
    ]);
  } finally { db.close(); }
});

test("v3 repair changes only reconstructed order and enforces the event vocabulary", t => {
  const path = temporaryProfile(t);
  const previous = new DatabaseSync(path);
  const { sessionId, editedId, plainId, start, created, revised, later } = seedV2(previous);
  const edit1 = editedId + ":edit:1";
  const edit2 = editedId + ":edit:2";
  const startId = sessionId + ":start";
  const finishId = sessionId + ":finish";
  const recordedId = plainId + ":edit:3";
  const readRows = "SELECT * FROM session_events ORDER BY sequence";
  let original;
  try {
    // The v3 preview had no CHECK on kind or phase. Its timestamp sort could
    // put the latest edit first and leave a subsequently recorded suffix.
    previous.exec(`
      CREATE TABLE session_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        sequence INTEGER NOT NULL, sequence_source TEXT NOT NULL, occurred_at TEXT NOT NULL,
        utc_offset_minutes INTEGER, elapsed_ms INTEGER, phase TEXT, kind TEXT NOT NULL,
        payload_version INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(session_id, sequence)) STRICT;
      PRAGMA user_version = 3;`);
    const insert = previous.prepare(`INSERT INTO session_events VALUES (?, ?, ?, 'reconstructed', ?,
      NULL, NULL, NULL, ?, 1, ?)`);
    const rows = [
      [startId, start, "session.started", { title: "CSV" }],
      [edit2, start, "note.edited", { noteId: editedId, body: "Only the delivery dates were blank." }],
      [editedId, created, "note.added", { noteId: editedId, body: "Two blank rows." }],
      [plainId, created, "note.added", { noteId: plainId, body: "Keep both orders." }],
      [finishId, revised, "session.finished", {}],
      [edit1, later, "note.edited", { noteId: editedId, body: "Two orders flagged." }],
    ];
    for (const [i, [id, at, kind, payload]] of rows.entries()) {
      insert.run(id, sessionId, i + 1, at, kind, JSON.stringify(payload));
    }
    previous.prepare(`INSERT INTO session_events VALUES (?, ?, 7, 'recorded', ?, -240,
      NULL, 'finished', 'note.edited', 1, ?)`).run(recordedId, sessionId, later,
      JSON.stringify({ noteId: plainId, body: "Reviewed." }));
    original = previous.prepare(readRows).all();
    previous.prepare("UPDATE session_events SET kind='typo' WHERE id=?").run(recordedId);
    assert.throws(() => new Store(path), /Upgrade failed[\s\S]*CHECK constraint failed/);
    assert.equal(previous.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(previous.prepare("SELECT kind FROM session_events WHERE id=?").get(recordedId).kind, "typo");
    previous.prepare("UPDATE session_events SET kind='note.edited' WHERE id=?").run(recordedId);
  } finally { previous.close(); }

  const db = new Store(path);
  try {
    assert.equal(db.upgradeCopyPath, path + ".before-v3-upgrade.sqlite");
    const raw = new DatabaseSync(path);
    try {
      const fixed = raw.prepare(readRows).all();
      assert.deepEqual(fixed.map(e => e.id), [startId, editedId, plainId, finishId, edit1, edit2, recordedId]);
      for (const [i, row] of fixed.entries()) {
        const old = original.find(e => e.id === row.id);
        assert.deepEqual({ ...row }, { ...old, sequence: i + 1 });
      }
      assert.deepEqual(fixed.at(-1), original.at(-1));
      assert.throws(() => raw.exec("UPDATE session_events SET phase='unexpected'"), /CHECK constraint failed/);
      assert.throws(() => raw.exec("UPDATE session_events SET kind='unexpected'"), /CHECK constraint failed/);
      assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 5);
    } finally { raw.close(); }
  } finally { db.close(); }
  const reopened = new Store(path);
  try {
    assert.equal(reopened.upgradeCopyPath, null);
    assert.ok(existsSync(path + ".before-v3-upgrade.sqlite"));
  } finally { reopened.close(); }
});

test("a later original cannot push finish past a known post-finish edit or its revisions", t => {
  const path = temporaryProfile(t);
  const old = new DatabaseSync(path);
  const { sessionId, editedId, plainId, start, later } = seedV2(old);
  try {
    old.prepare("UPDATE notes SET created_at=? WHERE id=?").run("2024-06-05T00:00:00.000Z", plainId);
    old.prepare("INSERT INTO note_versions(note_id, body, saved_at) VALUES (?, ?, ?)")
      .run(editedId, "After finish.", later);
    old.prepare("UPDATE notes SET updated_at=? WHERE id=?").run(start, editedId);
  } finally { old.close(); }
  const db = new Store(path);
  try {
    const events = db.sessionEvents({ sessionId }).events;
    const finish = events.findIndex(e => e.kind === "session.finished");
    const original = events.findIndex(e => e.id === plainId);
    assert.ok(original >= 0 && original < finish);
    assert.deepEqual(events.slice(finish + 1).map(e => [e.kind, e.occurredAt, e.payload.body]), [
      ["note.edited", later, "After finish."], ["note.edited", start, "Only the delivery dates were blank."],
    ]);
  } finally { db.close(); }
});

test("pause and resume track separate totals and tag notes in the shared active phase", t => {
  const path = temporaryProfile(t);
  let now = 100;
  const db = new Store(path, () => now);
  const reader = new Store(path);
  try {
    db.start("CSV handoff");
    const session = db.snapshot("").active;
    const sessionId = session.id;
    assert.equal(session.phase, "focus");
    const command = { sessionId, phase: "paused", expectedSequence: session.phaseSequence };
    now += 1200;
    db.changePhase(command);
    const paused = reader.snapshot("").active;
    assert.deepEqual(paused, db.snapshot("").active);
    assert.deepEqual([paused.phase, paused.focusMs, paused.pausedMs], ["paused", 1200, 0]);
    const note = { id: randomUUID(), sessionId, body: "Checked while paused." };
    now += 400;
    db.addNote(note);
    const saved = reader.snapshot("").notes[0];
    db.editNote({ id: note.id, body: "Corrected while paused.", expectedUpdatedAt: saved.updatedAt });
    db.changePhase(command); // Lost acknowledgement for Pause.
    now += 300;
    db.changePhase({ sessionId, phase: "focus", expectedSequence: paused.phaseSequence });
    const resumed = reader.snapshot("").active;
    assert.deepEqual([resumed.phase, resumed.focusMs, resumed.pausedMs], ["focus", 1200, 700]);
    assert.throws(() => db.changePhase(command), /phase changed/);
    now += 500;
    db.finish(sessionId);
    const events = reader.sessionEvents({ sessionId }).events;
    assert.deepEqual(events.map(e => [e.kind, e.phase, e.elapsedMs]), [
      ["session.started", "focus", 0], ["session.paused", "paused", 1200],
      ["note.added", "paused", 1600], ["note.edited", "paused", 1600],
      ["session.resumed", "focus", 1900], ["session.finished", "finished", 2400],
    ]);
    assert.deepEqual(events.at(-1).payload, { focusMs: 1700, pausedMs: 700 });
    assert.throws(() => db.changePhase(command), /already closed/);
  } finally { reader.close(); db.close(); }
});

test("a rejected phase change keeps the clock anchor and skips no sequence", t => {
  const path = temporaryProfile(t);
  let now = 0;
  const db = new Store(path, () => now);
  const raw = new DatabaseSync(path);
  try {
    db.start("Atomic pause");
    const { id, phaseSequence } = db.snapshot("").active;
    const pause = { sessionId: id, expectedSequence: phaseSequence, phase: "paused" };
    now = 500;
    raw.exec(`CREATE TRIGGER reject_pause BEFORE INSERT ON session_events WHEN NEW.kind='session.paused'
      BEGIN SELECT RAISE(ABORT, 'pause failed'); END;`);
    assert.throws(() => db.changePhase(pause), /pause failed/);
    assert.equal(db.snapshot("").active.phase, "focus");
    raw.exec("DROP TRIGGER reject_pause");
    now = 900;
    db.changePhase(pause);
    now = 1400;
    db.finish(id);
    const { events } = db.sessionEvents({ sessionId: id });
    assert.deepEqual(events.map(e => e.sequence), [1, 2, 3]);
    assert.deepEqual(events.at(-1).payload, { focusMs: 900, pausedMs: 500 });
  } finally { raw.close(); db.close(); }
});

test("reopening preserves paused notes and excludes downtime from measured totals", t => {
  const path = temporaryProfile(t);
  let now = 0;
  let db = new Store(path, () => now);
  try {
    db.start("Restart");
    const { id, phaseSequence } = db.snapshot("").active;
    now = 800;
    db.changePhase({ sessionId: id, phase: "paused", expectedSequence: phaseSequence });
    db.close();
    now = 90000;
    db = new Store(path, () => now);
    const paused = db.snapshot("").active;
    assert.equal(paused.phase, "paused");
    db.addNote({ id: randomUUID(), sessionId: id, body: "Still paused." });
    now += 200;
    db.changePhase({ sessionId: id, phase: "focus", expectedSequence: paused.phaseSequence });
    const { events } = db.sessionEvents({ sessionId: id });
    assert.equal(events.at(-2).phase, "paused");
    assert.equal(events.at(-1).elapsedMs, null);
    assert.deepEqual(events.at(-1).payload, { focusMs: 800, pausedMs: 200 });
  } finally { db.close(); }
});
