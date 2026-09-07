CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  start_utc TEXT NOT NULL,
  end_utc TEXT,
  start_reason TEXT,
  end_reason TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_start_utc ON sessions(start_utc);

CREATE TABLE IF NOT EXISTS sent_reports (
  period TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
