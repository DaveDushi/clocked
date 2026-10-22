CREATE TABLE org_time_policy (
  organizationId TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  paid_lunch_minutes INTEGER NOT NULL DEFAULT 0 CHECK (paid_lunch_minutes BETWEEN 0 AND 180),
  lunch_min_minutes INTEGER NOT NULL DEFAULT 20 CHECK (lunch_min_minutes BETWEEN 2 AND 180),
  lunch_max_minutes INTEGER NOT NULL DEFAULT 90 CHECK (lunch_max_minutes BETWEEN lunch_min_minutes AND 240),
  long_break_minutes INTEGER NOT NULL DEFAULT 0 CHECK (long_break_minutes BETWEEN 0 AND 1440),
  overtime_mode TEXT NOT NULL DEFAULT 'disabled' CHECK (overtime_mode IN ('disabled', 'daily', 'weekly')),
  overtime_threshold_minutes INTEGER NOT NULL DEFAULT 480 CHECK (overtime_threshold_minutes BETWEEN 1 AND 10080),
  CHECK (overtime_mode != 'daily' OR overtime_threshold_minutes <= 1440)
);
