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
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_REPLY_TO` | Email through any SMTP service. See "Email and text delivery" |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Text messages through Twilio. All three or none |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Card payment links and their webhook. See "Card payments" |
| `SPEECH_PROVIDER`, `AZURE_SPEECH_ENDPOINT`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_LOCALE` | Audio capture. Unset means it is off. See "Audio capture" |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY` | Physiotherapy drafting. The default is a labelled mock |

Serve the app only over HTTPS, behind a proxy that sets `X-Forwarded-Proto: https`. The app then sends `Strict-Transport-Security` and `upgrade-insecure-requests`. Without that header it assumes plain HTTP and sends neither, so the browser is never told to insist on HTTPS.

Security headers on every page: a Content-Security-Policy with a fresh script nonce per request, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, a `Permissions-Policy` that switches off camera, microphone, location and payment, and `Cross-Origin-Opener-Policy: same-origin`. If you add a third-party script, font or image host, add it to `src/lib/csp.ts`; the browser will otherwise block it.

## Email and text delivery

With no `SMTP_*` or `TWILIO_*` settings the app uses a development mailer that sends nothing, and says so in a banner. Setting `SMTP_HOST` switches email on; setting the `TWILIO_*` trio switches texts on. A partly filled configuration stops the app at start-up with a message saying what is missing. If only email is set up, queued texts fail with "No text provider is set up" and are retried, then recorded as failed in the Outbox.

Before the first real send:

1. Choose a provider that processes data in the UK or EU and sign its data-processing agreement. Messages carry a patient's name, appointment time and place, so the provider is a sub-processor.
2. Send from a domain you control and set SPF, DKIM and DMARC for it, or confirmations will land in spam.
3. Port 587 requires STARTTLS and the app refuses to send in the clear; use 465 only if the provider offers implicit TLS.
4. Send a test confirmation to yourself, and read the headers: check SPF, DKIM and DMARC all pass.
5. Text sender: a number you have bought, or an alphanumeric sender name registered with Twilio (not all UK networks accept unregistered names).

Each email carries a stable `Message-ID` taken from the outbox row, so a duplicate attempt is recognisable to the receiver. The outbox records a failed attempt as a status code only (for example `SMTP 550` or `Twilio 400 code 21211`); look the code up with the provider. Provider messages are not stored because they usually repeat the recipient's address. Patient phone numbers are converted from UK format to international form (07700 900123 becomes +447700900123); a number that cannot be converted fails with "not a valid phone number" and is not retried successfully, so fix the patient's number.

## Card payments

With `STRIPE_SECRET_KEY` set, an unpaid patient invoice shows "Make a card payment link". The patient pays on Stripe's own page, so card details never reach Fettle. Stripe is told only the invoice number, the amount and internal ids, never a patient's name, contact details or anything clinical. Stripe is a sub-processor of payment data: sign its data-processing terms and list it in your privacy notice.

Set up:

1. In the Stripe dashboard add a webhook endpoint `<APP_BASE_URL>/api/stripe/webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`. Without that secret the endpoint answers 404.
2. Use a test-mode key first and pay a test invoice with Stripe's test card. Check the payment appears on the invoice as "Card payment (Stripe)".

How it behaves:

- Each notification is verified against the signing secret and must be less than five minutes old. A wrong signature gets 400.
- A payment is recorded once, however many times Stripe sends it (the Stripe payment id is unique per clinic).
- If a payment cannot be applied (the invoice was cancelled, already paid another way, or the amount is more than is owed), nothing is recorded and an entry `payment.unapplied` is written to the audit log with the invoice and amount. **Refund those in the Stripe dashboard.** Check the audit log for that entry now and then, and alert on the `stripe.event` log line with `result: unapplied`.
- Refunds are not automatic. Refund in Stripe, then on the invoice use "Reverse or refund" with the reason, so the books match.
- Payment links last 24 hours. Making a second link for the same balance within ten minutes returns the same link.
- Links are for the patient's balance on a patient invoice, at least £0.30; insurer invoices are excluded.
- Stripe's own fees are not recorded in Fettle.

## Audio capture

Off by default. With `SPEECH_PROVIDER=azure` (plus `AZURE_SPEECH_ENDPOINT`, the address of your own Azure AI Speech resource, and `AZURE_SPEECH_KEY`), a physiotherapy consultation shows "Record the consultation" once consent is recorded. `SPEECH_PROVIDER=mock` is a demo that invents text; never use it with real patients. Locale defaults to `en-GB`.

- **Where the audio goes.** The browser sends the recording to Fettle, which passes it straight to the speech service in memory and drops it. Fettle writes no audio to disk or the database, and the audit trail holds only sizes, the provider name and that the recording was confirmed, never words. Only the text is kept, and transcripts are cleared after approval like any other (`TRANSCRIPT_RETENTION_DAYS`).
- **Sub-processor.** The speech provider processes the audio, which is special-category data. Before real patients: sign its data-processing terms, pick a region that suits your data-location commitments (create the Speech resource in a UK region if the service supports fast transcription there; check the provider's region table, because this was not confirmed), check how long it retains audio and switch off any training or logging use, and list it in the privacy notice and DPIA.
- **Consent.** Recording needs the usual consent recorded first, then a separate tick that the patient agreed to the audio recording. Withdrawing consent while a recording is being processed discards the text.
- **Browsers.** Recording needs HTTPS (or localhost) and the microphone allowed for the site; the page's `Permissions-Policy` allows the microphone for this site only. Where recording is not possible the screen offers uploading an audio file. Recordings up to 100 MB are accepted (hours of speech), and a long one can take a minute or more to process, so your proxy's timeout should be at least five minutes for `/api/consults/*/audio`.
- **Accuracy.** Speakers are separated for two people and labelled Physio (first voice) and Patient. This is a guess: the physio checks the text and can swap the labels before drafting. Recording is lost if the browser closes mid-consultation; nothing is saved until Stop.

## AI assistance

Letters, patient summaries, the note second look and code suggestions use the same `AI_PROVIDER`, `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` as note drafting. With the default (`mock`) they return labelled placeholder text, never written from the note. With `anthropic`, text from the approved note or the draft note and transcript leaves the app to the model vendor: sign its data-processing terms and confirm where it processes data before real patients, and list it in the privacy notice and DPIA (the same vendor and terms already cover note drafting).

- **What is sent.** The note text (and, for the second look, the numbered transcript) and any instruction the practitioner typed. Never the patient's name, date of birth, address, contact details or the GP's details: the letter heading and sign-off are added in Fettle from the patient record when the letter is shown.
- **What is kept.** Letters and summaries are stored per consultation (table `documents`) with who drafted and finalised them and a content hash. A finalised document cannot be edited. Withdrawing a summary removes it from the patient's link. Anonymising a patient deletes their documents; the patient export includes them. Second-look and code-suggestion results are not stored; the audit log records only that they happened and counts.
- **Safeguards.** Nothing is written to a patient or another clinician automatically. An assistant finding with no valid transcript line is dropped. Code suggestions that do not look like ICD-10 codes are dropped, and at most three are shown. If the assistant is unavailable, the plain note checks still run and drafting says so.
- **Not covered.** Ayurvedic records have no AI. Summaries in languages other than English can be wrong in ways the practitioner cannot see; the screen says to have a fluent speaker check them before finalising.

## Check-in triage and progress

Check-ins are sorted on arrival by plain rules (stored on the check-in with a one-line reason). Anything that says pain is worse, no exercises with no improvement, or a comment that mentions numbness, a fall, bladder or bowel change, fever, chest pain, severe night pain and similar appears under **Check-ins** for owners and clinicians until someone marks it seen (audited as `check_in.reviewed`). The list is a help: clinicians still need to read check-ins on each consultation.

- **AI second reader (owner setting "Patient check-ins", off by default).** When on, the comment text of a check-in the rules called routine is sent to the model chosen by `AI_PROVIDER`. Nothing else is sent: no name, date of birth or contact details. The model can only raise a check-in to "needs a look"; a failure leaves the rules' answer. Switching it on sends patient free text to the model vendor, so the privacy notice and DPIA must cover it first.
- **Progress summary.** The "Summarise since the last visit" button sends outcome-measure scores and check-in answers (without identifiers) to the model for a clinician-only summary. It is not stored; the audit log records only that it was run (`progress.summarised`).
- **Migration 0010** adds triage columns to `check_ins` and the clinic setting `ai_triage`.

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
| Reminders not going out | Is the tick running (`DISABLE_BACKGROUND_TICK`, `CRON_SECRET`)? Is a real provider configured (no banner about a development mailer)? Look at the Outbox for the failure code |
| Patient links stopped working | `LINK_SECRET` changed |
| Page loads but buttons do nothing | A Content-Security-Policy block. Check the browser console and `src/lib/csp.ts` |

## What has been tested

- `scripts/backup.sh` and `scripts/restore-verify.sh`: run against a local Postgres 16 with and without encryption. A wrong passphrase, a corrupted file and a backup missing a migration each fail with a clear message.
- Email and text providers: tested against a local SMTP server and a local stand-in for Twilio's API (delivery, wrong password, rejected recipient, no encryption offered, unreachable service, retries). Never against a real provider.
- Card payments: tested against a local stand-in for Stripe's API (link creation, signature checking, once-only recording, unapplied payments, wrong clinic). A local run recorded a signed test notification once and ignored a repeat and a bad signature. Never against Stripe itself.
- Audio capture: tested against a local stand-in for Azure's speech API (request shape, speaker renumbering, failures reduced to a status code) and in a browser with a fake microphone (record, stop, text added, swap labels, a 30 MB upload, wrong type, missing confirmation, signed out). Never against the real service or a real microphone.
- AI assistance: tested with a scripted assistant (what is sent and not sent, approved-only, edit and finalise rules, withdrawal, failure saves nothing, clinic separation, anonymise and export) and in a browser with the demo assistant. The live Anthropic API has not been called for these tasks.
- Progress and check-in triage: tested with a scripted assistant (rules, assistant can only raise, failure falls back, comment-only data sent, owner-only switch, clinic separation) and in a browser with the demo assistant (Check-ins list, chart and table, summary, Settings). The live API has not been called.
- Not yet tested: a managed Postgres, a scheduled job, off-site copy, restore onto a different server, restore timing at real data sizes.
