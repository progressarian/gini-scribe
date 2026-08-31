# Blocking a patient — one flag, honoured by every screen, every booking, every message

**Status:** built and live, 2026-08-27
**Migration applied:** `2026-08-27_patient_blocklist.sql` (production, run twice — idempotent)
**Date:** 2026-08-27
**Applies to:** the `patients` table · `admin` role only · every booking, messaging and patient-app path
**Related:** `docs/FLOW_MANAGEMENT_PLAN.md` · `docs/OBT_ROLE_PLAN.md` · `shared/permissions.js`

---

## 1. What we have today, and why it isn't enough

The hospital needs to mark a patient as **blocked** — the abusive caller, the chronic no-show who
burns a booked slot every week, the person in a payment dispute, the account we have been asked
to stop contacting.

There is nothing. A grep across `server/migrations`, `server/`, `src/` and `shared/` returns **no**
opt-out, do-not-call, deceased or blacklist flag anywhere in the system.

The one column in that spirit is `patient_special_alerts.avoid_booking`
(`server/migrations/2026-06-01_ghm_cc_system.sql` §10) — and it is **inert**:

- no frontend reads it (`grep -r avoid_booking src/` → zero hits),
- `server/services/bookingGuard.js`, the guard every booking path calls, never consults it,
- the table is keyed on `file_no`, which HealthRay **reassigns to different people**
  (`server/migrations/2026-07-14_patient_identity_health_id.sql`),
- writes are gated by `CLINICAL_WRITE`, so reception and OBT cannot see it and any of ~2,800
  consultants can set it, with no audit trail.

So a patient the hospital has decided to stop serving is re-booked by GHM the next morning,
phoned by OBT the night before, sent a WhatsApp confirmation, and can still log into the patient
app. Nobody at the desk is told anything.

**What we want instead:** one authoritative flag on the patient record; every staff screen shows
it before anyone acts; new bookings are refused; outbound messages stop; the patient app signs
them out. Fully audited, with the reason text visible only to the staff who need it.

---

## 2. The decisions

These were settled before design; they are what the rest of the document builds.

| Question | Decision |
| --- | --- |
| What does a block *do*? | A warning banner everywhere · new appointments refused · outbound messages suppressed · patient-app login denied · **every write against the patient refused** (§3.9), admin `force` excepted. Reads stay open. |
| Who can block? | `admin` only. |
| Who can unblock? | `admin` only. |
| How long does it last? | Until an admin lifts it. No expiry, no cron. |
| Who sees the badge? | Every role that can see the patient at all. |
| Who sees the *reason*? | `ADMIN` + `CLINICAL_WRITE` holders only — that is **admin, consultant and mo**. Everyone else (nurse, reception, obt, lab, tech, coordinator, pharmacy) sees the badge and "contact administration". Note nurses do *not* hold `CLINICAL_WRITE` in this system, so they are on the badge-only side. |
| What does the block attach to? | The `patients.id` **row**. |

### Why admin-only, when the ask was "admin + SD"

**`sd` is not a role in this system.** `shared/permissions.js` `ROLES` has no `sd` entry — SD is a
*flow station* role (`flow_visit_steps.assigned_role`, see `2026-06-15_flow_management.sql`).
The people who work the SD desk are stored in `doctors.role` as `consultant` (2,802 accounts) or
`admin` (73). So "SD can block" cannot be expressed today without either inventing a per-doctor
`can_block_patients` flag or handing the power to ~2,800 consultant accounts.

**Decision: admin-only for v1.** If it becomes a bottleneck the follow-up is the per-doctor flag,
not a broad capability grant.

### Why the block attaches to the patient row, and nothing else

Two facts in this schema make phone- and UHID-level blocking dangerous:

- **Phone is deliberately non-unique** (`2026-05-18_patients_phone_non_unique.sql`) — families
  share a number. Blocking a phone blocks the spouse and the parent too.
- **`file_no` (UHID) is reassigned** by HealthRay to different people
  (`2026-07-14_patient_identity_health_id.sql`, the "P_180848 incident"). Blocking a UHID blocks
  whoever holds it next.

**Decision: block `patients.id` only.** Every guard resolves identity first — file_no, then phone,
then `health_id` — and checks the resolved row. The cost is that the same person re-registering
under a brand-new file_no gets a fresh unblocked chart. That is the correct trade: a missed block
is recoverable, a wrongly blocked family member is not.

---

## 3. Design

### 3.1 The flag lives on `patients`

`server/migrations/2026-08-27_patient_blocklist.sql` — additive and idempotent, per house style.

| Column | Type | Meaning |
| --- | --- | --- |
| `is_blocked` | `BOOLEAN NOT NULL DEFAULT FALSE` | the flag every guard reads |
| `blocked_reason_code` | `TEXT` | one of the shared vocabulary in §3.2 |
| `blocked_note` | `TEXT` | free-text detail — privileged view only |
| `blocked_at` | `TIMESTAMPTZ` | when |
| `blocked_by` | `TEXT` | actor short_name, denormalised like `appointment_change_log.changed_by` |
| `blocked_by_id` | `INTEGER` | actor `doctors.id` |

Plus the partial index the repo always writes for a sparse flag:

```sql
CREATE INDEX IF NOT EXISTS idx_patients_blocked
  ON patients (id)
  WHERE is_blocked = TRUE;
```

`TEXT` + a shared JS vocabulary, **not** a PG enum and **not** a `CHECK` — that is exactly what
`patient_category` did (`2026-08-21_appointment_patient_category.sql` +
`shared/patientCategories.js`), and it is the pattern to copy.

