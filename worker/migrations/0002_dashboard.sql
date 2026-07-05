-- Dashboard support: app settings + better-auth tables.

-- Key/value app settings (e.g. "mail_to" overrides the MAIL_TO var at send time).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- better-auth core tables. DDL mirrors better-auth 1.6.x's own sqlite/D1
-- migration output (string->text, boolean->integer, date->date, id/FK->text;
-- sqlite gets no DB-side date defaults — the app fills createdAt/updatedAt).
CREATE TABLE IF NOT EXISTS user (
  id            TEXT NOT NULL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image         TEXT,
  createdAt     DATE NOT NULL,
  updatedAt     DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id        TEXT NOT NULL PRIMARY KEY,
  expiresAt DATE NOT NULL,
  token     TEXT NOT NULL UNIQUE,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_userId_idx ON session(userId);

CREATE TABLE IF NOT EXISTS account (
  id                    TEXT NOT NULL PRIMARY KEY,
  accountId             TEXT NOT NULL,
  providerId            TEXT NOT NULL,
  userId                TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken           TEXT,
  refreshToken          TEXT,
  idToken               TEXT,
  accessTokenExpiresAt  DATE,
  refreshTokenExpiresAt DATE,
  scope                 TEXT,
  password              TEXT,
  createdAt             DATE NOT NULL,
  updatedAt             DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS account_userId_idx ON account(userId);

CREATE TABLE IF NOT EXISTS verification (
  id         TEXT NOT NULL PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expiresAt  DATE NOT NULL,
  createdAt  DATE NOT NULL,
  updatedAt  DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);
