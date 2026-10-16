-- Note templates: a clinic's own starting structure for a physiotherapy note (which range-of-movement rows,
-- outcome measures and special tests to prompt for, and any standard wording). A template never holds a
-- finding: no values, scores or results, and no red-flag screening.
CREATE TABLE note_templates (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  name TEXT NOT NULL,
  body_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (clinic_id, id)
);
CREATE UNIQUE INDEX note_templates_name ON note_templates (clinic_id, lower(name));

ALTER TABLE note_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY clinic_isolation ON note_templates USING (clinic_id = app_clinic()) WITH CHECK (clinic_id = app_clinic());
GRANT SELECT, INSERT, UPDATE, DELETE ON note_templates TO fettle_app;