### 3.2 Reason vocabulary — `shared/patientBlockReasons.js`

New dependency-free module imported by both server and client, mirroring
`shared/patientCategories.js` (`BLOCK_REASONS`, `blockReasonLabel()`, `isValidBlockReason()`):

| code | label |
| --- | --- |
| `abusive_behaviour` | Abusive / threatening behaviour |
| `repeated_no_show` | Repeated no-shows |
| `payment_dispute` | Payment dispute |
| `fraud_or_misuse` | Fraud or misuse of services |
| `patient_request` | Patient asked to stop contact |
| `other` | Other (note required) |

Server-side validation on write: unknown code → 400; `other` with no note → 400.

### 3.3 Audit — a history table, not just a column

A blocklist that carries only current state is not defensible under DPDP. Same migration file:

```sql
CREATE TABLE IF NOT EXISTS patient_block_log (
  id           SERIAL PRIMARY KEY,
  patient_id   INTEGER NOT NULL REFERENCES patients(id),
  action       TEXT    NOT NULL,          -- block | unblock | override_booking
  reason_code  TEXT,
  note         TEXT,
  actor_name   TEXT,
  actor_id     INTEGER,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

This is the `appointment_change_log` shape minus the revert machinery — a block is never silently
reverted. Every action **also** writes one coarse `audit_log` row
(`action='block_patient'` / `'unblock_patient'`, `entity_type='patient'`), the same log
`server/routes/auth.js:100` and `ghm-patient-record.js:60` already write to.

### 3.4 Server API — `server/routes/patientBlocks.js`

**Both mutations are state-aware.** `POST` updates `WHERE id = $1 AND is_blocked = FALSE` and
`DELETE` uses `AND is_blocked = TRUE`; a no-op returns `409` (`already_blocked` / `not_blocked`)
rather than succeeding. Without the guard on `POST`, a second block silently rewrites
`blocked_at` / `blocked_by` / `blocked_reason_code` on the patient row, so the row — which every
screen and the admin list reads — would credit the wrong person and lose the original reason, even
though `patient_block_log` still held the truth. Without it on `DELETE`, a redundant unblock
appends a phantom entry for an action that changed nothing.

New router, MVC-shaped like the rest of `server/routes/`.

| Method | Path | Capability | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/patient-block-status?patient_ids=1,2,3` | `PATIENT_READ` | batch status for list screens. Returns `{ [id]: { blocked:true, … } }`. **Reason fields present only for `ADMIN` / `CLINICAL_WRITE` callers.** |
| `POST` | `/api/patient-blocks/:patientId` | `ADMIN` | block. Body `{reason_code, note}`. |
| `DELETE` | `/api/patient-blocks/:patientId` | `ADMIN` | unblock. Body `{note}` — required. |
| `GET` | `/api/patient-blocks/:patientId/history` | `ADMIN` | full block/unblock history |
| `GET` | `/api/patient-blocks?q=` | `ADMIN` | list every currently-blocked patient |

Two rows in `ROUTE_CAPABILITIES` (`server/middleware/auth.js`):

```js
["/api/patient-blocks", CAP.ADMIN],
["/api/patient-block-status", CAP.PATIENT_READ],
```

The read endpoint has to be its own prefix, **not** a sub-path of `/api/patient-blocks` —
`capabilityForPath()` is a literal longest-prefix matcher, so a sub-path would inherit `ADMIN`
and every list screen would 403.

`POST` does three things beyond setting the columns: appends `patient_block_log`, writes
`audit_log`, and **deletes the patient's `auth_sessions` rows** so existing 30-day app tokens die
at once (§3.7).

Redaction is one helper in the router — `redactBlock(row, doctorRole)` — used by every response,
so no endpoint can leak the reason by accident. It is enforced server-side, not by hiding fields
in the UI.

### 3.5 The guard — `server/services/patientBlockGuard.js`

A **separate module** from `bookingGuard.js`, deliberately. `bookingGuard` opens with

```js
if (SCHEDULE_ENFORCEMENT === "off" || !doctorId || !date || !slot) return null;
```

and `SCHEDULE_ENFORCEMENT` is `off` in production. A blocklist must never be switchable off by an
env var meant for doctor-availability enforcement.

```js
// null when allowed; { blocked:true, reason_code, label, note, blocked_by } when not.
export async function checkPatientBlocked({ patientId, force, role })
```

- no `patientId` → `null` (nothing resolved, nothing to block)
- reads `is_blocked` + detail columns for that one row
- `force && hasCapability(role, CAPABILITIES.ADMIN)` → `null` — the admin-override idiom lifted
  verbatim from `bookingGuard.js:33`; the override appends `patient_block_log.action='override_booking'`
- callers turn a truthy return into `409 { error, reason: "patient_blocked", detail }` — the shape
  every existing caller and the UI already handle

**The 409 body is redacted too.** The guard returns the full row for the caller's own logic, but
what goes into `detail` must pass through the same `redactBlock()` helper as §3.4 — reception and
OBT book patients, so an unredacted `detail` would hand them the reason text that §2 says they
must not see. `redactBlock()` therefore lives in a small shared module
(`server/services/patientBlockView.js`) imported by both the router and every guard call site, not
inside the router.

### 3.6 Where the guard is wired

