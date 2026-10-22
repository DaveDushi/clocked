ALTER TABLE org_settings ADD COLUMN report_format TEXT NOT NULL DEFAULT 'per-member'
  CHECK (report_format IN ('per-member', 'workbook'));
