# Flow Check-in ← GHM Today's List, Token Number, New-Patient Form

Plan for reworking `/flow/checkin` (`src/pages/flow/FlowCheckinPage.jsx`).
Status: **implemented 2026-08-18**, except the migration, which has not been run
(`DATABASE_URL` is production — it needs an explicit go-ahead). §9 records where
the build deviated from this plan and why.

Related reading: `docs/FLOW_MANAGEMENT_PLAN.md` (why the flow module exists),
`docs/FLOW_INTEGRATION_PLAN.md` (the appointment ↔ flow bridges),
`docs/APPOINTMENT_FLOW.md` (what a GHM appointment row means).

---

## 1. What exists today

`FlowCheckinPage.jsx` (1646 lines) is a single-column form:

1. Four patient-type buttons (`TYPE_BUTTONS`) → resolve a `visit_type_id`.
2. Visit timer (start now / later), follow-up status.
3. **Patient lookup** — a free-text box that hits `GET /api/patients?q=…&limit=6`
   and, on click, runs `pickPatient(p)` (line 356).
4. Manual fields: name, file no, phone, appointment time, age/sex, notes.
5. Doctor (SD) + Chief pickers, drag-orderable journey steps.
6. `submit(sendWhatsapp)` (line 555) → upsert patient via `POST /api/patients`
   if none was picked → `POST /api/flow/checkin`.
7. Below: "Checked in today" list from `useFlowVisits()`.

`pickPatient` already does most of the auto-fill work we want to reuse. In
parallel it calls:

- `GET /api/patients/:id` → care team (SD/MO), last vitals, consultation history
- `GET /api/flow/patient-appointment?patient_db_id&file_no` → **today's**
  appointment (id, time_slot, visit_type, doctor_name, status, bill_paid)
- `GET /api/flow/patient-billing?…` → HealthRay bill → suggested journey steps

…and from that sets `appointmentId`, visit type (follow-up vs new), appointment
time, SD, chief, pending MO, and the billing-derived steps.

**Also relevant:** `ensureFlowAppointment` (`server/routes/flow.js:95`) runs after
every check-in and mirrors the visit _back_ into `appointments` — it links an
existing booking for today if it finds one (by `patient_id` or `file_no`) and
flips its status to `checkedin`; failing that, and only when
`FLOW_CREATE_APPOINTMENTS` is on, it **INSERTs a synthetic appointment**
(`booking_source='flow'`). So a manually-typed check-in whose file number
doesn't match the booking silently creates a second appointment row for a
patient who was already on the GHM list. Picking from the list sets
`appointment_id` up front and takes the cheap `syncAppointmentStatus` path
instead — reducing GHM duplicates is a real second payoff of this work, not just
a typing saving.

**The gap:** reception must already know the patient's name/file/phone to type
it. The GHM page (`/ghm`, `src/pages/GHMPage.jsx` → `GET /api/ghm-appointments`)
is where today's booked list actually lives, and it is a separate screen. So
check-in is a re-typing exercise for patients the system already knows are
coming today.

### What's missing, precisely

| Ask                                                   | Today                                                                                | Needed                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| Show all of today's GHM patients on the check-in page | Not shown at all                                                                     | A selectable list panel                     |
| Select one → auto-fill the form                       | Only via name search                                                                 | One click from the list                     |
| Fill manually when the patient isn't listed           | Works                                                                                | Keep unchanged                              |
| Token number                                          | No field, no column                                                                  | New manual field, persisted + displayed     |
| "New patient" button that captures everything         | Button exists but only **clears** the form; capture is limited to name/phone/age/sex | A proper modal with the full patient record |

---

## 2. Goals

- G1. `/flow/checkin` lists **today's GHM appointments** with live check-in state.
- G2. Clicking a row auto-fills the whole check-in form (same enrichment as
  `pickPatient`, plus the appointment link).