| # | Path | File | Where exactly |
| --- | --- | --- | --- |
| 1 | GHM booking | `server/routes/ghm-appointments.js` `POST /` (~975) | after file_no/phone resolution (~1045), **before** the "create a new `patients` row if unresolved" branch (~1053) — otherwise a blocked person is laundered into a fresh chart. Cover the placeholder-UPDATE branch too. |
| 2 | Core booking | `server/routes/appointments.js` `POST /`, `PUT /:id` | right after `patient_id` resolves, before auto-create. `PUT` too, so a *reschedule* is refused. |
| 3 | Walk-in | `server/routes/walkins.js` `POST /` | **has no guard of any kind today.** Resolve `file_no` / `contact_number` → `patients.id` first, then check. |
| 4 | Flow check-in | `server/routes/flow.js` `POST /flow/checkin` (861), `POST /flow/from-appointment/:id` (3389) | before `ensureFlowAppointment()`. **Warn, not a hard stop** — the person is standing at the desk; reception needs to be told, not stonewalled. Hard stops are for *new bookings* only. |
| 5 | Chart backdoor | `server/routes/patients.js` `POST /` (440) | the upsert on `file_no`/`abha_id` must not clear `is_blocked`. |
| 6 | App → hospital chart | `server/routes/patientApp.js` `POST /ensure-scribe-patient` (144) | refuse for a blocked patient. |
| 7 | Patient edit | `server/routes/patients.js` `PUT /:id` (517), `POST /convert-from-genie` (558) | must not clear `is_blocked`; converting a Genie user into a blocked chart is refused. |
| 8 | App password reset | `server/routes/patients.js` `POST /:id/reset-app-password` (587) | refuse — otherwise a staff member hands a blocked patient a working way back into the app that §3.8 just closed. |

### 3.6.1 The three sync paths that must **not** be blocked

Six more `INSERT INTO appointments` sites exist beyond the routes above, and three of them run
unattended:

| Path | File | Trigger |
| --- | --- | --- |
| HealthRay real-time sync | `server/services/healthray/db.js` `syncAppointment()` | every ~10–15 s |
| Google Sheets import | `server/services/cron/sheetsSync.js` | cron, upcoming OPD appointments |
| No-show backfill | `server/services/cron/todaysShowSync.js` | every 5 min, inserts an appointment row for a sheet no-show that has none |

**Decision: these three mirror external reality and must keep inserting.** HealthRay is where the
OPD actually books today (`CLAUDE.md`), and it is authoritative for visit truth. If our sync
refuses to mirror a HealthRay booking, our OPD list silently diverges from the hospital's real
day — the patient walks in and is not on any screen. That is a worse failure than a blocked
patient appearing on a list.

So instead:

1. The sync inserts as it does today, **untouched**.
2. The appointment carries the badge like any other (§4.2) — the badge is derived from
   `patients.is_blocked` by `usePatientBlockStatus`, so this needs no sync-side change at all.
3. The sync writes one `patient_block_log` row, `action='synced_while_blocked'`, so an admin can
   see that an external system booked someone we had blocked.
4. Outbound messages for that appointment are still suppressed by §3.7 — suppression keys on the
   patient, not on how the row was created.

**The one rule every `patients` insert/upsert must follow.** There are ten `INSERT INTO patients`
sites (`healthray/db.js` × 2, `genieImport.js`, `sheetsSync.js`, `todaysShowSync.js` × 2,
`lab/db.js`, `consultations.js`, `ghm-appointments.js`, `appointments.js`, `patients.js`). None of
them may set or clear `is_blocked`. Because they all write explicit column lists, the default
behaviour is already correct — but `upsertPatient()` in `server/services/healthray/db.js:402`
"refreshes demographics in place" on a `health_id` match, so its UPDATE column list must be
checked to confirm the block columns are not in it. **Only `/api/patient-blocks` ever writes
them.** Add that as a one-line comment above the column group in the migration.

### 3.7 Suppressing outbound messages

| # | Point | File | Change |
| --- | --- | --- | --- |
| 1 | Push, all of it | `server/services/pushNotifier.js:46` `sendToPatient(patientId, …)` | one lookup → `{ sent:0, skipped:true, reason:"blocked" }`. It already takes a `patientId` and already returns that shape with `reason:"no-tokens"` — this is non-breaking, and it covers `sendDoseDecisionNotification` for free. |
| 2 | Check-in WhatsApp | call site `server/routes/flow.js:1094` | suppress there, not in `msg91.js` — `sendFlowCheckin` only knows the phone, and phone is not identity. |
| 3 | Booking WhatsApp copy | `buildWhatsappMessage()` (`ghm-appointments.js` ~1130), `buildWalkinWhatsapp()` (`walkins.js`) | skip composing `whatsapp_message` / `additional_whatsapp_msg`. Belt-and-braces for the admin-override path — normally the booking is refused outright. |
| 4 | OBT calling list | `shared/patientLists.js` | blocked rows drop out of the "to call" counts (§4.3). |

`sendOtpSms` is **not** suppressed at the SMS layer. The block lands one step later, in
`issueSession`, so the patient gets a clear "contact the hospital" response instead of an OTP that
silently never arrives.

### 3.8 Denying the patient app

Two complementary changes:

1. **`issueSession(db, patient)`** — `server/routes/patientAuth.js:221`. Refuse to mint a session
   for a blocked hospital patient → `403 { error: "account_blocked", message: "Please contact the
   hospital reception." }`. This single function covers login, set-password and verify-otp
   completion. All of `/patient/auth/*` sits in `PUBLIC_PATHS` (`server/middleware/auth.js` ~62),
   so no middleware runs there — the check has to be inside the handler.

2. **Existing 30-day tokens.** No new per-request query is needed. `authMiddleware` already runs
   `SELECT 1 FROM auth_sessions WHERE token=$1 AND expires_at > NOW()` on every request
   (`server/middleware/auth.js:31`) and leaves `req.patient` unset when it misses. Because `POST
   /api/patient-blocks/:id` deletes that patient's `auth_sessions` rows, every live token dies at
   that existing check — **zero added cost**.

