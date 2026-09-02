-- Manage sync credentials as separately named device tokens. Existing tokens
-- remain valid and are adopted as the user's first device.
ALTER TABLE api_token ADD COLUMN id TEXT;
ALTER TABLE api_token ADD COLUMN name TEXT;
UPDATE api_token
SET id = lower(hex(randomblob(16)))
WHERE id IS NULL;
UPDATE api_token
SET name = 'Existing device'
WHERE name IS NULL OR trim(name) = '';
CREATE UNIQUE INDEX IF NOT EXISTS api_token_id_idx ON api_token(id);