- G3. Manual entry still works untouched for walk-ins / unlisted patients.
- G4. A **Token number** field — free text, typed by reception — stored on the
  visit and visible everywhere the visit is (coordinator board, station, modal,
  patient tracker).
- G5. A **New patient** button opening a full registration modal, creating the
  `patients` row up-front instead of at submit time.

Non-goals: auto-assigning token numbers, changing the journey/step logic,
touching the GHM page itself, or changing how appointments are synced.

---

## 3. Data model

### 3.1 Migration — `server/migrations/2026-08-18_flow_visit_token_number.sql`

```sql
-- Reception-typed queue/token number for a flow visit (e.g. "A-14", "27").
-- Free text, NOT unique: the hospital reuses numbers across counters and days,
-- and reception must be able to mirror whatever the physical token says.
ALTER TABLE flow_visits ADD COLUMN IF NOT EXISTS token_number TEXT;

CREATE INDEX IF NOT EXISTS idx_flow_visits_token_number
  ON flow_visits (visit_date, token_number)
  WHERE token_number IS NOT NULL;
```

Run with `node migrations/_runOne.mjs migrations/2026-08-18_flow_visit_token_number.sql`
from `server/`. Also add the column to `server/schema.sql`'s `flow_visits` block
so a fresh database matches.

⚠️ Name it `token_number`, **not** `token` — `flow_visits.visit_token` already
exists and is the opaque URL token for the public tracker (`/visit/:token`).
Two different things; keeping the names far apart prevents a security-relevant
mixup (leaking `visit_token` in a UI label would expose the tracker link).

`GET /api/flow/visits` and `/flow/visits/:id` both `SELECT *`, so the column
flows to the frontend with no query changes.

### 3.2 Interaction with the one-per-patient-per-day index

`idx_flow_visits_one_per_patient_day`
(`server/migrations/2026-07-07_flow_visits_one_per_patient_day.sql`) is a unique
index on `(COALESCE(patient_db_id::text, patient_id), visit_date)` where
`status <> 'cancelled'`. Two consequences for this work:

- The picker must badge rows whose flow visit is **`completed`**, not only
  active ones — the index blocks a re-check-in of an already-seen patient, and
  the only feedback today is a 409 toast. The §4.1 LATERAL join therefore
  excludes just `cancelled`.
- The index key falls back to `patient_id` (file number) only when
  `patient_db_id` is NULL. A patient checked in manually _without_ being picked
  (no db id, file number typed) and then again via the picker (db id present)
  produces two different keys and **evades the index**; the app-level duplicate
  guard in `POST /flow/checkin` still catches it because that one ORs
  `patient_id`, `patient_db_id` and `appointment_id`. Don't weaken that guard.

Adding `token_number` changes neither.

### 3.3 No appointment-side changes

Token numbers live on the flow visit, not on `appointments` — a token is a
property of "this patient physically present in the queue today", which is
exactly what a flow visit is.

---

## 4. Backend

### 4.1 New endpoint — today's appointments for check-in

**`GET /api/flow/appointments?date=YYYY-MM-DD&q=&doctor=`** in
`server/routes/flow.js` (near the other bridges, ~line 1666).

Why a new endpoint instead of calling `/api/ghm-appointments` from the page:

- `/api/ghm-appointments` is gated on `[RECEPTION_OPS, OBT_OPS]`
  (`server/middleware/auth.js:161`) while `/flow/checkin` is `FLOW_RECEPTION`.
  Today both flow-reception roles (`reception`, `coordinator`) happen to also
  hold `RECEPTION_OPS`, so it would work _by accident_; a future
  reception-only-for-flow role would 403 on a page it can open.
- That endpoint returns ~45 columns plus follow-up-date correlated subqueries.
  The picker needs ~10 columns and must be fast enough to poll.

Query (reuse the shape of `/api/ghm-appointments`'s default mode — appointments
booked on the date **or** with `preferred_date` = the date):

