# Corporate Health Checkup — Plan vs. Current Code

**Date:** 2026-08-24
**Companion to:** `docs/CORPORATE_HEALTH_CHECKUP_PLAN.md`
**Status:** AUDIT ONLY — nothing implemented.

This file does two jobs:

1. **§1–2** — checks every claim in the plan against the code as it stands today,
   and lists the corrections the plan needs.
2. **§3–5** — the concrete change map: which file to touch, where in it, and what
   to reuse instead of writing new.

---

## 1. Plan claims verified against code

### 1.1 Confirmed — reusable as the plan assumed

| Plan claim | Verified | Evidence |
|---|---|---|
| Public unauthenticated page precedent exists | ✅ | `src/router.jsx:126` `/visit/:token`, outside `ProtectedRoute` |
| Public API allowlist exists | ✅ | `PUBLIC_PATTERNS` `server/middleware/auth.js:73` |
| `appointments` carries full booking metadata | ✅ | insert of 30 columns, `server/routes/ghm-appointments.js:968` |
| Patient auto-created on booking with `GNI-xxxxx` file_no | ✅ | `ghm-appointments.js:919-937` |
| `patients.email` exists | ✅ | `server/routes/patients.js:486`; also selected by GHM list (`p.email`) |
| Slot capacity + availability API exists | ✅ | `server/routes/appointment-slots.js:82` |
| Booking guard exists (holiday / capacity / doctor off) | ✅ | `checkBookingAvailability()`, called at `ghm-appointments.js:946` |
| GHM tab list is data-driven and capability-gated | ✅ | `VIEW_TABS` `src/pages/GHMPage.jsx:144`, `cap` field per tab |
| Call-status vocabulary is single-sourced | ✅ | `shared/callStatuses.js` |
| "Called today" resets per round, IST-anchored | ✅ | `callStatusToday()` `server/services/ghmDayWindow.js:64` |
| `OBT_OPS` capability already wired both sides | ✅ | `shared/permissions.js`; `server/middleware/auth.js` any-of rows for `/api/ghm-appointments` |
| No email capability anywhere | ✅ **confirmed** | no nodemailer/sendgrid/resend/SMTP in `server/`, `src/`, `package.json`, `.env.example` |
| Zod already a dependency | ✅ | `package.json`; server-side use in `server/schemas/index.js` |
| Migration convention + runner | ✅ | `server/migrations/2026-*.sql`, `node migrations/_runOne.mjs <file>` |

### 1.2 Corrections — the plan is wrong or imprecise here

These five need fixing in `CORPORATE_HEALTH_CHECKUP_PLAN.md`.

#### C1 — Patient matching is phone-only, not phone+name ⚠️ affects §3.3

The plan says the existing GHM path attaches "when phone **and** name reasonably
match". It does not. `ghm-appointments.js:911`:

```sql
SELECT id, file_no FROM patients WHERE phone=$1 LIMIT 1
```

Phone alone, `LIMIT 1`, no name check, no ordering. And
`server/migrations/2026-05-18_patients_phone_non_unique.sql` **removed the unique
constraint on `patients.phone`** — so multiple patients legitimately share one
number (family phones), and `LIMIT 1` picks an arbitrary one.

**Why this matters more for corporate than for GHM:** on the GHM sheet a human
operator is looking at the matched patient and can correct it. On a public form
nobody is checking. An employee entering the family phone number could silently be
attached to a relative's chart.

**Consequence for the plan:** §3.3 stops being a preference and becomes a required
decision. A public booking probably needs a stricter rule than the internal one
(e.g. phone + name, or phone + DOB), which is also why the "do we collect a name"
question (§9 Q4) can't be deferred.

#### C2 — The GHM booking POST is not transactional ⚠️ affects §5

The plan says "in one transaction". `POST /api/ghm-appointments` runs sequential
`pool.query()` calls with no `BEGIN` — patient insert, appointment insert, and slot
`booked_count` increment are three independent statements. A failure between them
leaves a patient with no appointment, or an appointment with an un-incremented slot.

The transaction pattern **does** exist in this repo and should be copied:
`ghm-appointments.js:246` and `:313` (`pool.connect()` → `BEGIN` → `COMMIT`/`ROLLBACK`),
also `server/routes/consultations.js:34`.

**Consequence:** the shared booking service (task 5) should be transactional. That
is a small improvement to the existing GHM path too — worth flagging as a
deliberate change rather than sneaking it in.

#### C3 — `mode=followup` is dead code on the server ⚠️ affects §6.1

The plan cites the `fu3` tab as the model for the 3-days-before list. The tab
exists and works, but not the way it reads. The frontend sets `mode=followup` for
the Tomorrow and `fu3` tabs (`GHMPage.jsx:1287`), but the server's
`mode === "followup"` branch is **commented out** (`ghm-appointments.js:776-788`)
and every non-lookup request falls through to `dayWindowWhere("a")`.

