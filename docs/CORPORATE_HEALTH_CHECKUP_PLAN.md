# Corporate Health Checkup — Implementation Plan

**Date:** 2026-08-24
**Status:** PLAN ONLY — nothing implemented. Build starts only on your explicit
go-ahead, one small task at a time.
**First example company:** Synvesia

---

## 1. Scope

What the meeting asked for, end to end:

> Corporate link → select health package → enter phone/email → select appointment
> → save patient data → send confirmation → show appointment in Scribe for OBT
> → OBT confirmation call (3 days before) → send test precautions email.

**Explicitly out of scope for now** (meeting called it a future step): My Health
Genie / Genie Health account for these employees, test results pushed into that
account, app profile.

### Status legend used throughout

- ✅ **CLEAR** — stated in the meeting or forced by existing code. Safe to build when told.
- ⚠️ **NEEDS YOUR DECISION** — I have a recommendation but will not build it until you confirm.
- ⛔ **BLOCKED** — cannot be built at all until something outside the code is provided.

**I will not implement anything marked ⚠️ or ⛔ without you saying so explicitly.**

---

## 2. What already exists (verified in code)

This is not a greenfield build. Most of the machinery is already here:

| Need | Already exists | Where |
|---|---|---|
| Public page, no login | `/visit/:token` patient journey page | `src/router.jsx:126`, `PUBLIC_PATTERNS` in `server/middleware/auth.js:74` |
| Appointment storage | `appointments` table, ~30 booking columns | `server/routes/ghm-appointments.js:968` |
| Patient auto-create on booking | creates `patients` row + allocates `file_no` | `server/routes/ghm-appointments.js:931` |
| Patient email field | `patients.email` column already present | `server/routes/patients.js:486` |
| Slot picker + capacity | `appointment_slots` + availability API | `server/routes/appointment-slots.js:82` |
| Booking guard (holiday / capacity / doctor off) | `checkBookingAvailability()` | `server/services/bookingGuard.js` |
| OBT day list with a 3-days-ahead tab | `/ghm` `VIEW_TABS` (`fu3`, `offset: 3`) | `src/pages/GHMPage.jsx:144` |
| OBT call status vocabulary | one shared source of truth | `shared/callStatuses.js` |
| OBT summary tiles | `/api/obt-dashboard` | `server/routes/obt-dashboard.js` |
| "Called today" resets each round | `callStatusToday()` | `server/services/ghmDayWindow.js:64` |
| RBAC capability for the call team | `OBT_OPS` already defined and wired | `shared/permissions.js`, `server/middleware/auth.js` |

### The one design decision this forces

A corporate checkup booking should be a **normal `appointments` row carrying
corporate metadata** — *not* a parallel booking system.

That way it inherits, with no new code: the GHM sheet, the OBT call list, the
call-status vocabulary, the dashboard tiles, the WATI/Excel exports, the
availability gate, and the patient-flow check-in module.

A separate `corporate_appointments` table would mean re-implementing every one of
those. I recommend against it.

### What is genuinely new code

Only four things:

1. Package catalogue tables (`corporate_companies`, `corporate_packages`, `corporate_package_tests`).
2. Public booking page + public API endpoints.
3. A "Special Test Appointments" view in Scribe for OBT.
4. Email delivery — **there is none in this codebase today.** See §7.

---

## 3. Data model

### 3.1 New tables ✅ CLEAR

```
corporate_companies
  id              serial pk
  slug            text unique         -- 'synvesia' — drives the URL
  name            text                -- 'Synvesia'
  is_active       bool default true
  contact_email   text                -- HR contact
  created_at      timestamptz

corporate_packages
  id              serial pk
  company_id      int fk -> corporate_companies
  name            text                -- '40+ Health Checkup Package'
  description     text
  is_active       bool default true
  sort_order      int

corporate_package_tests
  id              serial pk
  package_id      int fk -> corporate_packages
  test_name       text                -- 'ECG', 'Echo', 'Blood Tests'
  precaution_note text                -- 'Fasting 10-12 hours required'
  sort_order      int
```

`precaution_note` lives on the **test**, not the package, so the precautions
email in §7 is assembled from the tests actually in the employee's package rather
than being hand-written per company.

Migration file convention in this repo: `server/migrations/2026-MM-DD_<name>.sql`,
applied with `server/migrations/_runOne.mjs`.

### 3.2 Marking the appointment as corporate ⚠️ NEEDS YOUR DECISION

The booking must be identifiable as a special/corporate test appointment so OBT
can filter it. Three options:

