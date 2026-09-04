-- Email-based paywall exemptions. Emails are normalized by the operator CLI,
-- and may be granted before the matching account is created.
CREATE TABLE IF NOT EXISTS complimentary_access (
  email     TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
  createdAt INTEGER NOT NULL,
  CHECK (email = lower(trim(email)))
);