So `fu3` is really "the standard day window, for date+3". That's still the right
pattern to copy — `dayWindowWhere` already unions booked-that-date,
preferred-date and follow-up-due — but the plan should not describe `mode=followup`
as a working server-side mode, and a new corporate tab must **not** be built on it.

#### C4 — The shared axios client will break a public page ⚠️ affects §4.2

`src/services/api.js:20-36` has a response interceptor that, on **any** 401,
clears the token and `window.location.replace("/login")`. A logged-out employee
hitting one 401 would be bounced to the staff login screen.

The precedent already handles this — `PatientJourneyPage.jsx:24` carries the
comment *"authenticated axios instance… so it works for logged-out visitors"* and
uses bare `fetch(`${API_URL}/api/flow/track/...`)`.

**Consequence:** the public booking page must use bare `fetch` with `API_URL`, not
the shared `api` instance. Small detail, but it silently breaks the whole page if missed.

#### C5 — `ipLimiter` is far too loose for a public write ⚠️ affects §4.3

The plan says "the app already has `ipLimiter`". It does — `max: 1000` per 15
minutes (`server/middleware/rateLimit.js:14`). That is a general API budget, not a
booking guard: it permits ~1000 booking attempts per IP per 15 min.

The right model is already in the same file — `loginLimiter` (`max: 50`,
`skipSuccessfulRequests`). A public booking POST needs its own limiter in that
style, plus a per-phone check in the handler.

### 1.3 New findings the plan didn't cover

#### F1 — `doctor_name` is mandatory on booking

`ghm-appointments.js:897` rejects a booking without `doctor_name`. This upgrades
§4.4 from "nice to decide" to **blocking**: there is no way to write a corporate
booking without naming a doctor/resource. The pseudo-resource recommendation
("Health Checkup", following the existing "Hospital Admin" convention at
`GHMPage.jsx:1916`) is the cheapest answer.

#### F2 — The GHM list joins `patients` on `file_no`

`ghm-appointments.js:679`: `LEFT JOIN patients p ON p.file_no = a.file_no`.

This project has a recorded hazard that **`file_no` (UHID) gets reassigned to
different people over time**. Any corporate row displaying `p.email` through this
join inherits that risk — the email shown could belong to whoever holds that
file_no now. If the precautions email is ever sent from the OBT screen using the
joined email rather than the email captured at booking, it can go to the wrong person.

**Consequence:** store the employee's email **on the appointment row** at booking
time (or on a corporate booking record), and send from that — never from the join.
This is a new requirement the plan missed, and it belongs in §3.2's column list.

#### F3 — Exports are tab-keyed and will need an entry

`EXPORT_LABELS` (`GHMPage.jsx:137`) maps tab id → export filename, consumed at
`GHMPage.jsx:1375`. A new tab with no entry silently falls back to
`"ghm-export"`. Whether corporate rows should export in the WATI workbook shape
(`src/lib/ghmWatiExport.js:155`) or a plain list sheet (`buildListSheet`, `:112`)
is an open question — the WATI format is built around appointment-confirmation
messaging, which may or may not suit a checkup list.

#### F4 — `mode` is already the server's tab-dispatch parameter

`ghm-appointments.js:637` destructures `mode`, and `mode === "lookup"` takes a
completely separate query path. A corporate tab should follow that same shape
(`mode=corporate`) rather than inventing a new parameter — it is the established
extension point.

---

## 2. Corrections to apply to the plan doc

