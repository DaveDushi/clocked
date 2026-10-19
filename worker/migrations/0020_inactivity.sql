CREATE TABLE org_inactivity (
  organizationId TEXT NOT NULL PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  timeout_secs INTEGER NOT NULL CHECK (timeout_secs BETWEEN 60 AND 86400),
  warning_secs INTEGER NOT NULL CHECK (warning_secs >= 0 AND warning_secs < timeout_secs)
);
