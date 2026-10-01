-- Historical IANA timezone captured by the desktop when each session starts.
-- NULL preserves compatibility with sessions uploaded by older clients.
ALTER TABLE sessions ADD COLUMN timezone TEXT;
