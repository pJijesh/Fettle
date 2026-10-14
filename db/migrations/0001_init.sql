-- Fettle schema for Postgres 16+.
--
-- Tenancy: every clinic's rows carry clinic_id, and row-level security limits the application role to
-- the clinic named in the transaction setting app.clinic_id (set by src/lib/db.ts). The application
-- never connects as the table owner, so the policies cannot be skipped by a bug in a query.
-- Lookups that must happen before a clinic is known (sign-in, patient links) go through the small
-- SECURITY DEFINER functions at the end of this file and nothing else.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fettle_app') THEN
    CREATE ROLE fettle_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

CREATE FUNCTION app_clinic() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.clinic_id', true), '') $$;

CREATE TABLE clinics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','clinician','reception')),
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step BIGINT,
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (clinic_id, id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  clinic_id TEXT NOT NULL,
  mfa_ok INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (clinic_id, user_id) REFERENCES users(clinic_id, id) ON DELETE CASCADE
);

CREATE TABLE patients (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dob TEXT,
  email TEXT,
  phone TEXT,
  gp_name TEXT,
  gp_practice TEXT,
  address TEXT,
  postcode TEXT,
  sms_consent_at TIMESTAMPTZ,
  email_consent_at TIMESTAMPTZ,
  marketing_consent_at TIMESTAMPTZ,
  merged_into TEXT,
  external_ref TEXT,
  import_batch TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (clinic_id, id)
);

CREATE TABLE appointment_types (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  name TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  buffer_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 120),
  online_bookable INTEGER NOT NULL DEFAULT 1,
  colour TEXT NOT NULL DEFAULT 'blue',
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (clinic_id, id)
);

CREATE TABLE clinician_hours (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min INTEGER NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  CHECK (end_min > start_min),
  FOREIGN KEY (clinic_id, user_id) REFERENCES users(clinic_id, id) ON DELETE CASCADE
);

CREATE TABLE consults (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  patient_id TEXT,
  appointment_id TEXT,
  patient_label TEXT NOT NULL,
  pms_patient_id TEXT,
  practitioner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','consented','captured','drafted','approved')),
  consent_at TIMESTAMPTZ,
  consent_method TEXT CHECK (consent_method IN ('verbal','written')),
  consent_recorded_by TEXT,
  consent_withdrawn_at TIMESTAMPTZ,
  transcript TEXT,
  note_json TEXT,
  programme_json TEXT,
  draft_model TEXT,
  drafted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  consult_id TEXT NOT NULL UNIQUE,
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  note_json TEXT NOT NULL,
  programme_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  FOREIGN KEY (clinic_id, consult_id) REFERENCES consults(clinic_id, id) ON DELETE CASCADE
);

CREATE TABLE patient_links (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  consult_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, consult_id) REFERENCES consults(clinic_id, id) ON DELETE CASCADE
);

CREATE TABLE check_ins (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  consult_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  adherence TEXT NOT NULL CHECK (adherence IN ('all','some','none')),
  pain_change TEXT NOT NULL CHECK (pain_change IN ('better','same','worse')),
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (clinic_id, consult_id) REFERENCES consults(clinic_id, id) ON DELETE CASCADE,
  FOREIGN KEY (clinic_id, link_id) REFERENCES patient_links(clinic_id, id) ON DELETE CASCADE
);

CREATE TABLE writebacks (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  consult_id TEXT NOT NULL,
  target TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','needs_check')),
  external_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (clinic_id, consult_id) REFERENCES consults(clinic_id, id) ON DELETE CASCADE
);

-- Append-only for the application role (see grants below). No foreign key on consult_id: the trail outlives the record.
CREATE TABLE audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  consult_id TEXT,
  entity TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  at TIMESTAMPTZ NOT NULL
);

