# Operations runbook

For whoever runs Fettle in production. It covers configuration, backups, restores, upgrades and what to do when something is wrong. Nothing here has been exercised against a real production host yet; the backup and restore scripts have been run against a local Postgres 16 (see "What has been tested").

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Connection for the running app. Must use the `fettle_app` role, which cannot bypass row-level security. Never the owner |
| `DATABASE_OWNER_URL` | Migrations, backups and restore checks only. Keep it out of the app's environment |
| `LINK_SECRET` | Signs patient links. At least 16 random characters. Changing it breaks every link already sent |
| `APP_BASE_URL` | Public URL used in emails and texts. Use `https` in production |
| `CRON_SECRET`, `DISABLE_BACKGROUND_TICK` | Run the background work from an external scheduler instead of inside the app. Call `POST /api/worker` with `Authorization: Bearer <CRON_SECRET>` |
| `TRANSCRIPT_RETENTION_DAYS` | Days after approval before a consultation transcript is cleared. Default 30; `0` keeps them |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY` | Physiotherapy drafting. The default is a labelled mock |

Serve the app only over HTTPS, behind a proxy that sets `X-Forwarded-Proto: https`. The app then sends `Strict-Transport-Security` and `upgrade-insecure-requests`. Without that header it assumes plain HTTP and sends neither, so the browser is never told to insist on HTTPS.

Security headers on every page: a Content-Security-Policy with a fresh script nonce per request, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, a `Permissions-Policy` that switches off camera, microphone, location and payment, and `Cross-Origin-Opener-Policy: same-origin`. If you add a third-party script, font or image host, add it to `src/lib/csp.ts`; the browser will otherwise block it.

## Deploying and upgrading

1. Take a backup (below).
2. `DATABASE_OWNER_URL=... npm run db:migrate`. Safe to repeat; finished migrations are skipped, and two runs at once take turns.
3. Start the new version. `GET /api/health` returns `{"status":"ok"}` when the app can reach its database.

Migrations only move forward. To go back, restore the pre-upgrade backup.

## Backups

```bash
DATABASE_OWNER_URL=postgres://owner@host/fettle \
BACKUP_DIR=/var/backups/fettle \
BACKUP_PASSPHRASE='long passphrase kept somewhere else' \
scripts/backup.sh
```

- Output is a compressed Postgres dump taken in one consistent snapshot, with a `.sha256` next to it. A file only gets its final name when it is complete.
- With `BACKUP_PASSPHRASE` set the file is encrypted (AES-256). Backups hold patient records, so encrypt them, store them in the UK or EU, and store the passphrase separately.
- `BACKUP_KEEP_DAYS` (default 30) deletes older files. Set `0` to keep everything.
- Needs `pg_dump` at the same major version as the server or newer, and `openssl` if encrypting.

**Schedule:** at least daily, and before every deploy. With a managed Postgres, also turn on its point-in-time recovery and keep this as the second, independent copy.

**Sent off the machine:** copy `BACKUP_DIR` to storage in a different account or provider from the database. A backup on the same disk as the database is not a backup.

## Proving a backup works

An untested backup is a hope. After each backup, and by hand before trusting a new host:

```bash
VERIFY_ADMIN_URL=postgres://owner@scratch-host/postgres \
BACKUP_PASSPHRASE=... \
scripts/restore-verify.sh /var/backups/fettle/fettle-20261015T030000Z.dump.enc
```

It checks the checksum, decrypts, restores into a throwaway database, then confirms that every migration in the repository is recorded, that row-level security is switched on for every table with a `clinic_id` and its policies came back, and that the data and audit log are present. It prints a summary and removes the throwaway database. It exits non-zero on any problem, so put it in the same scheduled job as the backup and alert on failure.

Run it against a scratch server, not the live one. It creates and drops a database named `fettle_verify_...`.

## Restoring for real

1. Stop the app (or point it at maintenance) so nothing writes during the restore.
2. Create an empty database and make sure the `fettle_app` role exists (`CREATE ROLE fettle_app NOLOGIN;` is enough; then `ALTER ROLE fettle_app LOGIN PASSWORD '...'`).
3. Decrypt if needed: `openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_PASSPHRASE -in file.dump.enc -out file.dump`.
4. `pg_restore --no-owner --exit-on-error --dbname=<new database url> file.dump`.
5. `DATABASE_OWNER_URL=<new database url> npm run db:migrate` to apply anything newer than the backup.
6. Point `DATABASE_URL` at it, start the app, check `/api/health`, sign in, open a recent patient.
7. Write down what was lost: everything after the backup's timestamp.

Practise this once on a scratch server before you need it.

## Logs

The app writes one JSON object per line to standard output and error: `{"time","level","event",...}`. Errors carry only a code, constraint and call stack, never the message, because database messages can quote patient data. The background tick logs a line only when it did something (`event: "tick"` with counts).

Alert on: `level":"error"`, `/api/health` failing, a `tick` line with `failed` or `errors` above zero for several runs in a row, and the backup job failing.

## Patient data requests

- **A copy of a person's data:** open the patient, then "Download all their data (JSON)". Owner only; audited.
- **Erasure or end of retention:** Settings, Records and retention, lists people past their retention date. On the patient, "Remove their identity" keeps the clinical and financial record but removes who it belongs to. Before the retention date it needs a written reason. It cannot be undone; take a backup first if in doubt.
- Retention is 8 years after the last activity by default (25th birthday for children if later). Check the period with your professional body and insurer.
- Backups still hold a person's data until they age out. Say so when answering an erasure request.

## When something is wrong

| Symptom | Look at |
|---|---|
| Health check fails | Database reachable? `DATABASE_URL` correct, `fettle_app` has LOGIN and password? |
| Everyone's pages are empty | The app is connecting as the wrong role, or a migration did not run |
| Reminders not going out | Is the tick running (`DISABLE_BACKGROUND_TICK`, `CRON_SECRET`)? Is a real mail provider configured? The development mailer sends nothing |
| Patient links stopped working | `LINK_SECRET` changed |
| Page loads but buttons do nothing | A Content-Security-Policy block. Check the browser console and `src/lib/csp.ts` |

## What has been tested

- `scripts/backup.sh` and `scripts/restore-verify.sh`: run against a local Postgres 16 with and without encryption. A wrong passphrase, a corrupted file and a backup missing a migration each fail with a clear message.
- Not yet tested: a managed Postgres, a scheduled job, off-site copy, restore onto a different server, restore timing at real data sizes.
