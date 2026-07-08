-- Organizations, teams & roles (better-auth organization plugin).
--
-- Adds the plugin's tables so a manager (org role owner/admin) can group members
-- and view their hours. DDL mirrors better-auth 1.6.x's sqlite/D1 output (text ids
-- & FKs, DATE timestamps the app fills). Tables are created in FK-dependency order
-- — organization BEFORE team — to avoid better-auth migration issue #6832 where a
-- team table referencing organization is emitted first.
--
-- Nullable columns are kept permissive so an insert never fails on a NOT NULL the
-- installed plugin version doesn't populate; ids and the fields the plugin always
-- writes stay NOT NULL. No change to the `sessions` (tracked-time) table: manager
-- reads resolve members from `member` and reuse the existing user_id-scoped queries.

CREATE TABLE IF NOT EXISTS organization (
  id        TEXT NOT NULL PRIMARY KEY,
  name      TEXT NOT NULL,
  slug      TEXT NOT NULL UNIQUE,
  logo      TEXT,
  metadata  TEXT,
  createdAt DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS team (
  id             TEXT NOT NULL PRIMARY KEY,
  name           TEXT NOT NULL,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  createdAt      DATE NOT NULL,
  updatedAt      DATE
);
CREATE INDEX IF NOT EXISTS team_organizationId_idx ON team(organizationId);

CREATE TABLE IF NOT EXISTS teamMember (
  id        TEXT NOT NULL PRIMARY KEY,
  teamId    TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  userId    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  createdAt DATE
);
CREATE INDEX IF NOT EXISTS teamMember_teamId_idx ON teamMember(teamId);
CREATE INDEX IF NOT EXISTS teamMember_userId_idx ON teamMember(userId);

CREATE TABLE IF NOT EXISTS member (
  id             TEXT NOT NULL PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  userId         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,
  createdAt      DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS member_organizationId_idx ON member(organizationId);
CREATE INDEX IF NOT EXISTS member_userId_idx ON member(userId);

CREATE TABLE IF NOT EXISTS invitation (
  id             TEXT NOT NULL PRIMARY KEY,
  organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  role           TEXT,
  status         TEXT NOT NULL,
  inviterId      TEXT NOT NULL,
  teamId         TEXT REFERENCES team(id) ON DELETE CASCADE,
  expiresAt      DATE NOT NULL,
  createdAt      DATE
);
CREATE INDEX IF NOT EXISTS invitation_organizationId_idx ON invitation(organizationId);
CREATE INDEX IF NOT EXISTS invitation_email_idx ON invitation(email);

-- Active-context columns the plugin reads/writes on the better-auth login session.
ALTER TABLE session ADD COLUMN activeOrganizationId TEXT;
ALTER TABLE session ADD COLUMN activeTeamId TEXT;