| Option | How | Trade-off |
|---|---|---|
| **A (recommended)** | New columns `corporate_company_id`, `corporate_package_id` on `appointments` | Clean joins, no string matching, filter is an index lookup. Two nullable columns on a wide table. |
| B | Reuse `booking_source = 'corporate'` + store package name in `misc_notes` | Zero schema change, but package data becomes unqueryable free text and the "which tests" email can't be built reliably. |
| C | Separate `corporate_appointments` table | Loses the whole GHM/OBT/flow inheritance described in §2. |

**My recommendation: A.** Additionally set `booking_source = 'corporate'` and
`visit_type = 'Corporate Health Checkup'` so existing exports and tiles label the
row sensibly without any change to them.

### 3.3 Patient identity ⚠️ NEEDS YOUR DECISION

Existing code matches a patient by phone and creates one if absent
(`ghm-appointments.js:931`). But there is a known trap recorded for this project:
**`file_no` (UHID) is reassigned to different people over time**, so identity must
key on the patient, not the file number.

Question: if an employee's phone already matches an existing hospital patient,
should the booking attach to that existing patient record, or always create a new
one? Attaching is right clinically (their history is one record); creating is
safer against a shared/wrong family phone number.

**My recommendation:** attach when phone **and** name reasonably match, otherwise
create new — same rule the GHM booking path already uses. But confirm, because
this decides whether a corporate employee can see/inherit an existing chart.

---

## 4. Public booking page

### 4.1 URL ✅ DECIDED

**`scribe.geniehealth.com/checkup/:slug`** — e.g. `scribe.geniehealth.com/checkup/synvesia`.

One fixed host for the app; the **company comes from the path segment**, not the
hostname. HR sends the employee the full link.

Why this shape:

- **No wildcard DNS, no wildcard TLS.** A per-company subdomain
  (`synvesia.geniehealth.com`) would need `*.geniehealth.com` plus a wildcard
  cert and a new DNS entry per client signed. A single host needs neither.
- **No new infra at all** if the app already serves on that host — this app
  already serves a public, logged-out page from its own origin
  (`/visit/:token`, `src/router.jsx:126`), so the booking page is just another
  public route beside it.
- **Onboarding a new company is a database row**, not a DNS change.

Slug resolution is therefore a plain route param (`useParams()` →
`GET /api/corporate/:slug`). No host-header parsing anywhere.

> **Note for later:** `scribe.` is the internal staff system's name, and this
> link goes out by email to hundreds of employees at a client company. If that
> ever reads wrong to recipients, a friendlier public host
> (`checkup.geniehealth.com/:slug`) is a DNS + cert change only — **the page and
> API code are identical**, because the slug already comes from the path. Nothing
> built now would need rewriting.

### 4.2 The page ✅ CLEAR

Route: public, unauthenticated, no nav chrome — same shape as the existing
`/visit/:token` page (`src/router.jsx:126`), which is the precedent for a
logged-out patient-facing page in this app.

Steps on the page:

1. Company banner (name from slug). Invalid/inactive slug → a plain "link not
   valid" page, no detail leaked.
1. **Select package** — list of active packages for that company, each expandable
   to show the tests included (ECG, Echo, Blood Tests, …).
2. **Enter phone + email** — the two required fields. Name and date of birth are
   discussed in §9 as an open question.
3. **Select date + time slot** — reads live availability.
5. Review + consent checkbox → Confirm.
6. Confirmation screen showing package, tests, date, slot, and a reference number.

Semantics note per project rules: package cards and slots are `<button>`
elements, the form is a real `<form>` with a submit button — no click-handling
`<div>`s.

### 4.3 Public API endpoints ✅ CLEAR

All must be added to `PUBLIC_PATTERNS` in `server/middleware/auth.js` — the same
allowlist that exposes the flow-tracking page — and to nothing wider.

```
GET  /api/corporate/:slug                    -> company + active packages + tests
GET  /api/corporate/:slug/availability?date= -> open slots for the checkup resource
POST /api/corporate/:slug/book               -> creates patient (if new) + appointment
```

`POST .../book` is a public write, so it carries, in this order: strict
rate-limit (the app already has `ipLimiter`), zod validation (`zod` is already a
dependency), the existing `checkBookingAvailability()` gate, and a duplicate
guard so one employee cannot spam ten bookings.

### 4.4 Which resource/doctor the slot belongs to ⚠️ NEEDS YOUR DECISION

The whole slot system is keyed on `doctor_name`
(`appointment_slots(doctor_name, slot_date, time_slot)`). A health checkup is not
a doctor consultation — it is lab + ECG + Echo capacity.