A block landing **mid-visit** does not interrupt the visit. `flow_visits` already in progress run
to completion — the person is in the building and mid-treatment. The badge appears on the station
screens immediately; the block bites on the *next* booking.

Only `db === "hospital"` sessions are checked. App-DB-only users (Genie / `GNI-` shells) have no
`patients` row to block; out of scope for v1 (§5).

### 3.9 No write against a blocked patient succeeds

**Decision changed, 2026-08-27.** This section originally specified that clinical writes were
recorded and merely warned about, on the argument that a sample already drawn must still be
recordable. In practice the user found that too weak: a blocked patient's record could still be
edited freely. **The block is now a hard stop on writes.**

`server/middleware/blockWriteGuard.js`, mounted with `router.param()` on eleven routers:
`visit`, `clinical`, `consultations`, `documents`, `messages`, `opd`, `alerts`, `sideEffects`,
`health-logs`, `summary`, `postVisitSummary`. One implementation covers every patient-scoped
`POST` / `PUT` / `PATCH` / `DELETE`, present and future, without touching ~60 individual handlers.

The guard resolves the patient two ways, because not every write names one directly:

- **directly** from `/visit/<id>` or `/patients/<id>` in the URL;
- **via the appointment** for `/appointments/<id>/…`, looking `patient_id` up from the
  appointments row — this is how the OPD page records vitals, biomarkers, compliance and prep, and
  it was missed on the first pass (§11).

`/appointments/<id>` and `/appointments/<id>/status` are **deliberately exempt**: cancelling,
reassigning or marking a no-show is how a blocked patient's existing booking gets tidied up, so
those must stay open. `POST /api/cancellations` is exempt for the same reason.

**Three entry points, because not every write names a patient the same way.**

| Entry point | Used by | How the patient is found |
| --- | --- | --- |
| `blockWriteGuard` — `router.param` | `visit`, `clinical`, `consultations`, `documents`, `messages`, `opd`, `alerts`, `sideEffects`, `health-logs`, `summary`, `postVisitSummary` | the URL (`/visit/<id>`, `/patients/<id>`) or a lookup from `/appointments/<id>` |
| `blockWriteBodyGuard` — `router.use("/path", …)` | `cc-calling`, `obt-status`, `station-tracking`, `patient-alerts`, `lab-requests` | `patient_id`, `file_no` or `appointment_id` in the request **body** |
| `blockWriteGuardVia(table, column)` — `router.param` | `refills`, `doseChangeRequests`, `labRequests`, and the PATCH routes of the ops routers | the URL names a **request**; its row names the patient |

`blockWriteGuardVia` passes the id through as a string rather than `parseInt`-ing it, because
`medication_refill_requests` and `medication_dose_change_requests` are keyed by **uuid**, not
integer — an integer-only guard skipped them entirely. Its table and column are developer-supplied
constants but are validated as plain identifiers before being interpolated into SQL. Refusals use the same body every other blocklist rejection uses:

```json
{ "error": "Patient is blocked", "reason": "patient_blocked", "detail": "…" }
```

with `detail` redacted by role — an admin sees the reason, reception sees "contact administration".

What it is careful about:

- **Writes only.** `GET` is untouched: a blocked patient's chart stays fully readable, so staff can
  still see history and understand why the block exists.
- **`:id` is not always a patient.** It is a patient on `/patients/:id/labs`, a document on
  `/documents/:id`. The guard only fires when the matched `req.route.path` is patient-scoped, so a
  document whose id happens to equal a blocked patient's id is never refused.
- **A DB blip does not take the chart down.** A failed lookup logs and lets the write through
  rather than failing closed — the alternative is that one transient error makes every patient
  unwritable.
- **`POST /consultations` carries the patient in the body**, not the URL, so `router.param` cannot
  see it. It is guarded explicitly in the handler, after identity resolution and before any
  demographics or clinical rows are written.

**The admin escape hatch.** An `admin` passing `force: true` writes through anyway — the same
idiom as `bookingGuard.js:33`, so a genuine emergency is never fully locked out. Every override
appends `patient_block_log.action = 'override_write'` with the actor and the route, so a forced
clinical write is auditable after the fact. Non-admin roles cannot force.

**The trade-off, recorded honestly.** This means a nurse cannot record a vital sign on a blocked
patient standing in front of her without an admin. That is a deliberate policy choice by the
hospital, made with the clinical-record argument on the table. If a blocked patient is genuinely
being treated, the block should be lifted (§4.4) rather than worked around.

Client side: the 409 is surfaced as an error toast from one place — the axios response interceptor
in `src/services/api.js`, plus `OPD.jsx`'s own `apiFetch`, which calls the same exported
`notifyIfBlocked` rather than duplicating the rule.

---

## 4. Screens

### 4.1 The shared badge — `src/components/ui/BlockedBadge.jsx`

Modelled on `src/components/ui/DocStatusPill.jsx`, which is the exact precedent: a shared pill that
derives its own state from the row it is handed, takes `size="sm"|"md"`, and carries a hover
popover.

```
┌──────────────────────────────────────┐
│  Ramesh Kumar    [ BLOCKED ]         │   ← every list row and patient header
└──────────────────────────────────────┘

   on hover — admin / consultant / mo:
   ┌────────────────────────────────────┐
   │ Blocked — Repeated no-shows        │
   │ "4 missed slots since June"        │
   │ by Gurjot · 27 Aug 2026            │
   │                   [ View history ] │
   └────────────────────────────────────┘

   on hover — nurse / reception / obt / everyone else:
   ┌────────────────────────────────────┐
   │ Blocked · contact administration   │
   └────────────────────────────────────┘
```

