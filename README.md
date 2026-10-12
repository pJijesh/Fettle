# Consult-to-Programme (Phase 1)

A UK practice-management system for physiotherapy clinics, built to replace TM3, Cliniko and WriteUpp, with the consultation-to-programme workflow at its core: one consultation transcript becomes a structured SOAP note and a home exercise programme, a physio reviews both at a single approval gate, and the patient gets a no-login link with a two-tap check-in.

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
| E1.11 Switching import | Patients and appointments from **CSV or Excel (.xlsx)** from TM3, Cliniko, WriteUpp or anything else. Per-system export guidance, downloadable templates, and a **column check** where you choose which column goes into which field. Dry run that executes the real import and rolls it back, then confirm, then undo for 7 days. Consent is never imported |

## Run it

Needs Node 22.13 or later.

```bash
npm install
cp .env.example .env.local     # set LINK_SECRET (and APP_BASE_URL outside localhost)
npm run dev                    # http://localhost:3000, goes to /setup on first run
npm test                       # 98 tests
npm run typecheck
npm run build && npm start
```

First run: `/setup` creates the clinic and its owner, with default appointment types (Initial assessment, Follow-up, Review), Monday to Friday 09:00 to 17:00 hours, and a starter intake form. Then set up two-step sign-in with an authenticator app. Add staff under Settings. Online booking is at `/book/<clinic-slug>` and the portal at `/portal/<clinic-slug>`.

A background tick runs every 30 seconds inside the app (reminders, waiting-list expiry, message delivery). To run it from an external scheduler instead, set `DISABLE_BACKGROUND_TICK=1` and `CRON_SECRET`, and call `POST /api/worker` with `Authorization: Bearer <CRON_SECRET>`.

## What is real and what is not

| Area | State |
|---|---|
| Consent gate, approval gate, immutable approved snapshot with hash, audit log (Phase 0) | Built and tested |
| Diary, double-booking protection, time zones (including both clock changes) | Built and tested. Times are stored in UTC and shown in the clinic's zone (Europe/London) |
| **Email and text sending** | **Not connected.** A development mailer accepts messages and the Outbox page lists them; nothing leaves the machine, and a banner says so on every staff page. A real provider needs a contract, a sender domain and a UK data-processing agreement, then an implementation of the `Mailer` interface in `src/lib/outbox.ts` |
| **Tenancy** | Every query carries a clinic id and cross-clinic tests exist, but this is enforced in application code. **Postgres with row-level security in a UK region is still to do and is a gate item before a second clinic or real data** |
| **Import** | CSV and Excel through a column check you can correct by hand. None of the three vendors publish their column headings, so **nothing has been checked against a real Cliniko, TM3 or WriteUpp export**. **TM3's own data extraction (a `tmBase` folder) cannot be read**; a sample would be needed to build and test a reader. Treatment notes, documents, invoices and consent are not imported |
| Drafting | **Mock provider by default** (a keyword matcher, labelled as not clinical). `AI_PROVIDER=anthropic` is available but **has not been exercised against the live API** |
| Cliniko write-back | **Payload unverified against the live API.** Idempotent; an uncertain outcome stops at "needs check" and asks a person |
| Rate limiting | In memory, one process. Move to a shared store before running more than one instance |
| Audio capture and transcription | Not built. Paste or type the transcript |
| Exercise catalogue, intake form, default hours | Starter content. A clinical lead should review before use |
| Billing, insurers, card payments, notes templates, reports, mobile apps | Later phases (see the PRD) |

## Checked

- 98 automated tests: domain rules, accounts and second factor, clock-change days, overlap protection (service and database), concurrent booking, online booking, manage links, forms, portal codes, waiting list (first accept wins, expiry, matching), outbox idempotency and retries, reminders, calendar feed, import with dry run, column mapping, Excel and undo.
- Browser walkthrough of every screen: first-run set-up and two-step sign-in, booking and portal as a patient on a phone, drag-and-drop on the calendar, role restrictions (reception cannot reach settings, consultations, import or the outbox), lock-out.
- Automated accessibility scan (axe, WCAG 2.1 AA and best practice) on every page in light and dark, at 390 px and desktop widths, with no violations. This does not replace a manual screen-reader and keyboard review.

## Before real patients

- UK/EU hosting and a data-processing agreement with every sub-processor (email and text provider, AI vendor, host).
- Postgres with row-level security (above), backups, retention and deletion policy.
- DPIA, DTAC and clinical safety (DCB0129) work, and an MHRA intended-purpose analysis.
- Clinical review of the prompt, catalogue, starter intake form and safety wording.
- A real email and text provider, then end-to-end tests of delivery.
- Import checked against real exports from each system you are switching from.
- Manual accessibility review and penetration test.

## Layout

- `src/lib/db.ts`: schema, overlap triggers, in-place upgrade from the Phase 0 file.
- `src/lib/accounts.ts`, `crypto.ts`, `auth.ts`: users, sessions, two-step sign-in.
- `src/lib/scheduling.ts`: patients, types, hours, availability, appointments, calendar markers.
- `src/lib/forms.ts`, `booking.ts`, `waitlist.ts`, `outbox.ts`, `notify.ts`, `ical.ts`, `importer.ts`, `seed.ts`: the rest of Phase 1. `platform.ts` wires them together.
- `src/lib/service.ts`, `ai/`, `writeback/`: Phase 0 consultation workflow.
- `src/app/`: pages and server actions (`actions/` for Phase 1).
- `tests/`: unit and domain tests.
