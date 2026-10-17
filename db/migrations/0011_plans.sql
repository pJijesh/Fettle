-- Free trial and paid plan.
--
-- Every new clinic starts on a trial. When it ends the clinic keeps its records (it can still sign in, look
-- things up and export) but can no longer add or change anything until it subscribes. A clinic's plan lives in
-- its own table so the payment provider's ids stay out of the publicly readable clinics table.
--
-- The application may change the payment state (status, paid_until, provider ids) but not when the trial ends:
-- that is set once, when the clinic is created.

CREATE TABLE clinic_plans (
  clinic_id TEXT PRIMARY KEY REFERENCES clinics(id),
  status TEXT NOT NULL CHECK (status IN ('trial','active','past_due','cancelled','complimentary')),
  trial_ends_at TIMESTAMPTZ,
  paid_until TIMESTAMPTZ,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX clinic_plans_subscription ON clinic_plans (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

ALTER TABLE clinic_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY clinic_plans_own ON clinic_plans USING (clinic_id = app_clinic()) WITH CHECK (clinic_id = app_clinic());
GRANT SELECT ON clinic_plans TO fettle_app;
GRANT UPDATE (status, paid_until, stripe_customer_id, stripe_subscription_id, updated_at) ON clinic_plans TO fettle_app;

-- Clinics that already exist were set up by hand before plans existed. They are not put on a trial clock.
INSERT INTO clinic_plans (clinic_id, status, updated_at) SELECT id, 'complimentary', now() FROM clinics;

-- Opens a clinic and its owner together, on a trial of p_trial_days. Used by self-service sign-up; the first-run
-- set-up below goes through it too. The slug gets a number on the end if another clinic already has it.
CREATE FUNCTION register_clinic(
  p_clinic_id text, p_clinic_name text, p_slug text, p_timezone text,
  p_user_id text, p_email text, p_user_name text, p_password_hash text, p_now timestamptz, p_trial_days integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  v_slug text := p_slug;
  n integer := 1;
BEGIN
  IF p_trial_days < 0 OR p_trial_days > 90 THEN
    RAISE EXCEPTION 'bad_trial' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fettle_register'));
  IF EXISTS (SELECT 1 FROM users WHERE email = lower(p_email)) THEN
    RAISE EXCEPTION 'email_taken' USING ERRCODE = 'P0001';
  END IF;
  WHILE EXISTS (SELECT 1 FROM clinics WHERE slug = v_slug) LOOP
    n := n + 1;
    v_slug := left(p_slug, 36) || '-' || n;
  END LOOP;
  INSERT INTO clinics (id, name, slug, timezone, created_at) VALUES (p_clinic_id, p_clinic_name, v_slug, p_timezone, p_now);
  INSERT INTO users (id, clinic_id, email, name, role, password_hash, created_at)
    VALUES (p_user_id, p_clinic_id, lower(p_email), p_user_name, 'owner', p_password_hash, p_now);
  INSERT INTO clinic_plans (clinic_id, status, trial_ends_at, updated_at)
    VALUES (p_clinic_id, 'trial', p_now + make_interval(days => p_trial_days), p_now);
END
$$;

-- First run only (same name and arguments as before): refuses once any user exists, otherwise registers the clinic
-- on the standard seven-day trial.
CREATE OR REPLACE FUNCTION bootstrap_clinic(
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
  PERFORM register_clinic(p_clinic_id, p_clinic_name, p_slug, p_timezone, p_user_id, p_email, p_user_name, p_password_hash, p_now, 7);
END
$$;

-- The payment provider reports a subscription by its own id; this says which clinic it belongs to.
CREATE FUNCTION clinic_of_subscription(p_subscription_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT clinic_id FROM clinic_plans WHERE stripe_subscription_id = p_subscription_id $$;

REVOKE ALL ON FUNCTION register_clinic(text,text,text,text,text,text,text,text,timestamptz,integer), clinic_of_subscription(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_clinic(text,text,text,text,text,text,text,text,timestamptz,integer), clinic_of_subscription(text) TO fettle_app;