Colour comes from adding `blocked: "#b91c1c"` to `DC` and `blocked: "Blocked"` to `FRIENDLY` in
`src/config/constants.js`, so the generic `<Badge id="blocked" friendly />` also renders correctly
anywhere `Badge` is already used — no new CSS. Inside flow and queue rows, reuse the existing
`.flow-badge.fb-red` class (`src/styles/flow.css:161`) rather than introducing a second element.

### 4.2 Where the badge appears

| Surface | File | Placement |
| --- | --- | --- |
| Visit workspace | `src/components/visit/VisitTopbar.jsx` | beside the patient name + a full-width red banner above the workspace |
| GHM day list | `src/pages/GHMPage.jsx` | name cell, alongside the existing `booked-tag` / `cancel-tag` chips (~2775) |
| GHM record modal | `src/components/ghm/PatientRecordModal.jsx` | header |
| Find / booking | `src/pages/FindPage.jsx` | search rows, **and** an inline blocker above the booking form — the POST at line 386 will 409 anyway, but the UI should not offer the action |
| Reception check-in | `src/components/flow/AppointmentPicker.jsx` (~170), `src/pages/flow/FlowCheckinPage.jsx` | picker row chip + confirm-with-warning on check-in |
| OPD | `src/OPD.jsx` day grid, `src/components/opd/TriageViewV3.jsx` | row chip |
| Doctor day list | `src/pages/DashboardPage.jsx` | row chip |
| Companion | `src/companion/HomeScreen.jsx`, `src/companion/PatientScreen.jsx` | row chip + header |
| Message picker | `src/pages/RoleInboxPage.jsx` | chip on search results |

One hook feeds all of them: `usePatientBlockStatus(patientIds)` in
`src/queries/hooks/usePatientBlocks.js`, batching against `GET /api/patient-block-status` so a list
screen makes one call, not N. `staleTime` 5 minutes — a block changes rarely.

### 4.3 Blocked patients are hidden from every working list

**Changed 2026-08-27.** This section originally said blocked rows stayed visible with a badge and
merely dropped out of the "to call" counts. Two things were wrong with that. First, the exclusion
was never wired to the page at all — `isBlockedRow` reached only `LIST_PREDICATES`, which is
consumed by exactly one file, `src/lib/ghmWatiExport.js`, so it changed the Excel export and
nothing else. The GHM page's counts are computed server-side in SQL and had no block awareness.
Second, on review the user wanted them gone from the working lists entirely, not badged.

Blocked patients are now filtered out of every list query:

| Endpoint | Page |
| --- | --- |
| `GET /api/ghm-appointments` (day list **and** lookup) | GHM ops |
| `GET /api/opd/appointments`, `/opd/appointments-range` | OPD |
| `GET /api/obt-dashboard` | OBT dashboard |
| `GET /api/flow/appointments` | reception check-in picker |
| `GET /api/appointments` | day list / dashboard |

Because the filter sits in the shared `where`, the summary pills and counts exclude them too — the
original intent, now actually delivered.

**Where they remain visible, deliberately:**

- **`/find`** (`GET /api/patients`) — the way in to block, unblock or look someone up. Rows carry
  `is_blocked`, so the badge still renders.
- **The admin Blocked tab and `/admin/blocklist`** (`GET /api/patient-blocks`).
- **`GET /api/patient-block-status`** — the badge feed, which every screen still uses for any
  blocked patient it does show.

Two SQL helpers do this: `BLOCKED_EXCLUSION(alias)` where the query already joins `patients`, and
the join-independent `NOT_BLOCKED(alias)` (`NOT EXISTS … bp.is_blocked`) everywhere else.

> **Known trade-off.** A patient blocked while physically in the building disappears from the ops
> lists mid-visit. Flow visits already in progress are unaffected (§3.8), but the coordinator's
> day list will no longer show them. If that bites, the fix is a "Show blocked" toggle rather than
> reverting the filter.

### 4.4 Admin screen — `src/pages/PatientBlocklistPage.jsx`

Route `/admin/blocklist`, registered in `src/router.jsx` and in `src/config/routes.js`
`PAGE_CAPABILITIES` as `CAP.ADMIN`, with a nav entry in `src/components/AppLayout.jsx`.

```
Blocked patients                            [ search… ]
────────────────────────────────────────────────────────────────
 Name           File no    Phone        Reason           Blocked by   When        
 Ramesh Kumar   P_180848   98xxxxxx21   Repeated no-shows  Gurjot     27 Aug 2026   [ Unblock ]
 Sita Devi      P_204411   99xxxxxx03   Payment dispute    Gurjot     19 Aug 2026   [ Unblock ]
   └ expand → block / unblock history from /api/patient-blocks/:id/history
```

Reuse `SearchBox` / `FilterPopover` as `src/pages/AppPatientsPage.jsx` does. `[ Unblock ]` opens a
modal that **requires a note** — no unblock without a stated reason.

### 4.5 The block action

A **Block patient** item in the patient header overflow menu, rendered only when the signed-in
doctor holds `CAP.ADMIN`. It opens `src/components/patient/BlockPatientModal.jsx`: a real `<select>`
of reasons from `shared/patientBlockReasons.js`, a note textarea (required when `other`), and a
plain-English statement of what will happen —

> This patient will not be able to book new appointments, will stop receiving SMS / WhatsApp /
> push messages, and will be signed out of the patient app. Staff will see a Blocked badge on
> every screen. Only an administrator can lift this.

