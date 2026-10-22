-- Existing monthly schedules remain unchanged. Weekly delivery is opt-in.
-- Weekly send_day uses ISO weekdays: 1 = Monday, 7 = Sunday, 0 = disabled.
ALTER TABLE user_settings ADD COLUMN send_frequency TEXT NOT NULL DEFAULT 'monthly'
  CHECK (send_frequency IN ('monthly', 'weekly'));
ALTER TABLE org_settings ADD COLUMN send_frequency TEXT NOT NULL DEFAULT 'monthly'
  CHECK (send_frequency IN ('monthly', 'weekly'));
