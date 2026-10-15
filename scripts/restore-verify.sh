#!/usr/bin/env bash
# Proves a backup can actually be restored: restores it into a throwaway database, checks that it is complete and
# that row-level security survived, then drops the throwaway database. Run it after every backup, and by hand
# before trusting a new host.
#
#   VERIFY_ADMIN_URL=postgres://owner@host/postgres scripts/restore-verify.sh backups/fettle-XXXX.dump[.enc]
#
# VERIFY_ADMIN_URL must be able to create and drop databases. Use a scratch server, never the live database's name.
# BACKUP_PASSPHRASE is needed for .enc files. Exits non-zero on any problem.
set -euo pipefail

file="${1:?Usage: restore-verify.sh <backup file>}"
: "${VERIFY_ADMIN_URL:?Set VERIFY_ADMIN_URL to a connection string that can create databases}"
root="$(cd "$(dirname "$0")/.." && pwd)"
scratch="fettle_verify_$(date -u +%Y%m%d%H%M%S)_$$"

work="$(mktemp -d)"
cleanup() {
  psql "$VERIFY_ADMIN_URL" -qAt -c "DROP DATABASE IF EXISTS \"$scratch\" WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "FAILED: $1" >&2; exit 1; }

if [ -f "$file.sha256" ]; then
  ( cd "$(dirname "$file")" && sha256sum --check --quiet "$(basename "$file").sha256" ) || fail "checksum does not match"
fi

dump="$file"
if [[ "$file" == *.enc ]]; then
  : "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE to open an encrypted backup}"
  dump="$work/plain.dump"
  openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in "$file" -out "$dump" || fail "could not decrypt (wrong passphrase?)"
fi

psql "$VERIFY_ADMIN_URL" -qAt -c "CREATE DATABASE \"$scratch\"" >/dev/null
# The dump refers to the app role in its grants. It exists on a real server; create it on a bare scratch one.
psql "$VERIFY_ADMIN_URL" -qAt -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fettle_app') THEN CREATE ROLE fettle_app NOLOGIN; END IF; END \$\$" >/dev/null

# Same server, different database name.
target="$(node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];console.log(u.toString())' "$VERIFY_ADMIN_URL" "$scratch")"
pg_restore --no-owner --exit-on-error --dbname="$target" "$dump" || fail "pg_restore reported errors"

q() { psql "$target" -qAt -c "$1"; }

# 1. Every migration in the repository is recorded as applied, and nothing unknown is.
expected="$(cd "$root/db/migrations" && ls *.sql | sort | tr '\n' ' ')"
actual="$(q "SELECT name FROM schema_migrations ORDER BY name" | tr '\n' ' ')"
[ "$expected" = "$actual" ] || fail "migrations differ. Repository: $expected| Backup: $actual"

# 2. Row-level security is still on, and forced where the schema forces it, for every table that has a clinic_id.
missing="$(q "SELECT string_agg(c.relname, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
                AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'clinic_id' AND NOT a.attisdropped)
                AND NOT c.relrowsecurity")"
[ -z "$missing" ] || fail "row-level security is off on: $missing"
policies="$(q "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")"
[ "$policies" -gt 0 ] || fail "no row-level security policies were restored"

# 3. The data is there. A live clinic must have rows; an empty install is allowed to have none.
clinics="$(q "SELECT count(*) FROM clinics")"
patients="$(q "SELECT count(*) FROM patients")"
appts="$(q "SELECT count(*) FROM appointments")"
audit="$(q "SELECT count(*) FROM audit_log")"
if [ "$clinics" -gt 0 ] && [ "$audit" -eq 0 ]; then fail "clinics restored but the audit log is empty"; fi

echo "OK: $(basename "$file") restored. migrations=$(echo "$actual" | wc -w) policies=$policies clinics=$clinics patients=$patients appointments=$appts audit_rows=$audit"
