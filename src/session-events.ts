import type { DatabaseSync } from "node:sqlite";

// The caller runs this inside the same transaction as the schema-version update.
export function migrateSessionEvents(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      sequence_source TEXT NOT NULL DEFAULT 'recorded' CHECK (sequence_source IN ('recorded', 'reconstructed')),
      occurred_at TEXT NOT NULL,
      utc_offset_minutes INTEGER,
      elapsed_ms INTEGER CHECK (elapsed_ms >= 0),
      phase TEXT,
      kind TEXT NOT NULL,
      payload_version INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      UNIQUE (session_id, sequence)
    ) STRICT;

    -- Each v2 history row stores the text BEFORE its edit. The next version
    -- (or the current note) supplies the resulting text and saved timestamp.
    WITH edits AS (
      SELECT v.id, v.note_id, n.session_id,
        COALESCE(lead(v.saved_at) OVER revisions, n.updated_at) AS occurred_at,
        COALESCE(lead(v.body) OVER revisions, n.body) AS body
      FROM note_versions v JOIN notes n ON n.id = v.note_id
      WINDOW revisions AS (PARTITION BY v.note_id ORDER BY v.id)
    ), legacy(id, session_id, occurred_at, kind, payload, tie_rank, source_row) AS (
      SELECT id || ':start', id, started_at, 'session.started', json_object('title', title), 0, 0
      FROM sessions
      UNION ALL
      SELECT n.id, n.session_id, n.created_at, 'note.added',
        json_object('noteId', n.id, 'body', COALESCE(
          (SELECT v.body FROM note_versions v WHERE v.note_id = n.id ORDER BY v.id LIMIT 1),
          n.body)), 1, n.rowid
      FROM notes n
      UNION ALL
      SELECT note_id || ':edit:' || id, session_id, occurred_at, 'note.edited',
        json_object('noteId', note_id, 'body', body), 2, id
      FROM edits
      UNION ALL
      SELECT id || ':finish', id, finished_at, 'session.finished', '{}', 3, 0
      FROM sessions WHERE finished_at IS NOT NULL
    ),
    -- v2 did not record a cross-note sequence. Start precedes every note and
    -- finish follows every original, even when the wall clock went backwards.
    -- Preserve the actual timestamps. Use stable tie breakers for the rest.
    ordered AS (
      SELECT legacy.*, CASE WHEN kind = 'session.finished' THEN
        max(occurred_at, COALESCE(max(CASE WHEN kind = 'note.added' THEN occurred_at END)
          OVER (PARTITION BY session_id), occurred_at))
        ELSE occurred_at END AS sort_time
      FROM legacy
    )
    INSERT INTO session_events (id, session_id, sequence, sequence_source, occurred_at, kind, payload)
    SELECT id, session_id, row_number() OVER (
      PARTITION BY session_id ORDER BY (tie_rank != 0), sort_time, tie_rank, source_row
    ), 'reconstructed', occurred_at, kind, payload FROM ordered;
  `);
}
