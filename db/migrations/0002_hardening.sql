-- Shared rate limiting, self-service password reset and authenticator recovery codes.

-- ---------------------------------------------------------------------------------- rate limiting
-- Counts are shared by every app process. The table holds only a hash of each key (an address or an
-- email) and is not reachable by the application role at all; the function below is the only way in.
CREATE TABLE rate_limits (
  key_hash BYTEA PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL
);

-- Records one attempt and says whether it is within the allowance for the window.
CREATE FUNCTION rate_limit_hit(p_key text, p_max integer, p_window_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE n integer;
BEGIN
  INSERT INTO rate_limits AS r (key_hash, hits, reset_at)
    VALUES (sha256(convert_to(p_key, 'UTF8')), 1, now() + (p_window_ms || ' milliseconds')::interval)
  ON CONFLICT (key_hash) DO UPDATE SET
    hits = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.hits + 1 END,
    reset_at = CASE WHEN r.reset_at <= now() THEN now() + (p_window_ms || ' milliseconds')::interval ELSE r.reset_at END
  RETURNING r.hits INTO n;
  -- Now and then, sweep out windows that ended long ago.
  IF random() < 0.01 THEN
    DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day';
  END IF;
  RETURN n <= p_max;
END
$$;

-- ---------------------------------------------------------------------------------- password reset
CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  FOREIGN KEY (clinic_id, user_id) REFERENCES users(clinic_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

-- ---------------------------------------------------------------------------------- recovery codes
CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  UNIQUE (user_id, code_hash),
  FOREIGN KEY (clinic_id, user_id) REFERENCES users(clinic_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['password_resets','mfa_recovery_codes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY clinic_isolation ON %I USING (clinic_id = app_clinic()) WITH CHECK (clinic_id = app_clinic())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets, mfa_recovery_codes TO fettle_app;

-- A reset link carries only a secret token; this says which clinic it belongs to (the caller hashes the token first).
CREATE FUNCTION clinic_of_password_reset(p_token_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT clinic_id FROM password_resets WHERE token_hash = p_token_hash $$;

REVOKE ALL ON FUNCTION rate_limit_hit(text,integer,integer), clinic_of_password_reset(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_limit_hit(text,integer,integer), clinic_of_password_reset(text) TO fettle_app;
