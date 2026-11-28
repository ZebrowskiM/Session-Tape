const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Store } = require("../dist/store.js");

const epoch = Date.UTC(2026, 0, 1);

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "session-tape-break-"));
  const path = join(dir, "archive.sqlite");
  let mono = 0;
  t.mock.timers.enable({ apis: ["Date"], now: epoch });
  const clock = () => mono;
  let db = new Store(path, clock);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.start("CSV review");
  const sessionId = db.snapshot("").active.id;
  const target = () => ({ sessionId, expectedSequence: db.snapshot("").active.phaseSequence });
  return {
    get db() { return db; }, path, sessionId, target,
    events: () => db.sessionEvents({ sessionId }).events,
    start: (minutes = 1) => db.startBreak({ ...target(), minutes }),
    setTime(time, wall = time) { mono = time; t.mock.timers.setTime(epoch + wall); },
    reopen() { db.close(); db = new Store(path, clock); },
  };
}

test("presets and custom durations validate against the active focus phase", t => {
  const s = setup(t);
  for (const minutes of [0, -5, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, "5"]) {
    assert.throws(() => s.start(minutes), /minutes|duration/);
  }
  for (const minutes of [5, 10, 15, 7]) {
    const start = s.target();
    s.db.startBreak({ ...start, minutes });
    assert.equal(s.db.snapshot("").breakRemainingMs, minutes * 60000);
    assert.throws(() => s.db.startBreak({ ...start, minutes }), /phase changed/);
    assert.throws(() => s.start(), /Resume focus/);
    const end = { ...s.target(), phase: "focus" };
    s.db.changePhase(end);
    s.db.changePhase(end);
    assert.equal(s.db.expireBreak(), false);
  }
  s.db.changePhase({ ...s.target(), phase: "paused" });
  assert.throws(() => s.start(5), /Resume focus/);
  assert.deepEqual(s.events().filter(e => e.kind === "break.ended").map(e => e.payload.reason), Array(4).fill("early"));
});

for (const first of ["timer", "end early", "finish", "add note", "edit note"]) {
  test(`delayed expiry racing ${first} records one effective boundary`, t => {
    const s = setup(t);
    s.setTime(1000);
    s.start();
    const early = { ...s.target(), phase: "focus" };
    const note = { id: randomUUID(), sessionId: s.sessionId, body: "Flagged for review." };
    s.setTime(3000);
    s.db.addNote(note);
    const version = s.db.snapshot("").notes[0].updatedAt;
    s.db.editNote({ id: note.id, body: "Both flagged.", expectedUpdatedAt: version });
    s.setTime(64000);
    if (first === "timer") assert.equal(s.db.expireBreak(), true);
    if (first === "end early") s.db.changePhase(early);
    if (first === "finish") s.db.finish(s.sessionId);
    if (first === "add note") s.db.addNote({ ...note, id: randomUUID() });
    if (first === "edit note") s.db.editNote({ id: note.id, body: "Checked.", expectedUpdatedAt: s.db.snapshot("").notes[0].updatedAt });
    assert.equal(s.db.expireBreak(), false);
    if (first !== "finish") {
      s.db.changePhase(early);
      s.db.finish(s.sessionId);
    }
    const events = s.events();
    assert.deepEqual(events.filter(e => e.kind === "break.ended").map(e => [e.phase, e.elapsedMs, e.payload]), [
      ["focus", 61000, { focusMs: 1000, pausedMs: 0, breakMs: 60000, startSequence: 2, reason: "expired",
        effectiveAt: new Date(epoch + 61000).toISOString(), processedAt: new Date(epoch + 64000).toISOString() }],
    ]);
    assert.deepEqual(events.filter(e => e.kind.startsWith("note.")).map(e => e.phase),
      first.endsWith("note") ? ["break", "break", "focus"] : ["break", "break"]);
    assert.deepEqual(events.at(-1).payload, { focusMs: 4000, pausedMs: 0, breakMs: 60000 });
  });
}

