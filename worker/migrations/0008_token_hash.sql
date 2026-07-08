-- Hash API tokens at rest. Legacy rows keep plaintext in `token` until the next
-- successful auth upgrades them (see tokens.ts). New rows store a non-secret
-- placeholder in `token` (h:<hash>) so the PK stays unique, plus token_hash.
ALTER TABLE api_token ADD COLUMN token_hash TEXT;
ALTER TABLE api_token ADD COLUMN token_prefix TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS api_token_token_hash_idx ON api_token(token_hash);
