-- Tombstones for sessions removed by a manager/user so desktop re-sync cannot
-- resurrect a deleted clocking (ingest skips these ids).
CREATE TABLE IF NOT EXISTS session_deletions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_deletions_user ON session_deletions(user_id);