-- hold_until is the end of the appointment plus its buffer; it is what other bookings must clear.
CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  hold_until TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('booked','arrived','completed','cancelled','no_show')),
  cancel_reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('staff','online','waitlist','import')),
  consult_id TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  import_batch TEXT,
  CHECK (end_at > start_at),
  CHECK (hold_until >= end_at),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, id),
  FOREIGN KEY (clinic_id, user_id) REFERENCES users(clinic_id, id),
  FOREIGN KEY (clinic_id, type_id) REFERENCES appointment_types(clinic_id, id),
  -- A clinician can never be in two places at once. The database itself refuses it, so a bug or a
  -- race in application code cannot double-book. Cancelled appointments free their time.
  CONSTRAINT appointment_overlap EXCLUDE USING gist (
    user_id WITH =,
    tstzrange(start_at, hold_until, '[)') WITH &&
  ) WHERE (status <> 'cancelled')
);

CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('intake','consent')),
  fields_json TEXT NOT NULL,
  mandatory INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (clinic_id, id)
);

CREATE TABLE form_requests (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  form_name TEXT NOT NULL,
  form_version INTEGER NOT NULL,
  mandatory INTEGER NOT NULL,
  fields_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed')),
  response_json TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (appointment_id, form_id),
  FOREIGN KEY (clinic_id, appointment_id) REFERENCES appointments(clinic_id, id) ON DELETE CASCADE,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, id),
  FOREIGN KEY (clinic_id, form_id) REFERENCES forms(clinic_id, id)
);

CREATE TABLE portal_codes (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, id)
);

CREATE TABLE portal_sessions (
  token_hash TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, id)
);

CREATE TABLE waitlist (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  user_id TEXT,
  earliest_date TEXT NOT NULL,
  latest_date TEXT NOT NULL,
  weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
  status TEXT NOT NULL CHECK (status IN ('waiting','offered','booked','removed')),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients(clinic_id, id),
  FOREIGN KEY (clinic_id, type_id) REFERENCES appointment_types(clinic_id, id),
  FOREIGN KEY (clinic_id, user_id) REFERENCES users(clinic_id, id)
);

CREATE TABLE waitlist_offers (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  waitlist_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','accepted','expired','taken')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (clinic_id, waitlist_id) REFERENCES waitlist(clinic_id, id) ON DELETE CASCADE
);

