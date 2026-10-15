# Fettle (Phase 1)

Fettle is a UK practice-management system for physiotherapy clinics, built to replace TM3, Cliniko and WriteUpp, with the consultation-to-programme workflow at its core: one consultation transcript becomes a structured SOAP note and a home exercise programme, a physio reviews both at a single approval gate, and the patient gets a no-login link with a two-tap check-in.

This repository holds **Phase 0** (the consultation workflow) and **Phase 1** (the diary and front desk). It is a pilot-grade prototype, not a certified clinical product. The full plan, with what is still to come, is in the PRD (v2).

## What Phase 1 adds

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
| Billing | A price on each appointment type; an invoice from an attended appointment in one click, or written by hand; payment recorded by method (cash, card, bank transfer, cheque, insurer) as it comes in, in part or in full; an Outstanding list; patient balance; printable invoice and credit note; revenue, collected-by-method, owed and overdue in Reports. Numbers run without gaps (`INV-000001`, credit notes `CN-000001`). Invoices, lines and payments are append-only in the database: a mistake is cancelled with a credit note (only once nothing is paid on it) and a wrong payment is reversed, and both stay on the record. VAT at one rate set in Settings. Owner and reception only |
| Ayurveda | A clinic chooses physiotherapy, Ayurveda or both (Settings, or at setup). Each appointment type and consultation belongs to one discipline; the diary, patients, billing, patient link and check-in are shared. An Ayurvedic consultation has the same consent, approval and frozen-snapshot steps, but the practitioner writes it (no AI drafting, no transcript): history, medicines and allergies, constitution (prakriti), current imbalance (vikriti), agni and ama, examination, a safety screen, and a treatment plan of therapies, herbs, diet and daily routine. Approval needs the practitioner's qualification, the safety screen, medicines, allergies and (for herbs) instructions, duration and cautions. The patient sees the plan grouped by kind on the same no-login link |
| Operations | `GET /api/health` reports whether the app can reach its database. Errors are logged by code and call stack only, because database messages can quote patient data |
| E1.11 Switching import | Patients and appointments from **CSV or Excel (.xlsx)** from TM3, Cliniko, WriteUpp or anything else. Per-system export guidance, downloadable templates, and a **column check** where you choose which column goes into which field. Dry run that executes the real import and rolls it back, then confirm, then undo for 7 days. Consent is never imported |

## Run it

Needs Node 22.13 or later and Postgres 16 or later (Docker is the easiest way to get one locally).

```bash
npm install
cp .env.example .env.local     # set LINK_SECRET (and APP_BASE_URL outside localhost)
npm run db:up                  # starts Postgres in Docker and applies db/migrations
npm run dev                    # http://localhost:3000, goes to /setup on first run
npm test                       # 177 tests, against a real Postgres (see below)
npm run typecheck
npm run build && npm start
```

