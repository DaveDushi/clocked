-- Autonomous marketing agent log + public tip/post feed.
CREATE TABLE IF NOT EXISTS marketing_runs (
  id         TEXT PRIMARY KEY,
  ran_at     TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  summary    TEXT NOT NULL,
  details    TEXT
);
CREATE INDEX IF NOT EXISTS idx_marketing_runs_at ON marketing_runs(ran_at);

CREATE TABLE IF NOT EXISTS marketing_posts (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,   -- tip | launch | seo
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  channel    TEXT             -- indexnow | site | x | manual
);
CREATE INDEX IF NOT EXISTS idx_marketing_posts_created ON marketing_posts(created_at);

CREATE TABLE IF NOT EXISTS marketing_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