test("early end and Finish use measured time across a backward wall clock jump", t => {
  const s = setup(t);
  s.start();
  const firstEnd = { ...s.target(), phase: "focus" };
  s.setTime(16000, -3600000);
  assert.equal(s.db.breakRemainingMs(), 44000);
  s.db.changePhase(firstEnd);
  s.setTime(17000, -3599000);
  s.start();
  assert.throws(() => s.db.changePhase(firstEnd), /phase changed/);
  s.setTime(27000, -3589000);
  s.db.finish(s.sessionId);
  assert.equal(s.db.expireBreak(), false);
  const ends = s.events().filter(e => e.kind === "break.ended");
  assert.deepEqual(ends.map(e => [e.phase, e.payload.reason, e.payload.breakMs]), [
    ["focus", "early", 16000], ["finished", "finish", 26000],
  ]);
  assert.ok(ends.every(e => e.payload.effectiveAt === e.occurredAt && e.payload.processedAt === e.occurredAt));
  assert.deepEqual(s.events().at(-1).payload, { focusMs: 1000, pausedMs: 0, breakMs: 26000 });
});

test("failed Finish rolls back the break end and restores its live countdown", t => {
  const s = setup(t);
  s.start();
  s.setTime(10000);
  const raw = new DatabaseSync(s.path);
  try {
    raw.exec(`CREATE TRIGGER reject_finish BEFORE INSERT ON session_events WHEN NEW.kind='session.finished'
      BEGIN SELECT RAISE(ABORT, 'finish failed'); END;`);
    assert.throws(() => s.db.finish(s.sessionId), /finish failed/);
    assert.deepEqual(s.events().map(e => e.kind), ["session.started", "break.started"]);
    assert.equal(s.db.breakRemainingMs(), 50000);
    raw.exec("DROP TRIGGER reject_finish");
    s.setTime(15000);
    s.db.finish(s.sessionId);
    assert.equal(s.events().at(-1).payload.breakMs, 15000);
  } finally { raw.close(); }
});

test("reopening before a deadline restores the countdown and measures only observed time", t => {
  const s = setup(t);
  s.start();
  s.setTime(20000);
  s.reopen();
  assert.equal(s.db.breakRemainingMs(), 40000);
  s.setTime(61000);
  assert.equal(s.db.expireBreak(), true);
  s.db.finish(s.sessionId);
  assert.deepEqual(s.events().at(-1).payload, { focusMs: 1000, breakMs: 40000, pausedMs: 0 });
});

test("reopening an overdue break records the intended deadline once and pauses uncertain time", t => {
  const s = setup(t);
  s.setTime(500);
  s.start();
  s.setTime(86400000);
  s.reopen();
  assert.equal(s.db.snapshot("").active.phase, "paused");
  s.reopen();
  s.setTime(86401000);
  s.db.finish(s.sessionId);
  const ends = s.events().filter(e => e.kind === "break.ended");
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].payload, { focusMs: 500, pausedMs: 0, breakMs: 0, startSequence: 2,
    reason: "overdue-on-reopen", effectiveAt: new Date(epoch + 60500).toISOString(),
    processedAt: new Date(epoch + 86400000).toISOString() });
  assert.equal(ends[0].elapsedMs, null);
  assert.deepEqual(s.events().at(-1).payload, { focusMs: 500, pausedMs: 1000, breakMs: 0 });
});

for (const finishFirst of [true, false]) {
  const order = finishFirst ? "Finish then End early" : "End early then Finish";
  test(`${order} at the exact deadline closes one break`, t => {
    const s = setup(t);
    s.start(5);
    const early = { ...s.target(), phase: "focus" };
    s.setTime(300000);
    if (finishFirst) {
      s.db.finish(s.sessionId);
      assert.throws(() => s.db.changePhase(early), /already closed/);
    } else {
      s.db.changePhase(early);
      s.db.finish(s.sessionId);
    }
    assert.equal(s.db.expireBreak(), false);
    assert.deepEqual(s.events().map(e => e.kind), ["session.started", "break.started", "break.ended", "session.finished"]);
    assert.equal(s.events()[2].payload.reason, "expired");
    assert.deepEqual(s.events().at(-1).payload, { focusMs: 0, breakMs: 300000, pausedMs: 0 });
  });
}
