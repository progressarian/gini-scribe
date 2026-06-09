# 08 — Wire booking to availability + enable warn mode

> **Status:** PLAN — awaiting sign-off before implementation.
> Goal: make the doctor-availability the system already computes actually
> influence patient booking — first in **warn** mode (surface, don't block),
> then **strict**.

## A. Current state (verified in code)

**Two — and only two — places insert into `appointments`:**

| Path | Used by | Slot format | Enforcement today |
|------|---------|-------------|-------------------|
| `POST /api/appointments` | **OPD** quick-add modal (`src/OPD.jsx`) | **free `type=time`** input → `"09:30"` | gate present, behind `SCHEDULE_ENFORCEMENT` flag (off) |
| `POST /api/ghm-appointments` | **GHM** `NewAppointmentModal` (`src/pages/GHMPage.jsx`) | **catalog slot** dropdown → `"1 PM to 2 PM"` | **none** |

Other facts:
- The resolver matches **catalog slot labels**. GHM uses them (perfect fit); OPD
  sends free clock times that are **not** catalog labels → resolver returns
  `unknown_slot`.
- `SCHEDULE_ENFORCEMENT` defaults to `off`.
- `GET /api/doctors` returns `id, name, short_name, specialty` (public) — usable
  to resolve a doctor *name* → *id*.
- Companion `DoctorSelect` does **not** book. Patient-app and walk-ins don't have
  their own insert — they go through the two paths above.

## B. Design decisions

1. **Unknown / non-catalog slots pass through (never blocked).** OPD's free-time
   slots aren't catalog slots, so gating them would wrongly block OPD. Rule: if
   the slot isn't a recognized catalog label (`reason==='unknown_slot'`), allow
   the booking. → Only **catalog-slot bookings (GHM)** are actually enforced in
   v1. (Same philosophy as "unknown doctor name → pass through".)
2. **Enforce on both insert paths** using the one `SCHEDULE_ENFORCEMENT` flag, so
   behavior is consistent and there's a single switch.
3. **Warn first.** `warn` = log the would-be block + attach
   `_availability_warning` to the response, but still insert. The UI greys
   unavailable slots so reception *sees* them; warn guarantees nothing breaks.
   Flip to `strict` later (rejects with 409, admin `force` override).
4. **Booking UI reads availability by doctor _name_.** The modals work with
   `doctor_name`, so add a name-based day-availability endpoint instead of making
   each modal resolve ids.

## C. Backend changes

1. **New read endpoint** (`server/routes/doctorSchedule.js`):
   `GET /api/availability/day?doctor=<name>&date=<YYYY-MM-DD>`
   → `resolve_doctor_id(name)`; if unresolved → `{ resolved:false, slots:[] }`;
   else → `{ resolved:true, slots: getDoctorDayAvailability(id, date) }`.
   Used by both booking modals.

2. **`appointments.js`** — in `checkAvailability`, treat `unknown_slot` as
   pass-through:
   ```js
   const a = await isSlotAvailable(doctorId, date, slot);
   if (a.available || a.reason === "unknown_slot") return null;  // ← add
   ```
   (So OPD free-time bookings are never blocked.)

3. **`ghm-appointments.js`** — add the same gate to `POST /api/ghm-appointments`
   before its `INSERT`:
   - resolve `doctor_name` → id; if unresolved → skip (pass through).
   - `isSlotAvailable(id, appointment_date, time_slot)`; `unknown_slot`/available
     → allow.
   - `warn` → attach `_availability_warning` to the JSON response + `console.warn`.
   - `strict` → `409 {error:'doctor_unavailable', reason}` unless `force` + ADMIN.
   - Factor the logic into a shared helper (`server/services/bookingGuard.js`)
     imported by both routes, so there's no copy-paste drift.

4. **`.env`** — add `SCHEDULE_ENFORCEMENT=warn`.

## D. Frontend changes

5. **GHM `NewAppointmentModal`** (the main one — uses catalog slots):
   - When `doctor_name` + `appointment_date` are both set, fetch
     `GET /api/availability/day?doctor=&date=`.
   - Render the **Time Slot** `<select>` from the returned slots:
     - available → normal option.
     - blocked → `disabled`, label shows the reason, e.g.
       `1 PM to 2 PM — Break`, `10 AM to 11 AM — On leave`.
     - `resolved:false` (name not a real doctor) → fall back to plain
       `TIME_SLOTS` (no restriction).
   - On submit, if the response carries `_availability_warning`, show a toast
     (“Heads-up: 1 PM to 2 PM is a break”) but proceed (warn mode).
   - Re-fetch when doctor or date changes.

6. **OPD quick-add modal** (free-time input) — *optional, lighter*:
   - Keep the free `type=time` input. Add a soft **day-level** check: when a
     doctor + date is chosen, call the same endpoint and, if the day is
     `day_off` / `leave` / `holiday`, show an inline warning ("Dr X is on leave
     this day"). No hard block (free-time slots pass through anyway).
   - **Decision needed** (see §F): leave OPD as free-time, or convert it to the
     catalog slot dropdown so it's enforced like GHM.

## E. Testing

- **Smoke / unit:** the new `/availability/day` endpoint (resolved + unresolved);
  GHM gate in warn (attaches warning, still inserts) and strict (409); OPD
  free-time slot passes through (`unknown_slot` → allowed).
- **Manual:** GHM modal greys lunch/leave/off-hours slots for a configured
  doctor; an unconfigured doctor shows all slots; OPD free-time still books;
  warn logs appear server-side.

## F. Open decision (need your call)

**OPD booking uses a free time field, not slots.** Options:
- **(a) Recommended for now:** leave OPD as free-time → it is *not* slot-enforced,
  only gets a soft "doctor on leave" day warning. GHM (the structured booking) is
  fully wired. Least disruptive.
- **(b)** Convert OPD's time field to the catalog slot dropdown too, so OPD
  bookings are enforced identically to GHM. More change to a screen people use
  for quick walk-ins.

## G. Rollout

1. Ship C+D with `SCHEDULE_ENFORCEMENT=warn`.
2. Watch server warn logs for ~a week — fix any false "unavailable" (usually a
   doctor with no profile, or a name that doesn't resolve).
3. Flip `.env` to `strict`. Admin `force=true` override stays for genuine
   overrides.

## H. Risks / notes

- Only **catalog-slot (GHM)** bookings are enforced in v1; OPD free-time is
  pass-through by design (decision F).
- The GHM slot dropdown is long (28 slots, 24h) — greying makes it clearer.
- Single flag controls both paths — one switch to roll back to `off`.