The repo already has a convention for exactly this: GHM defaults
investigation/lab-test bookings to **"Hospital Admin"** as the doctor
(`GHMPage.jsx:1916`).

**My recommendation:** book corporate checkups against a dedicated pseudo-doctor
resource (e.g. `"Health Checkup"`), with its own configured `appointment_slots`
rows and capacity. That reuses the entire availability stack unchanged.

Open sub-questions I cannot answer from the code:
- How many employees can be processed per 30-minute slot?
- Are checkups limited to certain hours (e.g. morning only, for fasting bloods)?
- Which days of the week?

---

## 5. Booking storage ✅ CLEAR

On successful `POST /book`, in one transaction:

1. Find-or-create the `patients` row (phone match, per §3.3), storing `email`.
2. Insert the `appointments` row: `patient_id`, `patient_name`, `file_no`,
   `phone`, `appointment_date`, `time_slot`, `visit_type = 'Corporate Health
   Checkup'`, `booking_source = 'corporate'`, `corporate_company_id`,
   `corporate_package_id`, `status = 'scheduled'`, `is_walkin = false`.
3. Increment the slot `booked_count`, as the GHM path already does.
4. Return the reference for the confirmation screen.

Nothing here is new logic — it mirrors `server/routes/ghm-appointments.js:931-1030`.
Per the project's reuse rule, the shared parts should be **extracted into a
service** both paths call, not copy-pasted.

---

## 6. Scribe / OBT integration

### 6.1 Where OBT sees these ⚠️ NEEDS YOUR DECISION

| Option | What it means |
|---|---|
| **A (recommended)** | A new **"Special Tests"** tab in the existing `/ghm` page's `VIEW_TABS`, filtered to `booking_source = 'corporate'` |
| B | A brand-new standalone page |

A is strongly preferred: `VIEW_TABS` (`GHMPage.jsx:144`) is already a
capability-gated tab list, and the table below it already renders call status,
call-attempt logging, the live "on call now" claim that stops two agents ringing
the same patient, and the exports. A new page re-implements all of it.

The tab list also already contains `fu3` — **"Follow-up in 3 Days", `offset: 3`** —
which is *exactly* the 3-days-before calling window the meeting asked for. The
corporate tab should follow the same pattern.

### 6.2 The OBT call workflow ✅ CLEAR

Nothing new is needed here. The existing machinery covers it:

- The 3-days-before list = the same day-offset pattern as the `fu3` tab.
- Call outcomes = the existing `shared/callStatuses.js` vocabulary (Called/Spoke,
  Not Picked, Busy, Switched Off, Will Call Later, Rescheduled, Cancelled…).
- "Have we called them **today**" resets each morning per round — already handled
  by `callStatusToday()` (`ghmDayWindow.js:64`), anchored to IST rather than UTC.
- Call attempts are already logged per attempt (`call_attempts` table).

### 6.3 OBT dashboard tiles ⚠️ NEEDS YOUR DECISION

Should `/obt-dashboard` gain a "Corporate checkups to call" tile, or stay as-is?
Small change (`server/routes/obt-dashboard.js` is 58 lines), but it is an addition
the meeting did not ask for, so I am not assuming it.

### 6.4 Permissions ✅ CLEAR

No new capability needed. `OBT_OPS` already exists and already opens `/ghm` and
`/api/ghm-appointments` via the any-of gate in `server/middleware/auth.js`. A new
tab inside `/ghm` inherits it.

---

## 7. Notifications — ⛔ THE REAL BLOCKER

**There is no email capability anywhere in this codebase.** I checked: no
nodemailer, no SendGrid, no Resend, no SMTP config, nothing in `.env.example`.
The only outbound messaging is **MSG91 WhatsApp** (`server/services/msg91.js`),
used for OTP and patient-flow check-in templates.

Two emails are required by the meeting:

1. Appointment confirmation (immediately on booking).
2. Test precautions/instructions (after the OBT confirmation call).

Neither can be built until an email path exists. Options:

| Option | Notes |
|---|---|
| **A** | Add an email provider (Resend / SendGrid / SES / SMTP). Needs an account, API key, and a verified sending domain — all outside this repo. |
| **B** | Send both as **WhatsApp** instead, via the existing MSG91 integration. Needs two new Meta-approved templates (approval takes days) — but no new infrastructure. |
| **C** | Send neither for now; the confirmation screen shows the details, and OBT reads the precautions out on the call. Ships the booking flow today, adds delivery later. |

**My recommendation: C now, then A or B.** The booking + OBT half of this feature
is fully buildable and testable today; blocking all of it on an email account
would be the wrong trade.