```sql
SELECT a.id, a.patient_name, a.file_no, a.phone, a.time_slot,
       a.reporting_time_slot, a.visit_type, a.appointment_type,
       a.doctor_name, a.status, a.is_walkin, a.condition, a.chief_complaint,
       COALESCE(a.age, p.age) AS age, COALESCE(a.sex, p.sex) AS sex,
       p.id AS patient_db_id,
       fv.id AS flow_visit_id, fv.status AS flow_status,
       fv.token_number AS flow_token_number
  FROM appointments a
  LEFT JOIN patients p ON p.file_no = a.file_no
  LEFT JOIN LATERAL (
    SELECT id, status, token_number FROM flow_visits
     WHERE visit_date = $1
       AND (appointment_id = a.id
            OR (a.file_no IS NOT NULL AND patient_id = a.file_no))
       AND status <> 'cancelled'
     ORDER BY checkin_time DESC LIMIT 1
  ) fv ON TRUE
 WHERE (a.appointment_date = $1 OR a.preferred_date = $1)
 ORDER BY a.time_slot ASC NULLS LAST, a.id ASC
```

Response: a plain array (no paging — a clinic day is tens of rows, and reception
wants to scan the whole list). `q` filters name/file/phone server-side with the
same tokenised-AND matching used elsewhere in `ghm-appointments.js`; `doctor`
filters `doctor_name ILIKE`.

The `flow_*` fields are what let the list grey out / badge patients who are
already checked in, which is the single most useful thing on a reception screen.

**Auth:** add `["/api/flow/appointments", CAP.FLOW_RECEPTION]` to
`ROUTE_CAPABILITIES` in `server/middleware/auth.js` (with the other `/api/flow/*`
rows, ~line 214). `capabilityForPath` is a **longest-prefix** match, so row order
doesn't matter — the new row wins over the generic `/api/flow` any-of row, which
would otherwise let every station role read the booking list.

**Pool:** user request → `pool`, not `cronPool`.

### 4.2 `POST /api/flow/checkin` — accept `token_number`

In `server/routes/flow.js:622`:

- Destructure `token_number = null` from `req.body`.
- Trim and cap it (`String(token_number).trim().slice(0, 32) || null`) — it's
  free text from a form field.
- Add it to the `INSERT INTO flow_visits (…)` column list and params.

No other endpoint changes: `SELECT *` carries it out again.

**Not in scope: the check-in WhatsApp.** `sendFlowCheckin`
(`server/services/msg91.js:89`) maps a fixed six-variable body
(`patient_name, file_number, doctor_name, estimate_min, est_completion_time,
visit_link`) onto an **approved MSG91 template**. Adding the token to that
message needs a new template submitted and approved by Meta/MSG91 — a separate
task with its own lead time (see `docs/MSG91_SETUP.md`). Do not add a seventh
variable to the existing template: the positional mapping would silently shift
and send garbled messages to patients.

### 4.3 `POST /api/flow/from-appointment/:appointmentId` — pass through

That bridge (line 1738) creates a visit straight from an appointment. Accept an
optional `token_number` in its body too, so the two creation paths stay
symmetric. Low priority — do it in the same change to avoid a follow-up.

### 4.4 Optional: let reception edit a token after check-in

`PATCH /api/flow/visits/:id` doesn't exist; the closest is the per-step patches.
Add a narrow one:

**`PATCH /api/flow/visits/:id/token`** `{ token_number }` → updates the column,
touches `updated_at`, returns the visit. Gated `FLOW_RECEPTION`.
Needed because tokens get re-issued at the counter and reception should not have
to cancel + re-check-in to fix a typo. Wire it into `VisitDetailModal`.

### 4.5 Patient creation

`POST /api/patients` (`server/routes/patients.js:415`) already upserts by
`file_no` / `abha_id`, auto-mints `GNI-#####`, and accepts every field the new
modal needs (`patientCreateSchema` in `server/schemas/index.js:88`: name, phone,
dob, age, sex, file_no, abha_id, health_id, aadhaar, govt_id, govt_id_type,
email, address). **No backend change needed for the new-patient form.**