| # | Section in plan | Change |
|---|---|---|
| 1 | §3.2 table | Add `corporate_email` (and the employee's captured name) to the new-column list — see F2 |
| 2 | §3.3 | Rewrite: existing match is **phone-only + `LIMIT 1`** on a non-unique column; public form needs a stricter rule |
| 3 | §4.2 | Add: public page must use bare `fetch`, not `src/services/api.js` — see C4 |
| 4 | §4.3 | Replace "already has `ipLimiter`" with "needs a dedicated limiter in the `loginLimiter` style" |
| 5 | §4.4 | Promote from ⚠️ to **blocking** — `doctor_name` is a NOT-NULL-in-practice input |
| 6 | §5 | Note the existing path is **not** transactional; the shared service should be |
| 7 | §6.1 | Correct the `fu3` description — `mode=followup` is commented out server-side |
| 8 | §9 | Move Q3 (name/DOB fields) from "blocking a specific piece" to **fully blocking** — C1 makes it a safety issue, not a UX preference |
| 9 | §10 | Add a task: export-label entry for the new tab (F3) |

---

## 3. Change map — what to update and where

### 3.1 New files

| File | Purpose |
|---|---|
| `server/migrations/2026-MM-DD_corporate_checkup.sql` | 3 catalogue tables + `appointments` columns |
| `server/routes/corporate.js` | The 3 public endpoints |
| `server/services/corporateBooking.js` | Find-or-create patient + create appointment (shared with GHM) |
| `src/pages/CorporateBookingPage.jsx` + `.css` | The public employee page |
| `src/queries/hooks/useCorporate.js` | React Query hooks (bare `fetch`, per C4) |

### 3.2 Existing files to modify

| File | Where | Change |
|---|---|---|
| `server/index.js` | import block ~`:42`, mount block ~`:159` | Import + `app.use("/api", corporateRoutes)` |
| `server/middleware/auth.js` | `PUBLIC_PATTERNS` `:73` | Add `/^\/api\/corporate\/[^/]+(\/(availability\|book))?$/` — nothing wider |
| `server/middleware/auth.js` | `ROUTE_CAPABILITIES` | No row needed if fully public; add one if an admin catalogue page is built (Q8) |
| `server/middleware/rateLimit.js` | after `loginLimiter` `:3` | New `bookingLimiter` — see C5 |
| `server/routes/ghm-appointments.js` | `:637` `mode` destructure, `:775` where-clause | Add `mode === "corporate"` branch filtering `booking_source='corporate'` |
| `server/routes/ghm-appointments.js` | `:668` `baseCols` | Add corporate columns so the tab can render package/company |
| `server/routes/ghm-appointments.js` | `:900-1030` | Refactor patient-resolve + insert into `corporateBooking.js`; wrap in a transaction (C2) |
| `server/routes/obt-dashboard.js` | `:29` counters | Optional corporate tile — only if you say so (plan §6.3) |
| `src/pages/GHMPage.jsx` | `VIEW_TABS` `:144` | Add `{ id: "corporate", label: "Special Tests", Icon: …, offset: 0 }` |
| `src/pages/GHMPage.jsx` | `EXPORT_LABELS` `:137` | Add `corporate: "ghm-special-tests"` (F3) |
| `src/pages/GHMPage.jsx` | `buildQuery` `:1276` | `if (view === "corporate") p.set("mode", "corporate")` |
| `src/router.jsx` | after `:126` | Public route `{ path: "/checkup/:slug", element: lazyEl(CorporateBookingPage) }` — **outside** `ProtectedRoute`, beside `/visit/:token`. Slug is a path param (plan §4.1 decided: `scribe.geniehealth.com/checkup/:slug`), so **no host-header parsing anywhere** |
| `src/config/routes.js` | `PAGE_CAPABILITIES` | **No entry** — it is public. Add a comment saying so, since an unlisted page defaults to "any logged-in role" and a reader will assume it was forgotten |
| `.env.example` | end | Only if an email provider is chosen (plan §7) |

### 3.3 Files to read but NOT modify

| File | Why |
|---|---|
| `shared/callStatuses.js` | Corporate calls reuse the existing vocabulary — do not add corporate-only statuses |
| `server/services/ghmDayWindow.js` | The day-window and called-today semantics apply unchanged |
| `server/services/bookingGuard.js` | Call it; don't fork it |
| `shared/permissions.js` | `OBT_OPS` already covers the new tab |
| `src/pages/PatientJourneyPage.jsx` | Copy its logged-out-page pattern (bare `fetch`, `API_URL`) |

---

## 4. Reuse checklist

Per the project rule "check if that code is already present first" — for each new
requirement, the thing to reuse rather than rewrite:

| Requirement | Reuse | Do NOT write |
|---|---|---|
| Slot availability on the public page | `GET /api/appointment-slots/availability` | A second slot query |
| Holiday / capacity blocking | `checkBookingAvailability()` | New capacity checks |
| Patient find-or-create + file_no allocation | extract from `ghm-appointments.js:905-937` | A second patient-creation path |
| OBT call list, statuses, attempts, live claim | the `/ghm` table | A standalone corporate call screen |
| Per-round call reset | `callStatusToday()` | Corporate-specific date logic |
| Public logged-out page shell | `PatientJourneyPage.jsx` | A new layout |
| Export | `buildListSheet()` `src/lib/ghmWatiExport.js:112` | A new XLSX writer |

---

## 5. Two things to settle before any code is written

Beyond the questions already in the plan's §9, this audit adds one and hardens one:

**New — where does the employee's email live?** (F2)
It must be captured on the booking row, not read back through the
`patients.file_no` join, because file_no is reassigned. Cheap to get right now,
expensive to discover later when a precautions email reaches the wrong person.

**Hardened — do we collect a name?** (C1)
No longer a UX nicety. With phone-only matching against a non-unique phone column
on a form nobody supervises, a shared family number can attach an employee's
booking to a relative's patient record. Either collect enough to match safely, or
decide that corporate bookings always create a fresh patient record.
