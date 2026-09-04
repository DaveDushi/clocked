-- Configurable monthly delivery wall-clock time and IANA timezone.
-- NULL preserves the historical trigger: 06:00 UTC.
ALTER TABLE user_settings ADD COLUMN send_time TEXT;
ALTER TABLE user_settings ADD COLUMN send_timezone TEXT;
ALTER TABLE org_settings ADD COLUMN send_time TEXT;
ALTER TABLE org_settings ADD COLUMN send_timezone TEXT;
