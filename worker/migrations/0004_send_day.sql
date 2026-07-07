-- Per-user auto-send schedule: which day of the month the timesheet is emailed.
-- NULL = default (the 1st). 0 = automatic sending disabled. 1..28 = that day.
ALTER TABLE user_settings ADD COLUMN send_day INTEGER;
