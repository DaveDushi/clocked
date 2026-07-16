-- Daily app/project aggregates synced from the desktop (no window titles).
-- Primary key is (user_id, day, app, project); desktop upserts by sending
-- absolute day totals for that triple.
CREATE TABLE IF NOT EXISTS activity_day (
  user_id  TEXT NOT NULL,
  day      TEXT NOT NULL,  -- YYYY-MM-DD in the user's local calendar
  app      TEXT NOT NULL,
  project  TEXT NOT NULL,
  secs     INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day, app, project)
);
CREATE INDEX IF NOT EXISTS idx_activity_day_user_day ON activity_day(user_id, day);
