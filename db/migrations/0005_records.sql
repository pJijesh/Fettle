-- Patient records: retention period per clinic, a mark for anonymised patients, and a VAT registration number.
ALTER TABLE clinics ADD COLUMN retention_years INTEGER NOT NULL DEFAULT 8 CHECK (retention_years BETWEEN 1 AND 30);
ALTER TABLE clinics ADD COLUMN vat_number TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN anonymised_at TIMESTAMPTZ;
