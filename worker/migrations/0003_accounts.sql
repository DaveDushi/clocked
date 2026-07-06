-- Multi-tenant support: per-account API tokens, per-user session ownership,
-- per-user timesheet recipient, and per-user exactly-once send tracking.

-- One (or more) Bearer tokens per account. The desktop app authenticates its
-- sync with this token; resolving it yields the owning user.
CREATE TABLE IF NOT EXISTS api_token (
  token     TEXT NOT NULL PRIMARY KEY,
  userId    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_token_userId_idx ON api_token(userId);

-- Attribute every synced session to the account that pushed it. Nullable so any
-- pre-existing rows (legacy single-user / global-token pushes) remain valid.
ALTER TABLE sessions ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Per-user timesheet recipient (overrides the account email at send time).
CREATE TABLE IF NOT EXISTS user_settings (
  userId  TEXT NOT NULL PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  mail_to TEXT
);

-- Recreate sent_reports keyed per (period, user) for per-account once-a-month
-- delivery. Safe to drop: it only tracks delivery bookkeeping, not user data.
DROP TABLE IF EXISTS sent_reports;
CREATE TABLE sent_reports (
  period   TEXT NOT NULL,   -- "YYYY-MM"
  userId   TEXT NOT NULL,
  sent_utc TEXT NOT NULL,
  PRIMARY KEY (period, userId)
);
