-- Time entered in the dashboard. edited_by is the account that entered it;
-- replaces_id is the recorded session an edit replaced (that id is tombstoned).
-- Both stay NULL for desktop sessions and for entries made before this migration.
ALTER TABLE sessions ADD COLUMN edited_by TEXT;
ALTER TABLE sessions ADD COLUMN replaces_id TEXT;