Note `sex` is a strict enum: `"Male" | "Female" | "Other"`. The modal must send
exactly those strings — the existing check-in form's loose `form.sex` is a
latent 400 today and gets fixed as part of this work.

---

## 5. Frontend

### 5.1 Query hooks — `src/queries/hooks/useFlow.js`

```js
// Today's GHM/OPD appointments, annotated with flow check-in state.
// Polls like the other live reads (the flow tables aren't realtime-visible).
export function useFlowAppointments(date = today(), { q, doctor } = {}, options = {}) {
  return useQuery({
    queryKey: qk.flow.appointments(date, q, doctor),
    queryFn: async () => {
      const p = new URLSearchParams({ date });
      if (q) p.set("q", q);
      if (doctor) p.set("doctor", doctor);
      return (await api.get(`/api/flow/appointments?${p}`)).data;
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
    ...options,
  });
}
```

Add the key to `src/queries/keys.js` (the `flow` block ends at line 49):

```js
appointments: (date, q, doctor) => ["flow", "appointments", date, q || null, doctor || null],
```

Also add `qk.flow.appointments`-prefixed invalidation to `useFlowCheckin`'s
`onSuccess` (it currently invalidates only the visits keys). Without it the
picked row keeps looking un-checked-in for up to 30 s after a successful
check-in — the exact window in which reception would click it again.
30 s (vs the 15 s used for visits) — the booking list changes far more slowly
than the queue, and this is a reception screen left open all day.

### 5.2 Layout

The page is currently one column of form. Make it two panes on wide screens
(`grid-template-columns: minmax(320px, 380px) 1fr`, stacking under ~1000px so
the existing tablet use keeps working):

```
┌─ Today's patients (GHM) ─────┐ ┌─ Check in ───────────────────────┐
│ [search…]  [doctor ▾] [⟳]    │ │ (existing form, unchanged order) │
│ 09:00  Surinder Jit  GNI-…   │ │  type buttons                    │
│        FU · Dr. X   ✅ in    │ │  timer / FU status               │
│ 09:15  Kamal Kaur   GNI-…    │ │  Find patient  [+ New patient]   │
│        NEW · Dr. Y           │ │  name / file / phone / time      │
│ …                            │ │  Token number  ← new             │
│ [+ Patient not in this list] │ │  SD / Chief / journey steps      │
└──────────────────────────────┘ └──────────────────────────────────┘
```

New component: **`src/components/flow/AppointmentPicker.jsx`** + no new CSS file
— reuse `src/styles/flow.css` classes (`flow-card`, `flow-btn`, `flow-muted`,
`flow-field`, `flow-toggle`); add any new rules there to match the
one-`.css`-per-area convention.

Props: `{ date, selectedAppointmentId, onPick }`.

Each row shows: reporting/appointment time · patient name · file no ·
age/sex · visit type chip (FU / NEW / WALK-IN) · doctor · status badge.

Row states:

- **available** — clickable.
- **already seen** — `a.status` in `seen` / `completed`, or a `completed` flow
  visit: shown greyed with the outcome, not offered for check-in.
  `reconcileFromAppointments` (`server/routes/flow.js:~160`) completes flow
  visits from those appointment statuses, so the two agree. Note `no_show` is
  deliberately **not** terminal (the Sheets sync defaults rows to `no_show`
  until the patient is marked present) — `no_show` rows stay clickable.
- **checked in** — green "✅ Checked in" badge + token number if set; click
  opens the existing `VisitDetailModal` for that visit instead of re-filling
  the form (prevents the duplicate-check-in 409 from being the only feedback).
- **selected** — highlighted; matches the currently loaded form.

Empty state: "No appointments for today" + a hint that manual entry still works.

### 5.3 `pickAppointment(appt)` in `FlowCheckinPage`