Real `<button>` and `<select>` elements throughout — no div-with-onClick.

---

### 4.6 Pagination — `src/components/ui/Pagination.jsx` (not in the original plan)

The admin list needed paging once it was clear it could hold hundreds of rows. **No reusable
pagination component existed** — a sweep found seven ad-hoc implementations (numbered Prev/Next
inline in `AppPatientsPage.jsx` and `opd/CohortDashboard.jsx`; load-more buttons in `GHMPage.jsx`,
`FindPage.jsx`, `GenieChatsPage.jsx`; IntersectionObserver sentinels in `RefillsPage.jsx`,
`DoseChangeRequestsPage.jsx`, `companion/HomeScreen.jsx`), none sharing markup or CSS.

Rather than add an eighth, the `AppPatientsPage` implementation was extracted into a shared
component following the existing `ui/Foo.jsx` + `ui/Foo.css` convention. Rows-per-page is
selectable (10 / 25 / 50 / 100, default 25) and reuses the shared `Dropdown` rather than
introducing a second select control.

Paging is **server-side**: `GET /api/patient-blocks?q=&page=&limit=` returns the
`{ data, total, page, limit, totalPages }` shape the rest of the app already uses, so the count is
the true total. Search is debounced 300ms — matching `AppPatientsPage.jsx:297` — because without it
every keystroke was its own request and its own `ILIKE` scan. `keepPreviousData` holds the current
page while the next loads.

Three states handled: changing page size returns to page 1; a new search term returns to page 1;
and if the list shrinks under the reader (an unblock on the last page) the page clamps into range.

`AppPatientsPage` and `CohortDashboard` were **not** retrofitted onto the new component — out of
scope for this change, but they are now near-duplicates of code that has a shared home.

---

## 5. What this plan does not do

- **No timed or auto-expiring blocks.** Every block stands until an admin lifts it. No cron.
- **No block-request queue.** Reception / OBT / MO cannot raise one in the app; they escalate to an
  admin out of band.
- **No phone-level or file_no-level blocking**, for the reasons in §2. The same person
  re-registering under a new UHID gets a fresh, unblocked chart.
- **No blocking of app-DB-only (Genie / `GNI-`) users** with no hospital `patients` row.
- **No retroactive cancellation** of a blocked patient's already-booked future appointments — they
  are badged, and staff decide case by case.
- **No blocking of reads.** A blocked patient's chart stays fully readable — staff must be able to
  see the history and understand why the block exists. Only writes are refused (§3.9).
- **No migration of `patient_special_alerts.avoid_booking`.** That column stays inert; retiring it
  is a follow-up.

---

## 6. Compliance — GDPR / DPDP

- **Purpose limitation.** A reason code is mandatory on every block; free text is never the only
  record of why.
- **Data minimisation.** The reason, note and blocker identity go only to `ADMIN` and
  `CLINICAL_WRITE` holders (admin, consultant, mo), enforced server-side in `redactBlock()` — not by hiding fields in the
  UI, where an API call would still expose them.
- **Accountability.** `patient_block_log` is an append-only, actor-attributed history of every
  block, unblock and admin booking override. `audit_log` carries the coarse action alongside.
- **Right to object / erasure.** `/admin/blocklist` is the single place to review and lift, and an
  unblock requires a note — so a lifted block leaves a reasoned record.
- **No automated adverse decision.** Nothing sets `is_blocked` automatically; every block is a
  named administrator's action.

---

## 7. Build order — **all steps complete**

Small steps, each tested before the next started. Every item below shipped; §10 records what
that actually cost and §11 the defects it exposed.

1. **Migration + vocabulary.** `2026-08-27_patient_blocklist.sql`, `shared/patientBlockReasons.js`.
   Run the migration twice to prove idempotency.
2. **Router + guard module.** `server/routes/patientBlocks.js`,
   `server/services/patientBlockGuard.js`, the two `ROUTE_CAPABILITIES` rows.
3. **Booking guards** — §3.6 rows 1–3 (GHM, appointments, walk-ins).
4. **Flow + chart-creation guards** — §3.6 rows 4–8, plus the `upsertPatient()` column-list check
   and the `synced_while_blocked` log row in §3.6.1.
5. **Message suppression** — §3.7.
6. **Patient-app denial** — §3.8.
7. **Badge + `DC`/`FRIENDLY` entries + the query hook**, wired into `VisitTopbar` alone first.
8. **Roll the badge across the rest of §4.2**, one screen per step.
9. **Block modal + `/admin/blocklist`.**
10. **Docs.** Append a "Built — what shipped" section here, per the convention in
    `MO_REPORT_REVIEW_PLAN.md` §7.

---

## 8. Verification checklist

As an **admin**:

- `/find` → open a test patient → overflow menu → **Block patient** → "Repeated no-shows" + a note
- the row now carries the red badge; hovering shows reason, note, blocker and a **View history** link
- booking from `/find` is disabled with an inline explanation; forcing it by curl returns
  `409 {"reason":"patient_blocked"}`
- `POST /api/ghm-appointments` for that patient → 409; `POST /api/walkins` → 409
- `sendToPatient(<id>, …)` returns `{ sent:0, skipped:true, reason:"blocked" }`
- the patient's live app token 401s on its next request; `POST /patient/auth/login` returns
  `403 account_blocked`
- `/admin/blocklist` lists the patient; expanding shows the log rows; **Unblock** requires a note
- after unblocking, booking and app login both work again
- `POST /api/patients/<id>/reset-app-password` on a blocked patient → refused
- `POST /api/visit/<id>/lab` on a blocked patient → `409 {"reason":"patient_blocked"}`; as reception
  the `detail` reads "contact administration" with no reason text
