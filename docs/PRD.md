# Fettle: Product Requirements Document

Version 3 · October 2026 · Owner: Jijesh P.

This document says what Fettle is for, who it is for, what it must do, and what is built, in progress and not yet started. It replaces the earlier PRD v2. The README describes how to run the code; this describes what the product is meant to be. Where the two overlap, the README's "What is real and what is not" is the more cautious statement of fact.

Status key: **Built** (in `main`, tested) · **In progress** · **Not built** · **Needs others** (cannot be closed by code alone).

---

## 1. Summary

Fettle is a UK practice-management system for small physiotherapy and Ayurveda clinics. It is an alternative to TM3, Cliniko and WriteUpp.

Its core is a loop that those products treat as an afterthought:

> consultation → structured record → treatment plan → one practitioner approval → patient link → two-tap check-in → the next consultation

Around that loop sit the things a clinic cannot run without: a diary, online booking, intake forms, a waiting list, reminders, billing and a way to leave the old system.

### Why it can win

- **Notes and plan are one job.** In physiotherapy a transcript becomes a SOAP note and a home exercise programme in one step. The practitioner reviews, edits and approves once.
- **One approval gate.** Nothing reaches a patient and nothing is frozen into the record without a named practitioner approving it. The approved version is an immutable snapshot with a content hash.
- **No-login patient link.** The patient opens a signed link on a phone, sees the plan in plain language, and reports how they are in two taps. No app, no password.
- **Two disciplines, one product.** Ayurveda clinics are poorly served by the incumbents. Fettle treats it as a first-class discipline with its own record, not a relabelled physio form.
- **Safe by construction.** Tenancy, double-booking protection and the append-only financial record are enforced by the database, not only by application code.

### What it is not

Fettle is not a certified medical device, not a payments processor, and not a replacement for clinical judgement. It drafts for physiotherapists; it does not diagnose. It does not draft for Ayurveda at all.

---

## 2. Users

| Role | Who | What they need |
|---|---|---|
| **Owner** | Clinic principal | Everything: settings, staff, billing, reports, import, records and data rights |
| **Clinician** | Physiotherapist or Ayurvedic practitioner | Their diary, their patients, consultations and approvals. No billing |
| **Reception** | Front-desk staff | Diary, patients, forms, waiting list, billing. No clinical notes, no settings |
| **Patient** | Person being treated | Book, change or cancel, fill in forms once, see their plan, say how they are. Without creating an account |

### Primary segment

Independent clinics of one to ten practitioners in the UK, currently on TM3, Cliniko or WriteUpp, or on paper and spreadsheets. Physiotherapy first; Ayurveda clinics and mixed clinics second.

### Out of scope for now

Hospital and NHS-trust deployments, multi-site chains with central billing, practitioners outside the UK, and any discipline other than physiotherapy and Ayurveda.

---

## 3. Goals and measures

| Goal | Measure |
|---|---|
| A practitioner finishes a physio note and plan faster than in their current system | Median time from "consent given" to "approved" under 5 minutes in a pilot |
| Patients actually use the plan | At least 60% of approved plans opened; at least 40% of opened plans followed by a check-in |
| The diary is trusted | Zero double bookings; no-show rate falls against the clinic's baseline |
| Switching is painless | A clinic's patients and appointments imported in one sitting, with a dry run first |
| Nothing leaks | Zero cross-clinic reads (tested continuously); every record view audited |

These are targets for a pilot, not claims. No pilot has run yet.

---

## 4. Functional requirements

### 4.1 Consultation workflow (Phase 0)

| ID | Requirement | Status |
|---|---|---|
| C1 | Record consent before any drafting or recording. Without consent, no transcript is processed | Built |
| C2 | **Physiotherapy:** from a pasted or typed transcript, draft a SOAP note and a home exercise programme from a clinic-reviewed catalogue | Built (mock provider by default) |
| C3 | The practitioner edits every field. Nothing is final until approved | Built |
| C4 | **Single approval gate.** Approving freezes note and plan as one snapshot with a content hash, attributed to the approving user and time. A later edit creates a new version; the old one stays | Built |
| C5 | Signed, expiring, revocable patient link showing the plan in plain language | Built |
| C6 | Two-tap check-in from the link (how the pain or symptoms are, and whether the plan is being followed). Worse-than-before surfaces on the calendar | Built |
| C7 | Optional write-back of the approved note to Cliniko. Idempotent; an uncertain outcome stops for a person to check | Built (unverified against the live API) |
| C8 | Audio capture and transcription inside the app | Not built |
| C9 | Note templates beyond the default structure | Not built |
| C10 | Live AI drafting using the Anthropic provider | Built, never run live |