Refactor `pickPatient` so the enrichment is shared. Concretely, split it:

```js
// Fill the form from a patients-table row (existing behaviour).
const applyPatient = (p) => {
  /* setForm / setPatientDbId / setAgeSexVal / resets */
};

// Fetch context (patient detail + today's appointment + billing) and apply it.
const loadContext = async ({ patientDbId, fileNo }) => {
  /* the Promise.all block */
};

const pickPatient = async (p) => {
  applyPatient(p);
  await loadContext({ patientDbId: p.id, fileNo: p.file_no });
};

const pickAppointment = async (a) => {
  if (a.flow_visit_id) return setDetailId(a.flow_visit_id); // already checked in
  applyPatient({
    id: a.patient_db_id,
    name: a.patient_name,
    file_no: a.file_no,
    phone: a.phone,
    age: a.age,
    sex: a.sex,
  });
  setAppointmentId(a.id); // link the visit to the booking
  setTypeKey(deriveTypeKey(a)); // see below
  const hhmm = parseSlotToHHMM(a.reporting_time_slot || a.time_slot);
  if (hhmm) setForm((f) => ({ ...f, appt_time: hhmm }));
  if (a.patient_db_id) await loadContext({ patientDbId: a.patient_db_id, fileNo: a.file_no });
  else
    setContext({
      appt: {
        time_slot: a.time_slot,
        visit_type: a.visit_type,
        doctor_name: a.doctor_name,
        status: a.status,
      },
    });
};
```

`deriveTypeKey(a)`: `is_walkin` (or `appointment_type` matching /walk/i) chooses
the walk-in variants; `/follow|f\/?u|review/i` on `visit_type` chooses follow-up
— i.e. the same regex `pickPatient` uses today, extended to the walk-in axis so
`fu_walk` / `new_walk` can be selected automatically. Reception can still
override with the type buttons; picking a row must never lock the form.

**A GHM row with no `patient_db_id`** (booked patient not yet in `patients`)
must still work: the form fills from the appointment columns, `patientDbId`
stays null, and `submit()`'s existing upsert path creates the record and mints
the file number. This is the common case for a first-time booking.