Also note: the meeting's flow has the precautions email sent **after** the OBT
call, which means it is a manual/triggered send from the OBT screen, not an
automatic one. That is a button in the OBT tab — worth confirming.

---

## 8. Compliance (GDPR / DPDP)

The public page is the first place in this system where a **member of the public
submits personal data with no login**, so it needs handling the internal pages do
not:

- **Consent** — an explicit, unticked checkbox before submit, with what is
  collected and why. Store consent timestamp + version against the booking.
- **Purpose limitation** — phone and email are used for this appointment only;
  reusing them for marketing would need separate consent.
- **No enumeration** — an unknown or inactive slug returns the same generic page;
  the booking response must never reveal whether a phone already exists in the
  hospital database.
- **Rate limiting** — on the public POST, per IP and per phone.
- **Data minimisation** — collect only what the checkup actually needs (this is
  why the extra fields in §9 are a question, not an assumption).
- **HR boundary** — the company's HR must **not** get results or attendance back
  through this feature. Not requested, and it would be a disclosure of employee
  health data to their employer. Flagging it now so it is never added casually.

---

## 9. Open questions — decisions I need from you

Grouped by whether they block the build.

### Blocking (I can't build the flow without these)

1. **Checkup capacity** — which resource are slots booked against, how many
   employees per slot, which days/hours? (§4.4)
2. **Confirmation delivery** — email (needs an account), WhatsApp (needs template
   approval), or on-screen only for now? (§7)

### Blocking a specific piece

3. **Fields on the form** — the meeting listed phone + email only. Do we also
   need **name**, **age/DOB**, **gender**, **employee ID**? A patient record
   without a name is awkward everywhere downstream in this system, and a "40+
   package" implies age matters. (§4.2)
4. **Package assignment** — the meeting says the package is "already predefined"
   per employee, but the flow has the employee *selecting* it. Does HR give us an
   employee list upfront (so we look their package up), or does the employee just
   pick from the company's list? These are very different builds. (§4.2)
5. **Existing patient matching** — attach to an existing patient on phone match,
   or always create new? (§3.3)

### Non-blocking (can be decided later)

6. Should the OBT dashboard gain a corporate tile? (§6.3)
7. Is the precautions message a manual send from the OBT screen (as the meeting's
   ordering implies) or automatic? (§7)
8. Who administers the package catalogue — a `/corporate-admin` page for admins,
   or seeded by SQL for now? Seeding is far less work for a single pilot company.
9. Can an employee reschedule or cancel from the link, or must they call?

---

## 10. Build order — small, individually testable tasks

Nothing below starts without your go-ahead. Each task is independently testable,
per the project's small-task rule.

| # | Task | Depends on | Testable by |
|---|---|---|---|
| 1 | Migration: 3 catalogue tables | Q8 | Run migration, inspect schema |
| 2 | Migration: corporate columns on `appointments` | Decision §3.2 | Run migration, existing GHM booking still works |
| 3 | Seed Synvesia + one package + its tests | 1 | Query returns package with tests |
| 4 | `GET /api/corporate/:slug` (public) | 1, 3 | curl returns package; bad slug returns generic 404 |
| 5 | Extract shared find-or-create-patient + create-appointment service | — | Existing GHM booking regression-tested first |
| 6 | `GET /api/corporate/:slug/availability` | Q1 | curl returns slots; holiday returns unavailable |
| 7 | `POST /api/corporate/:slug/book` (public, validated, rate-limited) | 2, 4, 5, 6, Q3, Q4, Q5 | Booking creates patient + appointment; duplicate blocked |
| 8 | Public booking page UI | 4, 6, 7 | Book end-to-end in the browser |
| 9 | Consent capture + storage | 7 | Consent row written with timestamp |
| 10 | "Special Tests" tab on `/ghm` | 2, 7 | Booking from task 8 appears in the tab |
| 11 | OBT 3-day call window for corporate rows | 10 | Row appears 3 days ahead, call status logs and resets next day |
| 12 | Confirmation delivery | §7 decision | Message received |
| 13 | Precautions delivery after call | 11, §7 decision | Message lists the package's tests + precautions |
| 14 | ~~Subdomain host mapping~~ — **dropped**, §4.1 decided | — | Not needed: the slug comes from the path |

Tasks 1–11 are buildable as soon as questions 1, 3, 4, 5 are answered.
Tasks 12–13 are blocked on the §7 decision. Task 14 is dropped — §4.1 is decided
and the slug comes from the path, so no host mapping is needed.