### 4.2 Ayurveda

| ID | Requirement | Status |
|---|---|---|
| A1 | A clinic chooses physiotherapy, Ayurveda or both, at setup or later in Settings | Built |
| A2 | Appointment types and consultations belong to one discipline; diary, patients, billing, link and check-in are shared | Built |
| A3 | Structured practitioner-written record: history, medicines, allergies, prakriti, vikriti, agni and ama, examination, safety screen | Built |
| A4 | Treatment plan of therapies, herbs, diet and daily routine, with a starter library for therapies, diet and routine | Built |
| A5 | No AI drafting and no transcript. The practitioner writes the record | Built (by design) |
| A6 | Approval requires qualification, safety screen, medicines and allergies; herbs additionally need instructions, duration and cautions | Built |
| A7 | **No herbs and no doses in the starter library.** The practitioner enters and owns them | Built (by design) |
| A8 | Ayurveda-specific intake form, and forms that can be limited to one discipline | Built (starter content unreviewed) |
| A9 | Review of the starter library by a qualified Ayurvedic practitioner | Needs others |

Ayurveda is not a regulated profession in the UK. The product records who practised and what they wrote; the clinic is responsible for who practises, the legal status of any herbal product supplied and herb-drug interaction checks. The app says so where it is used.

### 4.3 Diary and front desk (Phase 1)

| ID | Requirement | Status |
|---|---|---|
| D1 | Appointment types with duration, buffer, price and discipline | Built |
| D2 | Working hours per clinician; availability is hours minus bookings | Built |
| D3 | Day view (all clinicians side by side) and week view (one clinician); drag to move; click to book; status shown by colour and text | Built |
| D4 | **The database refuses overlapping appointments for a clinician** (triggers) as well as the service code. Times stored in UTC, shown in the clinic's zone, correct across both clock changes | Built |
| D5 | Arrive, complete, did-not-attend, cancel (reason required), move | Built |
| D6 | Online booking at `/book/<clinic>`: type, clinician or anyone, free times, 2-hour minimum notice | Built |
| D7 | Client portal at `/portal/<clinic>`: emailed one-time code, see appointments and forms, change or cancel with 24 hours' notice | Built |
| D8 | Versioned intake forms with a question builder. A required form blocks "Arrived" unless staff give an audited reason; returning patients are not re-asked for the same version | Built |
| D9 | Waiting list: freed times offered to the first five matches for 15 minutes; first to accept wins; offers hold the time | Built |
| D10 | Messages: confirmation, reminder (24 h), cancellation, moved, offer, sign-in code. Idempotent; text only to patients who agreed; back-off, five tries | Built |
| D11 | Read-only calendar feed per clinician, secret URL, initials and type only | Built |
| D12 | **Real email and text delivery**: email through any SMTP service, texts through Twilio, chosen by environment | Built, tested against local stand-ins only. Needs a provider contract, DPA and sender domain |
| D13 | Practice reports: attendance, did-not-attend, cancellation, new patients, utilisation, bookings by source; counts only | Built |

### 4.4 Patients and records

