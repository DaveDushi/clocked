-- Durable fixed-window rate limits (shared across Worker isolates).
CREATE TABLE IF NOT EXISTS rate_limit (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_reset ON rate_limit(reset_at);
