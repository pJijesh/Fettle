-- Development only. Creates the restricted application role with a known password so DATABASE_URL in
-- .env.example works. In production, create the role through your provider and set its own password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fettle_app') THEN
    CREATE ROLE fettle_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE fettle_app LOGIN PASSWORD 'fettle_app';