First run: `/setup` creates the clinic and its owner, with default appointment types (Initial assessment, Follow-up, Review), Monday to Friday 09:00 to 17:00 hours, and a starter intake form. Then set up two-step sign-in with an authenticator app. Add staff under Settings. Online booking is at `/book/<clinic-slug>` and the portal at `/portal/<clinic-slug>`.

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
| **Email and text sending** | **Not connected.** A development mailer accepts messages and the Outbox page lists them; nothing leaves the machine, and a banner says so on every staff page. A real provider needs a contract, a sender domain and a UK data-processing agreement, then an implementation of the `Mailer` interface in `src/lib/outbox.ts` |
| **Tenancy** | Postgres row-level security: every query runs in a transaction that names one clinic, the app connects as a role that cannot bypass the policies, and a query that forgets its `WHERE clinic_id` still sees only its own clinic (tested at the database and through the service). Patient links and tokens find their clinic through narrow lookup functions. **Not yet done: a UK-region managed database, backups and restore drills. A gate item before real data** |
| **Import** | CSV and Excel through a column check you can correct by hand. None of the three vendors publish their column headings, so **nothing has been checked against a real Cliniko, TM3 or WriteUpp export**. **TM3's own data extraction (a `tmBase` folder) cannot be read**; a sample would be needed to build and test a reader. Treatment notes, documents, invoices and consent are not imported |
| Drafting | **Mock provider by default** (a keyword matcher, labelled as not clinical). `AI_PROVIDER=anthropic` is available but **has not been exercised against the live API** |
| Cliniko write-back | **Payload unverified against the live API.** Idempotent; an uncertain outcome stops at "needs check" and asks a person |
| Rate limiting | Shared through Postgres, so it holds across several app instances. Keys are stored hashed |
| Audio capture and transcription | Not built. Paste or type the transcript |
| Exercise catalogue, intake form, default hours | Starter content. A clinical lead should review before use |
| **Billing** | Records what was charged and paid; it does not take money. **No card payments** (a Stripe account is needed) and **no insurer claim submission** (insurer name and claim reference are recorded on the invoice, nothing is sent). One VAT rate for the whole invoice; no per-item exemptions. Whether the invoice wording meets your accountant's and any insurer's requirements has not been checked |
| **Ayurveda content** | **Starter library not reviewed by a qualified Ayurvedic practitioner** (the app says so where it is used). It holds therapies, diet and daily routine only: **no herbs and no doses**, which the practitioner writes and owns. Intensive cleansing procedures are left out. Ayurveda is not a regulated profession in the UK; the clinic is responsible for who practises, for the legal status of any herbal product supplied, and for herb-drug interaction checks. No Ayurveda-specific intake form yet; the physio intake form is reused. Write-back to Cliniko sends the note as text |
| Notes templates, mobile apps | Later phases (see the PRD) |

## Checked

- 177 automated tests, each in its own fresh Postgres database under the same row-level security as production: domain rules, accounts and second factor, clock-change days, overlap protection (service and database), truly concurrent booking, clinic separation (database policies and service calls), online booking, manage links, forms, portal codes, waiting list (first accept wins, expiry, matching), outbox idempotency and retries, reminders, calendar feed, import with dry run, column mapping, Excel and undo.
- Browser walkthrough of every screen: first-run set-up and two-step sign-in, booking and portal as a patient on a phone, drag-and-drop on the calendar, role restrictions (reception cannot reach settings, consultations, import or the outbox), lock-out.
- Automated accessibility scan (axe, WCAG 2.1 AA and best practice) on every page in light and dark, at 390 px and desktop widths, with no violations. This does not replace a manual screen-reader and keyboard review.

## Before real patients

- UK/EU hosting and a data-processing agreement with every sub-processor (email and text provider, AI vendor, host).
- A UK-region managed Postgres (the schema and policies are done), backups with a tested restore, retention and deletion policy.
- DPIA, DTAC and clinical safety (DCB0129) work, and an MHRA intended-purpose analysis.
- Clinical review of the prompt, catalogue, starter intake form and safety wording.
- A real email and text provider, then end-to-end tests of delivery.
- Import checked against real exports from each system you are switching from.
- Manual accessibility review and penetration test.

## Layout

- `db/migrations/`: the schema, row-level security policies, the overlap constraint and the `fettle_app` role. `src/lib/db.ts`: the clinic-scoped transaction layer. `src/lib/migrate.ts`: the migration runner.
- `src/lib/accounts.ts`, `crypto.ts`, `auth.ts`: users, sessions, two-step sign-in.
- `src/lib/scheduling.ts`: patients, types, hours, availability, appointments, calendar markers.
- `src/lib/forms.ts`, `booking.ts`, `waitlist.ts`, `outbox.ts`, `notify.ts`, `ical.ts`, `importer.ts`, `seed.ts`: the rest of Phase 1. `platform.ts` wires them together.
- `src/lib/service.ts`, `ai/`, `writeback/`: Phase 0 consultation workflow.
- `src/app/`: pages and server actions (`actions/` for Phase 1).
- `tests/`: unit and domain tests.