| ID | Requirement | Status |
|---|---|---|
| P1 | Create, search, edit; duplicate warning; merge (irreversible) | Built |
| P2 | Every view of a patient record is written to the audit log | Built |
| P3 | **Patient export:** a full copy of what the clinic holds (patient, appointments, forms, consultations, invoices, messages, access log), owner only, audited | Built |
| P4 | **Anonymisation:** identity removed, clinical and financial history kept for the retention period, refused if the patient has upcoming appointments or retention has not ended without a written override reason | Built |
| P5 | **Retention:** a per-clinic retention period (default 8 years after last activity, or the child's 25th birthday if later), a list of patients due for review, and a purge of old transcripts | Built |

### 4.5 Billing

| ID | Requirement | Status |
|---|---|---|
| B1 | A price on each appointment type; invoice from an attended appointment in one click, or by hand | Built |
| B2 | Payments by method (cash, card, bank transfer, cheque, insurer), in part or in full; overpayment refused | Built |
| B3 | Gapless numbering: `INV-000001`, credit notes `CN-000001` | Built |
| B4 | **Append-only.** Invoices, lines and payments cannot be updated or deleted by the app role. A mistake is cancelled with a credit note (only when nothing is paid); a wrong payment is reversed by a negative row, once | Built |
| B5 | Outstanding list, patient balance, printable invoice and credit note | Built |
| B6 | VAT at one rate for the whole invoice | Built |
| B7 | **VAT registration number** required when VAT is charged, validated, and printed on invoices | Built |
| B8 | Refund wording: Fettle records money and does not send it; how "reverse" and "credit note" are used | Built |
| B9 | Card payments (Stripe): a payment link per invoice, recorded once by a signed webhook | Built, tested against a stand-in for Stripe only. Needs a Stripe account, a sub-processor agreement and a live test payment |
| B10 | Insurer claim submission (currently only the insurer and claim reference are recorded) | Not built |
| B11 | Accountant review of invoice wording and VAT handling | Needs others |

Access to billing is owner and reception only. Clinicians are denied.

### 4.6 Switching

| ID | Requirement | Status |
|---|---|---|
| S1 | Import patients and appointments from CSV or Excel, from any system | Built |
| S2 | Per-system export guidance, downloadable templates, a column check where the user maps columns to fields | Built |
| S3 | Dry run that executes the real import and rolls it back; confirm; undo for 7 days | Built |
| S4 | Consent is never imported | Built (by design) |
| S5 | Verified against real Cliniko, TM3 and WriteUpp exports | Not built. None of the vendors publish their headings |
| S6 | Reading TM3's own extraction folder | Not built; needs a sample |
| S7 | Import of treatment notes, documents and invoices | Not built |

### 4.7 Accounts and access

| ID | Requirement | Status |
|---|---|---|
| U1 | Owner, clinician and reception roles | Built |
| U2 | Password plus mandatory authenticator-app code; server-side sessions stored as hashes, 12-hour expiry; lock-out after five failures | Built |
| U3 | Forgotten password: single-use link, one hour, same answer whether or not the address has an account; signs out everywhere | Built |
| U4 | Lost phone: ten single-use recovery codes (shown once, stored hashed) or an owner reset | Built |
| U5 | Rate limiting shared through Postgres, keys hashed | Built |

---

## 5. Non-functional requirements

### 5.1 Security and tenancy

- **Row-level security.** Every query runs in a transaction that names one clinic. The app connects as `fettle_app`, which is not a superuser, owns nothing, and cannot bypass the policies. A query that forgets `WHERE clinic_id` still sees only its own clinic. Tested at the database and through the service. **Built.**
- **Append-only tables.** `audit_log`, `invoices`, `invoice_lines` and `payments` have no UPDATE or DELETE for the app role. **Built.**
- **Secrets at rest.** Session tokens, rate-limit keys, calendar-feed secrets, recovery codes and password-reset tokens are stored hashed. **Built.**
- **Errors.** Logged by code, constraint and stack only, because database messages can quote patient data. **Built.**
- **Browser protections.** `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, no `X-Powered-By`. **Built.** A Content-Security-Policy with a per-request nonce, HSTS on HTTPS, a Permissions-Policy and Cross-Origin-Opener-Policy. **Built.**
- **Penetration test.** **Needs others.**

### 5.2 Reliability and operations

- `GET /api/health` reports database reachability. **Built.**
- Background tick (reminders, waiting-list expiry, outbox delivery) every 30 seconds, or an external scheduler via `POST /api/worker` with a bearer secret. **Built.**
- Structured JSON logs. **Built.**
- Backup and restore-verify scripts (encrypted, checksummed; restore checks migrations, row-level security and data), an operations runbook ([OPERATIONS.md](OPERATIONS.md)), and `npm audit` in CI. **Built**, tested on a local Postgres only.
- A UK-region managed Postgres with backups and a tested restore. **Not built; a gate item.**
- Error reporting service and uptime alerting. **Not built.**

### 5.3 Accessibility and design

- WCAG 2.1 AA target. Automated axe scan on every page, light and dark, at 390 px and desktop, currently with no violations. **Built.**
- Status is never colour alone. **Built.**
- Patient pages work on a phone with no login. **Built.**
- Manual screen-reader and keyboard review. **Needs others.**

### 5.4 Data protection

- UK GDPR: Fettle is a processor for the clinic, which is the controller. The clinic must hold a data-processing agreement with every sub-processor (host, email and text provider, AI vendor).
- Health data is special-category data. Consent and access are enforced in the product (C1, P2); lawful basis, DPIA and retention policy are the clinic's, with the product providing the mechanisms (P3 to P5).
- Patient-facing messages carry no clinical content, only time, place and a link.
- Text messages go only to patients who agreed.

### 5.5 Regulatory

| Item | Position |
|---|---|
| MHRA | Physio drafting could be argued to be software with a medical purpose. An intended-purpose analysis is needed before the AI provider is live. **Needs others** |
| DCB0129 clinical safety | Required for health software used in NHS-commissioned settings and good practice elsewhere. **Needs others** |
| DTAC | Required to sell to the NHS; useful evidence otherwise. **Needs others** |
| DPIA | Required before processing real patient data. **Needs others** |
| Clinical review | Physio exercise catalogue, prompt, starter intake form and safety wording; separately, the Ayurveda starter library. **Needs others** |

---

## 6. Technical overview

| Layer | Choice |
|---|---|
| App | Next.js 16 App Router, server actions, React 19, TypeScript |
| Validation | Zod 4 |
| Database | PostgreSQL 16 with row-level security, advisory locks for invoicing, triggers for overlap |
| Access | `pg` through a clinic-scoped transaction layer (`scope`, `scopeOrFail`, `system`, `lock`) |
| Tests | Vitest 5 against a real Postgres, one fresh cloned database per test |
| Browser checks | Playwright; axe for accessibility |
| Money | Whole pence everywhere |
| Drafting | Provider interface: a labelled mock by default; Anthropic available |

Migrations: 0001 schema, 0002 hardening, 0003 billing, 0004 Ayurveda, 0005 records and VAT number, 0006 form discipline, 0007 card payment ids.

Repository layout is in the README.

---

## 7. Status and roadmap

### Done and merged to `main`

Consultation workflow · diary and front desk · row-level security on Postgres 16 · hardening (rate limiting, password reset, recovery codes, reports, health) · billing · Ayurveda as a second discipline. 177 automated tests passed at that point.

### Gap fixes (merged, PR #5)

Patient export, anonymisation and retention (P3 to P5) · Content-Security-Policy, HSTS, Permissions-Policy · structured logs, backup and restore-verify scripts, runbook, `npm audit` in CI · VAT registration number on invoices and refund wording. 224 tests pass.

### Next, in order

| Step | What | Depends on |
|---|---|---|
| 1 | UK-region managed Postgres, backups, restore drill | Choosing a host; the owner's approval before any project is created |
| 2 | Real email and text provider | Contract, sender domain, UK data-processing agreement |
| 3 | Live check of the Anthropic provider and Cliniko write-back | Credentials; a test account |
| 4 | Import tried on real exports | Samples from at least one clinic |
| 5 | Clinical review of the physio catalogue and the Ayurveda library | Qualified reviewers |
| 6 | Closed pilot with one or two clinics, then a load test | Steps 1 to 5 |
| 7 | DPIA, DCB0129, DTAC, MHRA analysis, penetration test, manual accessibility review | A pilot to learn from |
| 8 | Card payments (Stripe), insurer claim submission | Accounts; demand from the pilot |
| 9 | Note templates, audio capture, mobile apps | Pilot feedback |

### Gate to real patient data

Real patient data must not be entered until steps 1, 2 and 5 are done and the DPIA is signed. This is also in the README under "Before real patients".

---

## 8. Risks

| Risk | Effect | Response |
|---|---|---|
| Regulators treat the physio drafting as a medical device | Cannot sell until compliant | Intended-purpose analysis early; the practitioner approval gate and "draft" labelling stay |
| Starter clinical content is wrong or unsafe | Harm to a patient | Clinical review is a gate; the Ayurveda library has no herbs or doses; content is flagged as unreviewed in the app |
| Import fails on real exports | Clinics cannot switch | Column mapping by hand, dry run, undo; collect real samples in the pilot |
| A cross-clinic leak | Loss of trust, ICO action | Row-level security, tested at the database; penetration test before launch |
| Incumbents match the workflow | Lost differentiation | Move on Ayurveda and the patient link, where they are weakest |
| Messages not delivered | Missed appointments | Idempotent queue, retries, failure visible in the Outbox; real provider is a gate item |
| Solo build | Slow, single point of failure | Keep scope tight; tests as the safety net; documented runbook |

---

## 9. Open questions

1. Which UK-region host for Postgres? (Supabase London, a UK cloud region, or another.)
2. Which email and text provider?
3. Will the first pilot clinic be physiotherapy, Ayurveda or mixed?
4. Pricing model: per practitioner per month, with a free import?
5. Should patient export be available to patients directly, or only through the clinic? Currently clinic-only.
6. Is card payment a launch requirement or can the pilot run on recorded payments?