- the same call with `{"force":true}` as admin → succeeds, and appends an `override_write` row
- `GET /api/visit/<id>/lab` → still `200`; the chart stays readable
- `PATCH /api/documents/<id>` → no `blocked` field (that `:id` is a document, not a patient)
- with a blocked patient booked in HealthRay, the next sync tick still creates the appointment,
  it shows the badge on `/opd`, and `patient_block_log` gains a `synced_while_blocked` row
- `upsertPatient()` running over a blocked patient leaves `is_blocked` TRUE

As **reception** and as **obt**:

- the re-blocked patient shows the badge on `/ghm` and in the check-in picker, but the popover
  reads only "Blocked · contact administration"
- `GET /api/patient-block-status?patient_ids=<id>` returns `{blocked:true}` with **no**
  `reason_code`, `note`, `blocked_by` or `blocked_at`
- `POST /api/patient-blocks/<id>` → 403
- a refused booking returns `409` whose `detail` carries **no** reason text or blocker name

Repo-level:

- `node server/scripts/verify-rbac.mjs` passes
- `npm run format` is clean

> ⚠️ `.env DATABASE_URL` points at **production**. The migration is additive and idempotent, but
> the user runs it — `node migrations/_runOne.mjs migrations/2026-08-27_patient_blocklist.sql`
> from `gini-scribe/server` — not Claude, and only on an explicit go-ahead.

---

## 9. Open questions

1. **Retro-cancellation.** A blocked patient with three booked future appointments: badge only
   (this plan), or offer the admin a "cancel their future bookings too" checkbox in the block modal?
2. **Consultant visibility.** Consultants hold `CLINICAL_WRITE`, so under §3.4 they see the reason
   and note. Correct — or should the reason be admin-only, with consultants seeing what reception
   sees?
3. **Admin booking override.** §3.5 keeps the `force=true` escape hatch so an admin can knowingly
   book a blocked patient (a medical emergency). Keep it, or make a block absolute until formally
   lifted?
4. **Alerting on `synced_while_blocked`.** §3.6.1 logs it silently. Should an admin also get a
   visible signal — a count badge on `/admin/blocklist`, or a row in the reception inbox — when an
   external system books someone we blocked? Silent logging is the minimum; nobody reads a log
   nobody opens.
5. **SD, eventually.** If admin-only proves too slow, the follow-up is a per-doctor
   `can_block_patients` flag on `doctors`, ticked by an admin in Doctor Management. Worth doing
   now, or wait until it actually bites?

---

## 10. Built — what shipped

### New files (13)

| File | What |
| --- | --- |
| `server/migrations/2026-08-27_patient_blocklist.sql` | 6 columns on `patients`, partial index, `patient_block_log` |
| `shared/patientBlockReasons.js` | reason vocabulary + `BLOCK_ACTIONS`, shared client/server |
| `server/services/patientBlockView.js` | `redactBlock()` / `blockDetail()` — the one place role redaction lives |
| `server/services/patientBlockGuard.js` | `checkPatientBlocked`, `fetchBlockRow`, `resolvePatientId`, `logBlockAction`, `noteSyncedWhileBlocked` |
| `server/middleware/blockWriteGuard.js` | refuses every patient-scoped write |
| `server/routes/patientBlocks.js` | 5 endpoints |
| `src/queries/hooks/usePatientBlocks.js` | batched status, list, history, block, unblock |
| `src/components/ui/BlockedBadge.jsx` | the badge, with role-aware popover |
| `src/components/ui/Pagination.jsx` + `.css` | the shared pager (§4.6) |
| `src/components/ghm/BlockedPatientsView.jsx` | the admin review screen |
| `src/components/patient/BlockPatientModal.jsx` | the block form |
| `src/pages/PatientBlocklistPage.jsx` | 13-line wrapper — same component as the GHM tab |

### Modified (36)

Backend: `index.js`, `middleware/auth.js` (2 capability rows), the five routers carrying
`blockWriteGuard` (`visit`, `clinical`, `consultations`, `documents`, `messages`), the four booking
paths (`appointments`, `ghm-appointments`, `walkins`, `flow`), `patients` (which guards
`reset-app-password` directly rather than via the param handler), `patientAuth`, `pushNotifier`,
`healthray/db`, the two cron syncs, `shared/patientLists.js`.

Frontend: the nine badge surfaces (§4.2), `config/constants.js`, `config/routes.js`, `router.jsx`,
`queries/keys.js`, `services/api.js`, `ui/ConfirmModal.jsx`, `GHMPage.css`, `FindPage.css`.

### Deliberate reuse, not new code

- **`ConfirmModal`** — the unblock dialog is the shared one used by 11 other call sites, extended
  with three optional props (`confirmDisabled`, `busy`, `error`) that default to the previous
  behaviour. Verified all 11 existing callers are unaffected. The bespoke dialog first written for
  this feature was deleted, along with its two now-dead CSS rules.
- **`Dropdown`** — the rows-per-page selector.
- **`bookingGuard.js`'s 409 contract and admin-`force` idiom** — copied verbatim so the client
  handles one shape.
- **`/admin/blocklist`** started as a separate 267-line implementation of the GHM tab; it is now a
  13-line wrapper around the same component. One implementation, two ways in.

### Scaffolding removed

A dev-only `?mock=120` preview (generated rows for judging layout at volume) was built and then
deleted at the user's request once the design was settled — `blockedMockData.js` plus the preview
branches. Verified gone from `src/` and from the production bundle.

