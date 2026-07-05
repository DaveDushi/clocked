-- Sessions synced from the desktop app (upsert by uuid).
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  start_utc    TEXT NOT NULL,
  end_utc      TEXT NOT NULL,
  start_reason TEXT,
  end_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start_utc);

-- One row per month we've already emailed, for exactly-once sending.
CREATE TABLE IF NOT EXISTS sent_reports (
  period   TEXT PRIMARY KEY,  -- "YYYY-MM"
  sent_utc TEXT NOT NULL
);