Also: when `loadContext` finds a _different_ appointment than the one clicked,
the clicked one wins — `setAppointmentId(a.id)` after the await, or pass an
`appointmentId` override into `loadContext`. Otherwise a patient with two
bookings today gets linked to the wrong row (the endpoint's `ORDER BY id DESC
LIMIT 1`).

### 5.4 Token number field

In the form grid, next to "Appointment time":

```jsx
<div className="flow-field">
  <label>Token number</label>
  <input
    value={form.token_number}
    onChange={(e) => setForm({ ...form, token_number: e.target.value.slice(0, 16) })}
    placeholder="e.g. 27 or A-14"
  />
</div>
```

- Added to the `form` initial state and to every reset (`submit` success reset,
  the New-patient clear button, `applyPatient`).
- Free text, **optional**, not validated — the ask is explicitly "just make it
  manually type". No auto-increment, no uniqueness check.
- Sent in the check-in payload as `token_number`.
- Displayed after check-in:
  - "Checked in today" rows on this page — a `#27` chip before the name.
  - `src/components/flow/VisitDetailModal.jsx` — show + (with §4.4) edit it.
  - `src/pages/flow/FlowCoordinatorPage.jsx` and `FlowStationPage.jsx` cards —
    calling a patient by token is the whole point of having one.
  - Not in `/api/flow/reports` / its CSV export — analytics are per visit-type
    and timing, and a free-text counter number adds nothing there. Revisit only
    if reception asks to reconcile against physical token slips.
  - `GET /flow/track/:token` (the public tracker payload, `server/routes/flow.js:2008`)
    — **decide deliberately.** Including `token_number` helps the patient match
    the slip in their hand; it is not sensitive on its own. Recommend including
    it, since the payload is already patient-scoped and sanitized.

### 5.5 New-patient modal

Replace the current "New patient" ghost button (which only clears fields) with
one that opens **`src/components/flow/NewPatientModal.jsx`**.

Fields (mapping 1:1 onto `patientCreateSchema`):

| Field               | Input                                             | Required               |
| ------------------- | ------------------------------------------------- | ---------------------- |
| Name                | text                                              | ✅                     |
| Phone               | +91 + 10 digits (reuse the existing masked input) | ✅ (WhatsApp needs it) |
| Age                 | number                                            | one of age/dob         |
| DOB                 | date                                              | —                      |
| Sex                 | Male / Female / Other buttons                     | ✅ (strict enum)       |
| Address             | text                                              | —                      |
| Email               | email                                             | —                      |
| File number         | text, blank = auto `GNI-#####`                    | —                      |
| ABHA id / Health id | text                                              | —                      |
| Aadhaar             | text (encrypted server-side)                      | —                      |
| Govt id + type      | text + select                                     | —                      |

Behaviour:

1. Before saving, call the existing `GET /api/patients/check-duplicate`
   (`server/routes/patients.js:157`) on phone/name and warn — reception creating
   a second record for an existing patient is the main failure mode here, and it
   corrupts the patient's history permanently.
2. `POST /api/patients` → returns the row incl. the minted `file_no` and
   `_isNew`.
3. On success: close, `applyPatient(row)`, set `typeKey` to `new_appt` /
   `new_walk`, focus the token field. The patient now exists, so `submit()`
   skips its upsert.
4. On failure: keep the modal open, show the server error inline.

Keep a plain "Clear form" ghost button for the old behaviour — reception uses it
to abandon a half-filled form, and silently repurposing the button would break
that habit.

### 5.6 RBAC

No new page → no `src/config/routes.js` change. The only capability work is
§4.1's `/api/flow/appointments` row. Verify with:

```bash
node server/scripts/verify-rbac.mjs
```

---

## 6. Edge cases

| Case                                                                         | Behaviour                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patient already checked in today                                             | Row badged; click opens the visit modal. Backend 409 (`DUPLICATE_CHECKIN`) remains the backstop.                                                              |
| Appointment row with no `patients` record                                    | Form fills from appointment columns; `submit()` creates the patient and mints the file no.                                                                    |
| Two bookings for the same patient today                                      | Clicked appointment id wins over the one `patient-appointment` returns.                                                                                       |
| Walk-in not on the GHM list                                                  | Manual path, unchanged; "Patient not in this list" button just clears + focuses the name field.                                                               |
| Token typed but check-in fails                                               | Preserved in the form (only the success path resets).                                                                                                         |
| Duplicate token on the same day                                              | Allowed, no warning. Non-unique by design (§3.1).                                                                                                             |
| Cancelled flow visit                                                         | LATERAL join excludes `cancelled`, so the row is re-checkable.                                                                                                |
| `sex` free text from GHM (`"M"`, `"male"`)                                   | Normalise to the enum before sending to `POST /api/patients`, else 400.                                                                                       |
| Appointment already `seen` / `completed`                                     | Row greyed, not checkable — matches the unique index that would 409 anyway.                                                                                   |
| Appointment marked `no_show`                                                 | Still checkable (the Sheets sync defaults to `no_show`).                                                                                                      |
| Picked row is a booking the patient never had (wrong file_no on the GHM row) | Reception can clear the linked appointment via "Patient not in this list"; `appointment_id` resets to null and `ensureFlowAppointment` re-resolves on submit. |
| Same patient on the list twice (booking + preferred_date row)                | Both render; checking in either links that id and the other row badges via the file-number arm of the LATERAL join.                                           |
| Date ≠ today                                                                 | The picker takes a `date` prop but ships pinned to today; `flow_visits.visit_date` defaults to `CURRENT_DATE`, so back-dated check-in is out of scope.        |

---

## 7. Implementation order

1. **Migration + schema.sql** — `token_number` column. (§3.1)
2. **Backend** — `GET /api/flow/appointments`, `token_number` on
   `POST /flow/checkin`, capability row, optional `PATCH …/token`. (§4)
3. **Hook + key** — `useFlowAppointments`, plus the `useFlowCheckin`
   invalidation. (§5.1)
4. **Refactor** — split `pickPatient` into `applyPatient` + `loadContext`, no
   behaviour change. Verify the existing search path still works before moving on.
5. **`AppointmentPicker`** + two-pane layout + `pickAppointment`. (§5.2–5.3)
6. **Token field** through form → payload → the display surfaces. (§5.4)
7. **`NewPatientModal`**. (§5.5)
8. `npm run format`, `node server/scripts/verify-rbac.mjs`.

Steps 1–3 are independently shippable; 4 is a pure refactor and worth its own
commit so 5 stays reviewable.

---

## 8. Manual test checklist

There is no test suite — this is the acceptance pass.

1. `/flow/checkin` lists today's appointments, ordered by time.
2. Pick a known follow-up patient → name, file, phone, age/sex, time, visit type,
   SD, chief, MO, and billing-derived steps all fill; check in; the row flips to
   "✅ Checked in" within one poll.
3. Pick a booked patient with **no** `patients` row → check in → a `GNI-#####`
   patient record is created and linked.
4. Type a token, check in, confirm it appears in "Checked in today", the visit
   modal, the coordinator board and the station card.
5. Re-click a checked-in row → visit modal opens, no 409 toast.
6. New patient modal → duplicate warning fires on a known phone; saving a fresh
   one mints a file number and pre-fills the form.
7. Fully manual walk-in (no picker use) → unchanged behaviour end to end.
   7b. After a picked check-in, confirm **no new `appointments` row** was created
   (`SELECT count(*) … WHERE booking_source='flow' AND appointment_date=CURRENT_DATE`
   is unchanged) and the picked appointment's status is now `checkedin`.
   7c. The picked row flips to "✅ Checked in" immediately on success, not after the
   30 s poll (proves the invalidation in §5.1).
8. Log in as a `coordinator` and as a `reception` account: both can load the
   picker. Log in as a station role (`nurse`): `/api/flow/appointments` 403s.

⚠️ `.env`'s `DATABASE_URL` is **production**. Test check-ins create real
`flow_visits` rows — cancel them afterwards, and never run the migration against
production without confirming with the user first.

---

## 9. What changed during implementation

Five things came out differently once the code was in front of me. Recorded here
so the plan matches the branch.

1. **Three columns, not two.** The check-in screen was _already_ a two-column
   grid (form | journey builder), which §5.2 missed. The picker is a third
   column (`.flow-checkin-3col`, 290–330px). Below 1280px it moves to its own
   full-width row above the other two rather than squeezing them — the journey
   builder's step rows are a five-column grid and go unreadable narrow. Below
   800px everything stacks.

2. **The invalidation gap in §5.1 doesn't exist.** `useFlowMutation` already
   invalidates `qk.flow.all` (`["flow"]`), which is a prefix of the new
   `["flow","appointments",…]` key, so a successful check-in refreshes the
   picker with no extra wiring. No change was made.

3. **`schema.sql` needed no edit.** `flow_visits` is defined only in
   `2026-06-15_flow_management.sql`; the flow tables were never mirrored into
   `server/schema.sql`. The migration is the whole change.

4. **A shared classifier replaced the inline regexes** —
   `src/lib/flowAppointmentType.js`. Checking real data (60 days) showed the
   plan's two-way follow-up/new split was too coarse for what HealthRay
   actually stores: `Follow-Up` 3774 · `OPD` 2545 · `New Patient` 762 ·
   `Investigation` 382 · `Tele` 173.
   - `Investigation` is a **tests-only visit by an existing patient** (GHM
     defaults its doctor to "Dr. Hospital Admin"). §5.3's rule would have made
     each one a _New + Appointment_. It now maps to follow-up with
     `testsAvailable = false` — the `FU_APPT_TESTS` benchmark, since the patient
     is arriving to give samples, not collect reports. (The type buttons' meta
     text says "≤ 45 min / ≤ 90"; the live `flow_visit_types` rows are
     `FU_APPT` 120 and `FU_APPT_TESTS` 90. Those labels are stale against the
     admin-edited table — a separate fix, not touched here.)
   - `Tele` gets an amber TELE chip: pickable, because those patients do
     sometimes turn up, but visibly not a physical arrival.
   - **`is_walkin` is not consulted at all** (§5.3 assumed it was the walk-in
     axis). HealthRay sets it on 6702 of 7636 bookings — 6481 of those with a
     real OBT-booked time slot — so trusting it put 103 of today's 121 rows on a
     walk-in type. `FU_WALK` budgets 90 min against `FU_APPT`'s 120, so 81
     follow-ups would have been given an ETA half an hour short plus the
     walk-in journey template. Reception chose `FU_WALK` 0 times and `NEW_WALK`
     twice across 1304 check-ins in 30 days. The classifier now always returns
     an appointment type (a row in `appointments` _is_ a booking); the walk-in
     buttons stay one click away. Re-run over today's list: 99 `fu_appt`,
     22 `new_appt`, 0 walk-in.
   - `OPD` is genuinely ambiguous — it's the generic type both HealthRay and our
     own `ensureFlowAppointment` write. It's flagged `ambiguous` and settled
     from the patient's consultation history once `loadContext` returns: any
     prior consultation ⇒ follow-up; none ⇒ new patient. `loadContext` now
     returns the patient record so the caller can do that.

5. **The token PATCH carries its own `requireCapability`.** The route table
   can't reach past `/api/flow/visits` (ids are dynamic), so the prefix matcher
   would have left `PATCH /flow/visits/:id/token` on the base any-of row and let
   a station role renumber the queue. It's gated
   `[FLOW_RECEPTION, FLOW_COORDINATOR]` at the route, the same pattern the
   admin-only flow writes use.

Two smaller ones: the "New patient" button now opens the modal and a separate
**Clear** button keeps the old clear-the-form behaviour (§5.5 asked for this);
and `POST /api/patients` from the check-in path now normalises `sex` through the
same `Male|Female|Other` mapper — a latent 400 whenever a GHM row's `"M"` was
carried into the form.

### Verified

- `npm run build` — clean; `prettier --check` clean.
- `node server/scripts/verify-rbac.mjs` — 67/67, including the new row.
- **Migration applied to production** (2026-08-18): `flow_visits.token_number`
  (text, nullable) + the partial index; no existing rows affected.
- The §4.1 query against production for today: **121 rows in 54 ms**, flow state
  joining correctly (`completed` / `in_progress` / none).
- All five touched routes mounted — checked by importing the router directly,
  which avoids `routes/opd.js`'s boot-time backfills.
- The check-in `INSERT`'s new 24-column list executed inside a transaction and
  rolled back: returns `token_number`, leaves no row behind.

### Review fixes (post-implementation)

- **`is_walkin` axis removed** — see the classifier bullet in §9.4.
- **`applyPatient` now clears `token_number`.** §5.4 named it as a reset point
  and the first implementation missed it: the `setForm` spread preserved the
  field, so a token typed for patient A survived picking patient B and would
  have been checked in against the wrong person. `resetForm` always cleared it,
  so this only reached the pick-without-submit path.

Two other review findings were investigated and dropped: `schema.sql` has no
flow block to update (the flow tables live only in the 2026-06-15 migration),
and the token editor is not reachable by station roles — `StationQueue.jsx` only
mentions `VisitDetailModal` in a comment; it is rendered solely by the reception
and coordinator pages.

### Still outstanding

- The §8 runtime checklist (items 1–7) is unrun. Those steps create real
  `flow_visits` rows in production, so they want a deliberate pass.
