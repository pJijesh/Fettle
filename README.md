# Fettle

Fettle is a UK practice-management system for physiotherapy and Ayurveda clinics, built to replace TM3, Cliniko and WriteUpp, with the consultation-to-plan workflow at its core. For physiotherapy, one consultation transcript becomes a structured SOAP note and a home exercise programme. For Ayurveda, the practitioner writes a structured record and a treatment plan by hand (no AI drafting). Either way a practitioner reviews it at a single approval gate, and the patient gets a no-login link with a two-tap check-in.

This repository holds the consultation workflow (Phase 0), the diary and front desk (Phase 1), billing, and Ayurveda as a second discipline. It is a pilot-grade prototype, not a certified clinical product, and it is **not ready for real patient data** (see "Before real patients"). The full plan, with what is still to come, is in [docs/PRD.md](docs/PRD.md).

## What is built

| PRD item | What it does |
|---|---|
| E1.9 Accounts and roles | Owner, clinician and reception accounts. Password plus a mandatory authenticator-app code. Sessions stored server-side as hashes, 12-hour expiry, lock-out after five failures |
| E1.8 Patient record | Create, search, edit, duplicate warning, merge (moves appointments, forms and consultations; cannot be undone), every view recorded in the audit log |
| E1.2 Appointments | Types with duration and buffer, working hours per clinician, arrive, complete, did-not-attend, cancel (reason required), move. **The database itself refuses overlapping appointments for a clinician** (triggers), as well as the service code |
| E1.1 Calendar | Day view (everyone side by side) and week view (one clinician). Drag a booked appointment to move it; click empty space to book; working hours shaded; layers for programme reviews due, reported worse pain and notes awaiting approval; colour plus a text label for status |
| E1.3 Online booking | `/book/<clinic>`: type, clinician or "anyone", free times from working hours minus bookings, 2-hour minimum notice |
| E1.4 Client portal | `/portal/<clinic>`: sign in with an emailed one-time code (15 minutes, 5 tries). Patients see their appointments and forms, and change or cancel with 24 hours' notice via a signed link |
| E1.5 Intake forms | Versioned forms with a question builder. A required form blocks "Arrived" unless staff give a reason (which is audited). Returning patients are not asked again for the same version |
| E1.6 Waiting list | When a time is freed, the first five matching people are offered it for 15 minutes; the first to accept gets it (single conditional update). Live offers hold the time against other bookings. Unanswered offers expire and go to the next people |
| E1.7 Messages | Confirmation, reminder (24 hours ahead), cancellation, moved, offer and sign-in code. Queued once each (idempotency keys). Texts only go to patients who agreed. Retries with back-off, gives up after five tries |
| E1.10 Calendar feed | Read-only iCalendar link per clinician, secret URL (hash stored), initials and type only |
| Account recovery | Forgotten password: emailed single-use link, valid for an hour, same answer whether or not the address has an account; it signs the person out everywhere and does not bypass two-step sign-in. Lost phone: ten single-use recovery codes (shown once, stored hashed), or the owner can reset a colleague's two-step sign-in |
| Reports | Appointments, seen, did-not-attend and cancellation rates, bookings by source and type, new patients, and per-clinician utilisation for any date range up to a year, in the clinic's time zone. Counts only; no patient is named |
| Billing | A price on each appointment type; an invoice from an attended appointment in one click, or written by hand; payment recorded by method (cash, card, bank transfer, cheque, insurer) as it comes in, in part or in full; an Outstanding list; patient balance; printable invoice and credit note; revenue, collected-by-method, owed and overdue in Reports. Numbers run without gaps (`INV-000001`, credit notes `CN-000001`). When VAT is charged the clinic's VAT registration number is required (checked with HMRC's modulus-97 test), is kept on each invoice as issued and printed on it. Invoices, lines and payments are append-only in the database: a mistake is cancelled with a credit note (only once nothing is paid on it) and a wrong payment is reversed, and both stay on the record. VAT at one rate set in Settings. Owner and reception only |
| Ayurveda | A clinic chooses physiotherapy, Ayurveda or both (Settings, or at setup). Each appointment type and consultation belongs to one discipline; the diary, patients, billing, patient link and check-in are shared. An Ayurvedic consultation has the same consent, approval and frozen-snapshot steps, but the practitioner writes it (no AI drafting, no transcript): history, medicines and allergies, constitution (prakriti), current imbalance (vikriti), agni and ama, examination, a safety screen, and a treatment plan of therapies, herbs, diet and daily routine. Approval needs the practitioner's qualification, the safety screen, medicines, allergies and (for herbs) instructions, duration and cautions. The patient sees the plan grouped by kind on the same no-login link |
| Note templates | A clinic (owner or clinician) keeps reusable starting structures for a physiotherapy note: which range-of-movement rows, outcome measures and special tests to prompt for, and standard wording. On the review screen the physio adds one to the draft; it fills only empty boxes and adds rows not already there, and never changes what is written. A template cannot hold a value, score, result or problem and never ticks red flag screening. Three example templates (lumbar, shoulder, follow-up) are offered and have not been clinically reviewed |
| AI assistance (letters, summaries, checks, codes) | From an **approved** physiotherapy note the AI assistant drafts a GP update, referral or discharge letter and a plain-English (or other language, at two reading levels) summary for the patient; the practitioner edits and **finalises** each one, a summary then appears on the patient's link and can be withdrawn, and nothing is sent automatically. **Check this note** runs plain checks (template rows left empty, a pain score mentioned but not recorded, no review time) plus an AI second reader that must cite transcript lines; it is advice only and never blocks approval. **Diagnosis-code suggestions** (ICD-10, up to three, format-checked) help with insurance claims. Names, dates of birth and contact details are never sent to the model. Uses `AI_PROVIDER` (demo by default, labelled); **not exercised against the live API**; other-language summaries need a fluent speaker to check them. Ayurveda records stay free of AI |
| Patient data rights | Owner-only download of everything held about a patient (record, appointments, forms, consultations, invoices, messages, who has viewed the record) as JSON, audited. "Remove their identity" keeps the clinical and financial record but removes name, contact details, date of birth, GP, address, consent marks, portal sign-ins, patient links and transcripts; refused while an appointment is coming up, and before the retention date unless the owner gives a written reason. A retention period per clinic (default 8 years after last activity, or the child's 25th birthday if later) with a list of people past it. Transcripts of approved consultations are cleared after 30 days (`TRANSCRIPT_RETENTION_DAYS`) |
| Operations | `GET /api/health` reports whether the app can reach its database. Logs are one JSON object per line; errors carry a code and call stack only, because database messages can quote patient data. `scripts/backup.sh` (consistent, optionally encrypted, checksummed) and `scripts/restore-verify.sh` (restores into a throwaway database and checks migrations, row-level security and data). Runbook in [docs/OPERATIONS.md](docs/OPERATIONS.md). `npm audit` runs in CI |
| Browser security | A Content-Security-Policy with a fresh script nonce on every page (injected scripts and inline handlers are blocked), HSTS and `upgrade-insecure-requests` when served over https, Permissions-Policy switching off camera, microphone, location and payment, frame denial |
| E1.11 Switching import | Patients and appointments from **CSV or Excel (.xlsx)** from TM3, Cliniko, WriteUpp or anything else. Per-system export guidance, downloadable templates, and a **column check** where you choose which column goes into which field. Dry run that executes the real import and rolls it back, then confirm, then undo for 7 days. Consent is never imported |

## Run it

Needs Node 22.13 or later and Postgres 16 or later (Docker is the easiest way to get one locally).

```bash
npm install
cp .env.example .env.local     # set LINK_SECRET (and APP_BASE_URL outside localhost)
npm run db:up                  # starts Postgres in Docker and applies db/migrations
npm run dev                    # http://localhost:3000, goes to /setup on first run
npm test                       # 263 tests, against a real Postgres (see below)
npm run typecheck
npm run build && npm start
```

First run: `/setup` creates the clinic and its owner, asks whether the clinic practises physiotherapy, Ayurveda or both, and adds default appointment types for each (physiotherapy: Initial assessment, Follow-up, Review; Ayurveda: Initial Ayurvedic consultation, Ayurvedic follow-up, Ayurvedic therapy session), Monday to Friday 09:00 to 17:00 hours, and a starter intake form. Then set up two-step sign-in with an authenticator app. Add staff under Settings. Online booking is at `/book/<clinic-slug>` and the portal at `/portal/<clinic-slug>`.

A background tick runs every 30 seconds inside the app (reminders, waiting-list expiry, message delivery). To run it from an external scheduler instead, set `DISABLE_BACKGROUND_TICK=1` and `CRON_SECRET`, and call `POST /api/worker` with `Authorization: Bearer <CRON_SECRET>`.

## Database

Postgres holds everything. Two roles are used:

| Role | Used for | Env var |
|---|---|---|
| Owner (for example `postgres`) | `npm run db:migrate` only: creates tables, policies and the `fettle_app` role | `DATABASE_OWNER_URL` |
| `fettle_app` | The running app. Not a superuser, owns nothing, cannot bypass row-level security | `DATABASE_URL` |

The migration creates `fettle_app` without a login. Give it one before first use: `ALTER ROLE fettle_app LOGIN PASSWORD '...'` (`npm run db:up` does this for local development through `db/dev-init.sql`). Never run the app as the owner: that would switch row-level security off.

Tests need a Postgres superuser connection (`TEST_DATABASE_URL`, default `postgres://postgres@127.0.0.1:54329/postgres`; with `npm run db:up` set it to `postgres://postgres:postgres@127.0.0.1:5432/postgres`). They build one migrated template database and clone it per test, then drop the clones.

## What is real and what is not

| Area | State |
|---|---|
| Consent gate, approval gate, immutable approved snapshot with hash, audit log (Phase 0) | Built and tested |
| Diary, double-booking protection, time zones (including both clock changes) | Built and tested. Times are stored in UTC and shown in the clinic's zone (Europe/London) |
| **Email and text sending** | **Built and tested against local stand-ins, never against a real provider.** Email goes through any SMTP service (`SMTP_*` settings; port 587 refuses to send unencrypted) and texts through Twilio (`TWILIO_*`), chosen from the environment. With nothing set the development mailer is used: it sends nothing, the Outbox page lists the messages and a banner says so on every staff page. A half-filled configuration stops the app at start-up. Provider errors are stored as a status code only, because providers repeat the address. **Still needed: a provider contract, a UK data-processing agreement, a verified sender domain (SPF, DKIM, DMARC), and a first real send** |
| **Tenancy** | Postgres row-level security: every query runs in a transaction that names one clinic, the app connects as a role that cannot bypass the policies, and a query that forgets its `WHERE clinic_id` still sees only its own clinic (tested at the database and through the service). Patient links and tokens find their clinic through narrow lookup functions. Backup and restore-verify scripts are written and tested against a local Postgres. **Not yet done: a UK-region managed database, scheduled and off-site backups, and a restore drill on the real host. A gate item before real data** |
| **Import** | CSV and Excel through a column check you can correct by hand. None of the three vendors publish their column headings, so **nothing has been checked against a real Cliniko, TM3 or WriteUpp export**. **TM3's own data extraction (a `tmBase` folder) cannot be read**; a sample would be needed to build and test a reader. Treatment notes, documents, invoices and consent are not imported |
| Drafting | **Mock provider by default** (a keyword matcher, labelled as not clinical). `AI_PROVIDER=anthropic` is available but **has not been exercised against the live API** |
| Cliniko write-back | **Payload unverified against the live API.** Idempotent; an uncertain outcome stops at "needs check" and asks a person |
| Rate limiting | Shared through Postgres, so it holds across several app instances. Keys are stored hashed |
| Audio capture and transcription | Built, **off unless `SPEECH_PROVIDER` is set**. Record in the browser (or upload an audio file) after consent and an explicit recording confirmation; the audio is turned into text by Azure AI Speech and **never stored by Fettle**, only the text. **Tested only against a local stand-in for Azure (never the real service)**, and the physio must check the text and who said what before drafting. Typing or pasting still works |
| Exercise catalogue, intake form, default hours | Starter content. A clinical lead should review before use |
| **Billing** | Records what was charged and paid; it does not take money. **Card payments through Stripe are built and tested only against a local stand-in for Stripe (never against Stripe itself)**: an invoice page makes a payment link for the balance, the patient pays on Stripe's page, and a signed webhook records the payment once. Refunds are not automatic: refund in the Stripe dashboard, then reverse the payment in Fettle. **No insurer claim submission** (insurer name and claim reference are recorded on the invoice, nothing is sent). One VAT rate for the whole invoice; no per-item exemptions. Fettle does not send refunds: you pay the person back yourself, then reverse the payment with the reason. The VAT number is checked for format only, not against HMRC. Whether the invoice wording meets your accountant's and any insurer's requirements has not been checked |
| **Ayurveda content** | **Starter library not reviewed by a qualified Ayurvedic practitioner** (the app says so where it is used). It holds therapies, diet and daily routine only: **no herbs and no doses**, which the practitioner writes and owns. Intensive cleansing procedures are left out. Ayurveda is not a regulated profession in the UK; the clinic is responsible for who practises, for the legal status of any herbal product supplied, and for herb-drug interaction checks. The Ayurveda starter intake form (medicines, herbal products, allergies, pregnancy, digestion, sleep) is likewise unreviewed. Forms can be limited to one discipline, so Ayurveda patients are not sent the physiotherapy pain and numbness questions. Write-back to Cliniko sends the note as text |
| Mobile apps | Later phases (see [docs/PRD.md](docs/PRD.md)) |

## Checked

- 263 automated tests, each in its own fresh Postgres database under the same row-level security as production: domain rules, accounts and second factor, clock-change days, overlap protection (service and database), truly concurrent booking, clinic separation (database policies and service calls), online booking, manage links, forms, portal codes, waiting list (first accept wins, expiry, matching), outbox idempotency and retries, reminders, calendar feed, import with dry run, column mapping, Excel and undo.
- Browser walkthrough of the data-rights screens (download, anonymise with and without override, retention page), the VAT number rules and invoice, and every page checked for Content-Security-Policy violations, plus a check that an injected script and inline handler are blocked. Backup and restore-verify run with and without encryption, and fail clearly on a wrong passphrase, a corrupted file and a missing migration.
- Browser walkthroughs of billing (invoice, part payment, overpayment refused, reversal, credit note) and Ayurveda (consent, refused when incomplete, approval, patient plan on a phone, check-in).
- Browser walkthrough of every Phase 1 screen: first-run set-up and two-step sign-in, booking and portal as a patient on a phone, drag-and-drop on the calendar, role restrictions (reception cannot reach settings, consultations, import or the outbox), lock-out.
- Automated accessibility scan (axe, WCAG 2.1 AA and best practice) on every page in light and dark, at 390 px and desktop widths, with no violations. This does not replace a manual screen-reader and keyboard review.

## Before real patients

- UK/EU hosting and a data-processing agreement with every sub-processor (email and text provider, AI vendor, host).
- A UK-region managed Postgres (the schema and policies are done), scheduled off-site backups, and a restore drill on that host (the scripts are done).
- A written retention and deletion policy for the clinic (the export, anonymise and retention tools are built; the policy and the decision on how long to keep records are the clinic's), and a way to tell patients that backups still hold their data until they age out.
- Clinical review of the physiotherapy exercise catalogue and, separately, of the Ayurvedic starter library by a qualified Ayurvedic practitioner.
- Billing checked by an accountant, including VAT invoice requirements.
- DPIA, DTAC and clinical safety (DCB0129) work, and an MHRA intended-purpose analysis.
- Clinical review of the prompt, catalogue, starter intake form and safety wording.
- A real email and text provider (the code is ready), a sender domain, and a first real send to check delivery and spam placement.
- Import checked against real exports from each system you are switching from.
- Manual accessibility review and penetration test.
- Error reporting and uptime alerting wired to the JSON logs and `/api/health`.

## Layout

- `docs/PRD.md`: the product requirements, with status of every requirement and the roadmap.
- `db/migrations/`: the schema, row-level security policies, the overlap constraint and the `fettle_app` role. `src/lib/db.ts`: the clinic-scoped transaction layer. `src/lib/migrate.ts`: the migration runner.
- `src/lib/accounts.ts`, `crypto.ts`, `auth.ts`: users, sessions, two-step sign-in.
- `src/lib/scheduling.ts`: patients, types, hours, availability, appointments, calendar markers.
- `src/lib/mail/` (SMTP, Twilio and provider choice), `src/lib/payments/` (Stripe links and webhook), `src/lib/forms.ts`, `booking.ts`, `waitlist.ts`, `outbox.ts`, `notify.ts`, `ical.ts`, `importer.ts`, `seed.ts`: the rest of Phase 1. `platform.ts` wires them together.
- `src/lib/service.ts`, `ai/`, `writeback/`: the consultation workflow (consent, drafting for physiotherapy, approval, patient link, check-in, write-back). `ayurveda/`: the Ayurvedic record and plan shapes, starter library, approval rules and note formatting.
- `src/lib/billing.ts`, `money.ts`, `vat.ts`: invoices, payments, credit notes, figures and VAT number checks. `reports.ts`: practice figures. `records.ts`: patient export, anonymisation, retention.
- `src/proxy.ts`, `src/lib/csp.ts`: the Content-Security-Policy and security headers. `src/lib/log.ts`: JSON logging. `scripts/backup.sh`, `scripts/restore-verify.sh` and `docs/OPERATIONS.md`: backups and the runbook.
- `src/app/`: pages and server actions (`actions/` for the diary, billing and settings).
- `tests/`: unit and domain tests, including `billing.test.ts`, `ayurveda.test.ts`, `records.test.ts`, `csp.test.ts`, `hardening.test.ts` and `rls.test.ts` (database isolation).
