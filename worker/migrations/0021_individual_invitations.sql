CREATE TABLE individual_invitation (
  id TEXT NOT NULL PRIMARY KEY,
  email TEXT NOT NULL,
  inviterId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  acceptedAt TEXT,
  acceptedBy TEXT REFERENCES user(id) ON DELETE SET NULL
);
CREATE INDEX individual_invitation_email_idx ON individual_invitation(email);
