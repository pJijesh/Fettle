-- Billing: prices, invoices, payments and credit notes. Amounts are whole pence.
-- Invoices, their lines and payments are append-only: the application can add and read them, never edit or delete.
-- A mistake is put right with a credit note (for an invoice) or a reversing entry (for a payment).

ALTER TABLE appointment_types ADD COLUMN price_pence INTEGER NOT NULL DEFAULT 0 CHECK (price_pence >= 0);

ALTER TABLE clinics
  ADD COLUMN invoice_prefix TEXT NOT NULL DEFAULT 'INV',
  ADD COLUMN credit_prefix TEXT NOT NULL DEFAULT 'CN',
  ADD COLUMN vat_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  ADD COLUMN billing_details TEXT NOT NULL DEFAULT '',
  ADD COLUMN payment_terms_days INTEGER NOT NULL DEFAULT 14 CHECK (payment_terms_days BETWEEN 0 AND 365),
  ADD COLUMN next_invoice_number BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN next_credit_number BIGINT NOT NULL DEFAULT 1;

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  number TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invoice','credit_note')),
  patient_id TEXT NOT NULL,
  appointment_id TEXT,
  credits_invoice_id TEXT,
  payer_type TEXT NOT NULL CHECK (payer_type IN ('self','insurer')),
  payer_name TEXT NOT NULL DEFAULT '',
  claim_ref TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  issued_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  subtotal_pence INTEGER NOT NULL,
  vat_pence INTEGER NOT NULL,
  total_pence INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (clinic_id, number),
  UNIQUE (clinic_id, id),
  -- Invoices are positive, credit notes negative, and a credit note always names the invoice it cancels.
  CHECK ((kind = 'invoice' AND total_pence >= 0 AND credits_invoice_id IS NULL) OR (kind = 'credit_note' AND total_pence <= 0 AND credits_invoice_id IS NOT NULL)),
  CHECK (total_pence = subtotal_pence + vat_pence),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, id),
  FOREIGN KEY (clinic_id, appointment_id) REFERENCES appointments(clinic_id, id),
  FOREIGN KEY (clinic_id, credits_invoice_id) REFERENCES invoices(clinic_id, id)
);
-- An invoice can be cancelled by at most one credit note.
CREATE UNIQUE INDEX one_credit_per_invoice ON invoices(credits_invoice_id) WHERE credits_invoice_id IS NOT NULL;
CREATE INDEX idx_invoices_patient ON invoices(clinic_id, patient_id, issued_at);
CREATE INDEX idx_invoices_issued ON invoices(clinic_id, issued_at);
CREATE INDEX idx_invoices_appt ON invoices(appointment_id);

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_pence INTEGER NOT NULL,
  net_pence INTEGER NOT NULL,
  vat_bp INTEGER NOT NULL DEFAULT 0,
  vat_pence INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (clinic_id, invoice_id) REFERENCES invoices(clinic_id, id)
);
CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id, position);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  amount_pence INTEGER NOT NULL CHECK (amount_pence <> 0),
  method TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer','cheque','insurer','other')),
  received_at TIMESTAMPTZ NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  reverses_payment_id TEXT,
  recorded_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, invoice_id) REFERENCES invoices(clinic_id, id),
  FOREIGN KEY (clinic_id, reverses_payment_id) REFERENCES payments(clinic_id, id),
  CHECK ((reverses_payment_id IS NULL AND amount_pence > 0) OR (reverses_payment_id IS NOT NULL AND amount_pence < 0))
);
-- A payment can be reversed once.
CREATE UNIQUE INDEX one_reversal_per_payment ON payments(reverses_payment_id) WHERE reverses_payment_id IS NOT NULL;
CREATE INDEX idx_payments_invoice ON payments(invoice_id);
CREATE INDEX idx_payments_received ON payments(clinic_id, received_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices','invoice_lines','payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY clinic_isolation ON %I USING (clinic_id = app_clinic()) WITH CHECK (clinic_id = app_clinic())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON invoices, invoice_lines, payments TO fettle_app;
