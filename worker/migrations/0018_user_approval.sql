-- Manual account approval. A verified account stays pending until the operator
-- approves it (email link or `npm run users:approve`). No row, or a NULL
-- approvedAt, means pending. Invitees who accept a team invite are approved
-- automatically.
CREATE TABLE IF NOT EXISTS user_approval (
  userId TEXT PRIMARY KEY,
  requestedAt TEXT,
  approvedAt TEXT
);

-- Everyone who signed up before approval existed keeps access.
INSERT OR IGNORE INTO user_approval (userId, requestedAt, approvedAt)
SELECT id, datetime('now'), datetime('now') FROM user;
