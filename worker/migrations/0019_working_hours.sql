-- Manager-assigned hours are separate from report delivery and personal settings.
CREATE TABLE org_working_hours (
  organizationId TEXT NOT NULL PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL CHECK (json_valid(schedule))
);

-- An override belongs to this membership, so leaving and rejoining resets it.
CREATE TABLE member_working_hours (
  membershipId TEXT NOT NULL PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL CHECK (json_valid(schedule))
);