---

## 11. Defects the build exposed

### The guard silently did nothing — the one that mattered

The write guard was mounted as an Express `router.param` handler and gated on
`req.route?.path` to tell a patient `:id` from a document `:id`. It never fired. Every clinical
write against a blocked patient succeeded, and a harness test reported **11/11 PASS** while it did.

Two things combined:

1. `visit.js:82` registers `router.use("/visit/:patientId", …)` **before** the routes. Express
   invokes each `param` callback **once per request and caches the result**, so that middleware
   layer consumed `patientId` first.
2. On a `router.use` layer `req.route` is `undefined`. The guard read `""`, decided the param was
   not patient-scoped, called `next()` — and was never re-invoked for the real route.

**The test was the second failure.** The harness declared its own routes inline and had no
`router.use` layer, so it never reproduced the real router's shape. It tested a construction that
resembled the app rather than the app. The fix was to import the **real** routers and assert
against those; the corrected suite fails loudly on the old code.

The guard now keys off `req.originalUrl` (`/(?:visit|patients)/(\d+)`), which is populated on
every layer, and confirms the captured segment equals the param value.

### Code shipped ahead of its migration

The GHM day-list query and `fetchBlockRow` referenced the new columns before the migration had been
applied, so `/ghm` rendered "No appointments found" and patient-app login was failing. Both cleared
the moment the migration ran. The plan said migration first; the build did not follow its own
ordering. In a deploy where code ships ahead of the migration this breaks production the same way.

### Block and unblock were not state-aware

`POST` and `DELETE` updated unconditionally. A second block silently overwrote `blocked_at`,
`blocked_by` and `blocked_reason_code`, so the patient row — which every screen reads — credited
the wrong person and lost the original reason, while `patient_block_log` still held the truth. A
redundant unblock appended a phantom entry for an action that changed nothing (one such row was
created during testing and has been removed from both `patient_block_log` and `audit_log`). Both
now use `WHERE … AND is_blocked = FALSE/TRUE` on the UPDATE itself — check and write in one atomic
statement, no read-then-write race — and return `409 already_blocked` / `409 not_blocked`.

### Stale documentation, corrected

- §2 originally glossed "`CLINICAL_WRITE` holders" as *"admin, consultant, mo, nurse"*. **Nurses do
  not hold `CLINICAL_WRITE`** in this system, so they see the badge but not the reason. The code was
  always right; the doc was wrong.
- A duplicate §3.9 had been written and misplaced between §3.6.1 and §3.7; removed.

### The first guard sweep missed two whole classes of write

A post-build API audit ran every write endpoint against a blocked patient and classified the
response. Two classes were unguarded:

1. **Appointment-scoped clinical writes.** `POST /api/appointments/:id/{vitals,biomarkers,compliance}`
   and `PATCH /api/appointments/:id/prep` all returned `200` — a pulse and an HbA1c were really
   recorded on a blocked patient during the audit, then reverted. These are the OPD page's writes;
   the patient is reached through the appointment row, so a URL guard keyed only on
   `/visit/` and `/patients/` could never see them.
2. **Five `/patients/:id` routers where the guard was simply never mounted** — `alerts`,
   `sideEffects`, `health-logs`, `summary`, `postVisitSummary`. The URL pattern already matched;
   the mount was missing.

Both are fixed and re-verified. The lesson is that mounting a guard per-router does not prove
coverage — only enumerating the endpoints and testing each one does.

Both were fixed, and a second audit pass then closed the remaining two classes — OBT/ops writes
(patient in the body) and the request-keyed queues (uuid- and integer-keyed) — via the two extra
entry points in §3.9. `cancellations` and the appointment status routes stay open by design.

### A pathless `router.use` guarded half the API

The body guard was first mounted as `router.use(blockWriteBodyGuard)` with no path. Every router in
this app is mounted at `app.use("/api", …)`, so a pathless `router.use` runs for **every** `/api`
request that reaches that router — not just its own routes. `cc-calling` is mounted at
`index.js:162` and `cancellations` at `166`, so `POST /api/cancellations` started returning 409
despite being deliberately exempt, and every route registered after line 162 was being block-checked
on its request body.

Caught because the verification sweep asserted what must **stay open**, not only what must be
refused. Each mount is now scoped to its own path.

### Smaller ones

- `.blocked__overlay` / `.blocked__panel` became dead when the bespoke dialog was dropped — removed
  after confirming no JSX referenced them.
- The Block button in `/find` first used `btn--sm` and `sr-only`, neither of which exists here, so
  it rendered unstyled. Every class the new components use was then checked against the stylesheet.
- The mock-preview data initially shipped inside the production bundle; the `import.meta.env.DEV`
  guard stopped it rendering but the names were still in the build. Moved to a lazily-imported
  chunk before being deleted entirely.

---

## 12. Decisions taken during the build

| Question (from §9) | Outcome |
| --- | --- |
| Effect of a block | Started as warn-only on clinical writes (Option A), **reversed to a hard refusal** at the user's direction after seeing it in practice (§3.9). |
| Admin write override | **Kept.** `force: true` for admins, logged as `override_write`. Without it a blocked patient in an emergency is unwritable by anyone. |
| Consultant visibility | **Unchanged** — consultants hold `CLINICAL_WRITE` and see the reason. |
| Alerting on `synced_while_blocked` | **Still silent logging.** Open. |
| SD blocking | **Still admin-only.** Open — the follow-up is a per-doctor `can_block_patients` flag. |
| Retro-cancellation | **Not built.** Open. |

Three of the five §9 questions remain open; none blocks the feature.
