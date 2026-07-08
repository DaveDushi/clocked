-- Team timesheet delivery: the manager chooses where every member's timesheet is
-- emailed (and on which day), overriding each member's personal setting. Solo
-- users keep their own user_settings. Mirrors user_settings, keyed by org.
CREATE TABLE IF NOT EXISTS org_settings (
  organizationId TEXT NOT NULL PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  mail_to        TEXT,     -- newline/comma-joined recipients (NULL = default to managers)
  send_day       INTEGER   -- NULL = 1st; 0 = off; 1..28 = day; 99 = last day
);
