-- Letters and patient summaries written from an approved consultation. Drafted with AI help, edited and finalised by a
-- practitioner. A final document is not edited; a summary can be withdrawn so the patient link stops showing it.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  consult_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('gp_update','referral','discharge','patient_summary')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','withdrawn')),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  language TEXT,
  draft_model TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finalised_by TEXT,
  finalised_at TIMESTAMPTZ,
  content_hash TEXT,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, consult_id) REFERENCES consults(clinic_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_documents_consult ON documents (clinic_id, consult_id);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY clinic_isolation ON documents USING (clinic_id = app_clinic()) WITH CHECK (clinic_id = app_clinic());
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO fettle_app;
