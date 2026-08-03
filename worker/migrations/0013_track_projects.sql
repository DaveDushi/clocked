-- Desktop feature flag: when false, hide project rollups from dashboard, CSV,
-- and email even if historical activity_day rows still exist.
ALTER TABLE user_settings ADD COLUMN track_projects INTEGER;