CREATE TABLE outbox (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  send_after TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE ical_tokens (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (clinic_id, user_id) REFERENCES users(clinic_id, id) ON DELETE CASCADE
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  kind TEXT NOT NULL,
  filename TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  undone_at TIMESTAMPTZ,
  counts_json TEXT NOT NULL
);

CREATE INDEX idx_audit_consult ON audit_log(consult_id, id);
CREATE INDEX idx_audit_clinic ON audit_log(clinic_id, id);
CREATE INDEX idx_checkins_consult ON check_ins(consult_id, created_at);
CREATE INDEX idx_links_consult ON patient_links(consult_id);
CREATE INDEX idx_consults_clinic ON consults(clinic_id, updated_at);
CREATE INDEX idx_patients_clinic ON patients(clinic_id, last_name);
CREATE INDEX idx_patients_email ON patients(clinic_id, email);
CREATE INDEX idx_appt_clinic_time ON appointments(clinic_id, start_at);
CREATE INDEX idx_appt_user_time ON appointments(user_id, start_at);
CREATE INDEX idx_appt_patient ON appointments(patient_id, start_at);
CREATE INDEX idx_outbox_due ON outbox(status, send_after);
CREATE INDEX idx_offers_waitlist ON waitlist_offers(waitlist_id, status);
CREATE INDEX idx_offers_slot ON waitlist_offers(user_id, start_at);
CREATE INDEX idx_form_requests_appt ON form_requests(appointment_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------------------- row-level security

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','sessions','patients','appointment_types','clinician_hours','consults','approvals','patient_links',
    'check_ins','writebacks','audit_log','appointments','forms','form_requests','portal_codes','portal_sessions',
    'waitlist','waitlist_offers','outbox','ical_tokens','import_batches'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY clinic_isolation ON %I USING (clinic_id = app_clinic()) WITH CHECK (clinic_id = app_clinic())', t);
  END LOOP;
END $$;

-- Clinic names, slugs and time zones are public (online booking pages are addressed by slug).
-- A clinic can only be changed by itself and can only be created through bootstrap_clinic() below.
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
CREATE POLICY clinics_read ON clinics FOR SELECT USING (true);
CREATE POLICY clinics_update_own ON clinics FOR UPDATE USING (id = app_clinic()) WITH CHECK (id = app_clinic());

-- ---------------------------------------------------------------------------------- grants

GRANT USAGE ON SCHEMA public TO fettle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, patients, appointment_types, clinician_hours, consults, approvals, patient_links, check_ins,
  writebacks, appointments, forms, form_requests, portal_codes, portal_sessions, waitlist, waitlist_offers,
  outbox, ical_tokens, import_batches
TO fettle_app;
GRANT SELECT, UPDATE ON clinics TO fettle_app;
-- The audit trail can be added to and read, never edited or removed by the application.
GRANT SELECT, INSERT ON audit_log TO fettle_app;
GRANT EXECUTE ON FUNCTION app_clinic() TO fettle_app;

-- ---------------------------------------------------------------------------------- pre-sign-in lookups
-- These run with the owner's rights because the caller does not yet belong to a clinic. Each returns only
-- what its caller needs and takes a value that is itself a credential (an email being signed in, or a
-- hashed token), so they cannot be used to browse another clinic's data.

CREATE FUNCTION auth_user_by_email(p_email text) RETURNS SETOF users
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT * FROM users WHERE email = lower(p_email) $$;

CREATE FUNCTION auth_session(p_token_hash text)
RETURNS TABLE (mfa_ok integer, expires_at timestamptz, id text, clinic_id text, name text, email text, role text, active integer, totp_enabled integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT s.mfa_ok, s.expires_at, u.id, u.clinic_id, u.name, u.email, u.role, u.active, u.totp_enabled
   FROM sessions s JOIN users u ON u.id = s.user_id AND u.clinic_id = s.clinic_id WHERE s.token_hash = p_token_hash $$;

CREATE FUNCTION setup_needed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT NOT EXISTS (SELECT 1 FROM users) $$;

-- First run only: creates the first clinic and its owner together. Refuses once any user exists.
CREATE FUNCTION bootstrap_clinic(
  p_clinic_id text, p_clinic_name text, p_slug text, p_timezone text,
  p_user_id text, p_email text, p_user_name text, p_password_hash text, p_now timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fettle_bootstrap'));
  IF EXISTS (SELECT 1 FROM users) THEN
    RAISE EXCEPTION 'setup_done' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO clinics (id, name, slug, timezone, created_at) VALUES (p_clinic_id, p_clinic_name, p_slug, p_timezone, p_now);
  INSERT INTO users (id, clinic_id, email, name, role, password_hash, created_at)
    VALUES (p_user_id, p_clinic_id, lower(p_email), p_user_name, 'owner', p_password_hash, p_now);
END
$$;

-- Patient-facing links carry only an id (and a signature the application checks); these say which clinic it belongs to.
CREATE FUNCTION clinic_of_appointment(p_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT clinic_id FROM appointments WHERE id = p_id $$;

CREATE FUNCTION clinic_of_form_request(p_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT clinic_id FROM form_requests WHERE id = p_id $$;

CREATE FUNCTION clinic_of_offer(p_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT clinic_id FROM waitlist_offers WHERE id = p_id $$;

CREATE FUNCTION clinic_of_patient_link(p_token_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT clinic_id FROM patient_links WHERE token_hash = p_token_hash $$;

CREATE FUNCTION clinic_of_portal_session(p_token_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT clinic_id FROM portal_sessions WHERE token_hash = p_token_hash $$;

CREATE FUNCTION clinic_of_ical_token(p_token_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT clinic_id FROM ical_tokens WHERE token_hash = p_token_hash $$;

REVOKE ALL ON FUNCTION
  auth_user_by_email(text), auth_session(text), setup_needed(),
  bootstrap_clinic(text,text,text,text,text,text,text,text,timestamptz),
  clinic_of_appointment(text), clinic_of_form_request(text), clinic_of_offer(text),
  clinic_of_patient_link(text), clinic_of_portal_session(text), clinic_of_ical_token(text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  auth_user_by_email(text), auth_session(text), setup_needed(),
  bootstrap_clinic(text,text,text,text,text,text,text,text,timestamptz),
  clinic_of_appointment(text), clinic_of_form_request(text), clinic_of_offer(text),
  clinic_of_patient_link(text), clinic_of_portal_session(text), clinic_of_ical_token(text)
TO fettle_app;
