-- Cumulative durations have no timestamp intervals and never enter sessions.
CREATE TABLE mobile_usage (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  day TEXT NOT NULL,
  selection_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'ios'),
  timezone TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0 AND duration_seconds <= 90000),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, day, selection_id)
);
CREATE INDEX idx_mobile_usage_period ON mobile_usage(user_id, day);
