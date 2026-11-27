import type { DatabaseSync } from "node:sqlite";

// Each history row stores the text before its edit. The following row (or the
// current note) supplies the resulting text and the timestamp the archive kept.
const legacyNotes = `
  WITH edits AS (
    SELECT v.id, v.note_id, n.session_id,
      COALESCE(lead(v.saved_at) OVER revisions, n.updated_at) AS occurred_at,
      COALESCE(lead(v.body) OVER revisions, n.body) AS body
    FROM note_versions v JOIN notes n ON n.id = v.note_id
    WINDOW revisions AS (PARTITION BY v.note_id ORDER BY v.id)
  )
  SELECT id || ':start' AS id, id AS session_id, started_at AS occurred_at,
    'session.started' AS kind, json_object('title', title) AS payload, 0 AS source_row FROM sessions
  UNION ALL
  SELECT n.id, n.session_id, n.created_at, 'note.added',
    json_object('noteId', n.id, 'body', COALESCE(
      (SELECT v.body FROM note_versions v WHERE v.note_id = n.id ORDER BY v.id LIMIT 1),
      n.body)), n.rowid FROM notes n
  UNION ALL
  SELECT note_id || ':edit:' || id, session_id, occurred_at, 'note.edited',
    json_object('noteId', note_id, 'body', body), id FROM edits
  UNION ALL
  SELECT id || ':finish', id, finished_at, 'session.finished', '{}', 0
    FROM sessions WHERE finished_at IS NOT NULL
`;

// v3 edit IDs end in the original note_versions row ID. This preserves revision
// order even when the old sequence was assigned in reverse timestamp order.
const legacyV3Events = `
  SELECT id, session_id, occurred_at, kind, payload, CASE WHEN kind = 'note.edited'
    THEN CAST(substr(id, instr(id, ':edit:') + 6) AS INTEGER) ELSE sequence END AS source_row
  FROM previous_session_events WHERE sequence_source = 'reconstructed'
`;

export function migrateSessionEvents(db: DatabaseSync, version: 2 | 3 | 4): void {
  if (version >= 3) db.exec("ALTER TABLE session_events RENAME TO previous_session_events");
  db.exec(`
    CREATE TABLE session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      sequence_source TEXT NOT NULL DEFAULT 'recorded' CHECK (sequence_source IN ('recorded', 'reconstructed')),
      occurred_at TEXT NOT NULL,
      utc_offset_minutes INTEGER,
      elapsed_ms INTEGER CHECK (elapsed_ms >= 0),
      phase TEXT CHECK (phase IN ('focus', 'paused', 'finished')),
      kind TEXT NOT NULL CHECK (kind IN ('session.started', 'session.paused', 'session.resumed', 'note.added', 'note.edited', 'session.finished')),
      payload_version INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      UNIQUE (session_id, sequence)
    ) STRICT;
  `);

  db.exec(`CREATE INDEX session_phase_events ON session_events(session_id, sequence DESC)
    WHERE kind IN ('session.started', 'session.paused', 'session.resumed')`);
  if (version === 4) {
    // v4 already has the final replay order. Rebuild only to widen its CHECK constraints.
    db.exec(`INSERT INTO session_events (id, session_id, sequence, sequence_source, occurred_at,
        utc_offset_minutes, elapsed_ms, phase, kind, payload_version, payload)
      SELECT id, session_id, sequence, sequence_source, occurred_at, utc_offset_minutes, elapsed_ms,
        phase, kind, payload_version, payload FROM previous_session_events;
      DROP TABLE previous_session_events;`);
    return;
  }
  const insert = version === 2 ? `
    INSERT INTO session_events (id, session_id, sequence, sequence_source, occurred_at, kind, payload)
    SELECT id, session_id, sequence, 'reconstructed', occurred_at, kind, payload FROM numbered
  ` : `
    INSERT INTO session_events (id, session_id, sequence, sequence_source, occurred_at,
      utc_offset_minutes, elapsed_ms, phase, kind, payload_version, payload)
    SELECT e.id, e.session_id, COALESCE(n.sequence, e.sequence), e.sequence_source, e.occurred_at,
      e.utc_offset_minutes, e.elapsed_ms, e.phase, e.kind, e.payload_version, e.payload
    FROM previous_session_events e LEFT JOIN numbered n ON n.id = e.id
  `;
  db.exec(`
    WITH legacy AS (${version === 2 ? legacyNotes : legacyV3Events}),
    ranked AS (
      SELECT legacy.*, CASE kind WHEN 'session.started' THEN 0 WHEN 'note.added' THEN 1
        WHEN 'note.edited' THEN 2 ELSE 3 END AS tie_rank,
        max(CASE WHEN kind = 'session.finished' THEN occurred_at END) OVER (PARTITION BY session_id) AS finished_at
      FROM legacy
    ), ordered AS (
      -- Bound replay order by known dependencies without changing stored UTC.
      -- Legacy archives did not record whether an ambiguous edit preceded finish.
      SELECT ranked.*,
        max(CASE WHEN kind = 'note.edited' AND occurred_at > finished_at THEN 1 ELSE 0 END)
          OVER revisions AS after_finish,
        CASE kind
        WHEN 'note.edited' THEN max(occurred_at) OVER revisions
        WHEN 'session.finished' THEN max(occurred_at, COALESCE(
          max(CASE WHEN kind = 'note.added' THEN occurred_at END) OVER (PARTITION BY session_id), occurred_at))
        ELSE occurred_at END AS sort_time
      FROM ranked
      WINDOW revisions AS (PARTITION BY session_id, json_extract(payload, '$.noteId')
        ORDER BY tie_rank, source_row ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ), numbered AS (
      SELECT ordered.*, row_number() OVER (
        PARTITION BY session_id ORDER BY (tie_rank != 0), after_finish, sort_time, tie_rank, source_row
      ) AS sequence FROM ordered
    )
    ${insert}
  `);
  if (version === 3) db.exec("DROP TABLE previous_session_events");
}
