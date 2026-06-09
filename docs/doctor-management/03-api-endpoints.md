# 03 — API Endpoints

> New router `server/routes/doctorSchedule.js`, mounted in `server/index.js`
> alongside the others (`app.use("/api", doctorScheduleRoutes)`). Plus targeted
> changes to the existing `appointments` and `appointment-slots` routes.
>
> RBAC: schedule **writes** require `CAPABILITIES.ADMIN` (manage doctors) or a
> new `CAPABILITIES.SCHEDULE_MANAGE`; **reads** require `RECEPTION_OPS` (so
> reception sees availability while booking). `GRANT_ALL_CAPABILITIES` is `true`
> today, so guards are declared but permissive until the matrix is enabled —
> see `shared/permissions.js`.

Conventions follow the repo: `Router()`, `pool` from `config/db.js`,
`handleError(res, e, label)`, Zod via `validate(schema)` from
`middleware/validate.js`, schemas added to `server/schemas/index.js`.

---

## 1. Slot catalog

| Method | Path | Purpose | Cap |
|--------|------|---------|-----|
| GET | `/api/slot-catalog` | List slots `{label,start_time,end_time,sort_order}` | read |
| POST | `/api/slot-catalog` | Add a slot (rare) | ADMIN |
| PATCH | `/api/slot-catalog/:id` | Edit times / deactivate | ADMIN |

`appointment-slots.js` keeps `GET /appointment-slots/time-slots` working but it
should read labels from `slot_catalog` (fallback to the hardcoded `TIME_SLOTS`
if the table is empty during rollout).

---

## 2. Weekly schedule (Layer 0)

| Method | Path | Purpose | Cap |
|--------|------|---------|-----|
| GET | `/api/doctors/:id/schedule` | Full weekly grid for one doctor → `[{weekday, slot_label, capacity}]` | read |
| PUT | `/api/doctors/:id/schedule` | **Replace** the whole weekly grid (idempotent set) | SCHEDULE_MANAGE |
| GET | `/api/doctors/schedules?weekday=2` | All doctors working a given weekday (overview) | read |

`PUT` body:
```json
{ "slots": [ { "weekday": 1, "slot_label": "10 AM to 11 AM", "capacity": 5 }, … ] }
```
Implementation: in a transaction, `DELETE` the doctor's existing rows and
`INSERT` the new set (or diff). Validate every `slot_label ∈ slot_catalog` and
`weekday ∈ 0..6`. Empty `slots` = doctor works nothing (effectively off-grid).

---

## 3. Recurring breaks (Layer 2)

| Method | Path | Purpose | Cap |
|--------|------|---------|-----|
| GET | `/api/doctors/:id/breaks` | List recurring breaks | read |
| POST | `/api/doctors/:id/breaks` | Add `{weekday?, slot_label, reason}` (weekday null = daily) | SCHEDULE_MANAGE |
| DELETE | `/api/doctors/:id/breaks/:breakId` | Remove a break | SCHEDULE_MANAGE |

---

## 4. Leave / emergency unavailability (Layers 3 & 4)

| Method | Path | Purpose | Cap |
|--------|------|---------|-----|
| GET | `/api/doctors/:id/unavailability?from=&to=` | List leave/emergency windows | read |
| POST | `/api/doctors/:id/unavailability` | Create leave / per-doctor holiday | SCHEDULE_MANAGE |
| POST | `/api/doctors/:id/emergency-leave` | Create **emergency** + return affected patients (see §6) | SCHEDULE_MANAGE |
| PATCH | `/api/doctors/:id/unavailability/:uid` | Edit window / cancel (`status='cancelled'`) | SCHEDULE_MANAGE |

`POST …/unavailability` body:
```json
{
  "type": "leave",              // 'leave' | 'holiday'
  "start_date": "2026-06-20",
  "end_date":   "2026-06-22",
  "slot_labels": null,          // null = whole day(s); or ["1 PM to 2 PM", …]
  "reason": "Conference"
}
```
On create, the handler should **check for already-booked patients in the
window** and, if any, return them in the response (`affected: [...]`) with
`requires_reassignment: true` so the UI can prompt — even for planned leave.

---

## 5. Availability (reads used by booking UI)

| Method | Path | Purpose | Cap |
|--------|------|---------|-----|
| GET | `/api/doctors/:id/availability?date=` | One doctor's day → annotated slots (resolver §2) | read |
| GET | `/api/availability?date=&slot=` | All doctors available for a date+slot (booking/reassign picker) | read |
| GET | `/api/availability/doctors-for-slot?date=&slot=&exclude=&role=` | Ranked reassignment candidates (resolver §3) | read |

These supersede / wrap the existing `GET /appointment-slots/availability`
(keep it as a thin alias that now also consults weekly schedule + breaks +
per-doctor leave, not just clinic holiday + manual block).

---

## 6. Emergency leave + reassignment (the headline flow)

### 6a. Declare emergency leave (returns affected patients)

`POST /api/doctors/:id/emergency-leave`
```json
{
  "start_date": "2026-06-08",
  "end_date":   "2026-06-08",
  "slot_labels": null,          // null = rest of today / whole window
  "from_now": true,             // optional: only slots whose start_time >= current time
  "reason": "Sudden illness"
}
```
Response:
```json
{
  "unavailability_id": 42,
  "doctor": { "id": 7, "name": "Dr. Anil Bhansali" },
  "affected": [
    { "appointment_id": 901, "patient_name": "…", "file_no": "GNI-00123",
      "appointment_date": "2026-06-08", "time_slot": "11 AM to 12 PM",
      "phone": "…", "in_progress": false,
      "suggested_doctors": [
        { "doctor_id": 9, "doctor_name": "Dr. …", "role": "consultant", "free_capacity": 3, "same_specialty": true },
        …
      ] }
  ],
  "requires_reassignment": true
}
```
Server steps: insert `doctor_unavailability(type='emergency')` →
`getAffectedAssignments` → for each, attach `findAvailableDoctors`. Patients with
`in_progress=true` (live `active_visits`) are listed but flagged not-movable.

### 6b. Apply reassignments (bulk)

`POST /api/appointments/reassign`
```json
{
  "trigger": "emergency_leave",
  "unavailability_id": 42,
  "moves": [
    { "appointment_id": 901, "to_doctor_id": 9, "to_doctor_name": "Dr. …" },
    { "appointment_id": 905, "to_doctor_id": 9, "to_doctor_name": "Dr. …" }
  ],
  "reason": "Dr. Bhansali emergency leave"
}
```
Per move, in one transaction:
1. Re-check `isSlotAvailable(to_doctor, date, slot)` — reject the move if the
   target filled up meanwhile (return `{appointment_id, error:'target_full'}`;
   partial success allowed, report per-row).
2. `UPDATE appointments SET doctor_name=$to, doctor_id=$toId WHERE id=$apptId`.
3. `INSERT appointment_reassignments(...)` audit row.
4. Mirror to `active_visits` if a row exists for that appointment.
   > ⚠️ **Verified:** `appointments.js` currently does **not** read or write
   > `active_visits` at all (that table is owned by the active-visits / OPD
   > routes). This mirror step is therefore *net-new* wiring — update
   > `active_visits.doctor_name`/`doctor_id WHERE appointment_id=$1` so an
   > already-checked-in patient's live queue card follows the reassignment.
   > If you'd rather keep concerns separated, emit an event the active-visits
   > route handles instead of writing the table from here.
Response: `{ moved: [...], failed: [{appointment_id, error}] }`. After all
done, set `doctor_unavailability.reassignment_done=true` when no `failed`
remain unhandled.

### 6c. Single manual reassignment

`PUT /api/appointments/:id/reassign  { to_doctor_id, to_doctor_name, reason }`
— same logic for one row (used outside the emergency flow, e.g. balancing load).

---

## 7. Enforcement changes to existing routes

### `POST /api/appointments` (`server/routes/appointments.js:65`)
Before the `INSERT`, when `doctor_name`, `appointment_date`, `time_slot` are all
present:
```
docId = resolve_doctor_id(doctor_name)
if docId:
    a = await isSlotAvailable(docId, appointment_date, time_slot)
    if not a.available and not (req.body.force && hasCapability(ADMIN)):
        return 409 { error:'doctor_unavailable', reason:a.reason, detail:a.detail }
```
- `409 Conflict` with a machine-readable `reason` (`not_working`,
  `clinic_holiday`, `break`, `leave`, `emergency`, `manual_block`, `full`).
- `force=true` + ADMIN capability overrides (logged via audit + a
  `notes` annotation). This preserves the existing walk-in/edge behaviors for
  admins while blocking normal overbooking.
  > ⚠️ **Verified gotcha:** `middleware/validate.js` runs `req.body =
  > schema.parse(req.body)`, and Zod `z.object()` **strips unknown keys**. A
  > `force` field sent in the body is silently dropped before the handler runs.
  > So you MUST either (a) add `force: optBool` to `appointmentCreateSchema` /
  > `appointmentUpdateSchema` in `server/schemas/index.js`, or (b) read it from
  > the query string (`req.query.force`, which is validated by a separate query
  > schema or not at all). Recommendation: add `force` to the schemas. The
  > capability check is `hasCapability(req.doctor.role, CAPABILITIES.ADMIN)`
  > (confirmed present in `middleware/auth.js:206`).
- If `doctor_name` does **not** resolve to a doctor → **do not block** in v1
  (legacy/unknown names pass through). Log a warning; the Phase-0 audit
  (Doc 01 §0) should drive these to zero before strict mode.

### `PUT /api/appointments/:id` (`appointments.js:205`)
When the update changes `doctor_name`, `appointment_date`, or `time_slot`, run
the same `isSlotAvailable` check on the *new* target. Reassignments that go
through `/reassign` already re-check; this guards ad-hoc edits.

### `POST /api/appointment-slots/availability` alias
Update its body to call the resolver so it reflects weekly schedule + breaks +
per-doctor leave (today it only sees clinic holiday + manual block + booked).

---

## 8. Feature flag

All enforcement sits behind a single env/config flag, e.g.
`SCHEDULE_ENFORCEMENT=off|warn|strict` (read in `appointments.js`):
- `off` — resolver not consulted on write (current behavior). Schedule data can
  still be entered and viewed.
- `warn` — compute availability, attach a `warning` to the response, but still
  insert. (Shadow / observability phase.)
- `strict` — `409` on unavailable (with ADMIN `force` override).

Default `off` at deploy; flip to `warn`, then `strict` after the data audit.
See Doc 06.

---

## 9. Validation schemas (add to `server/schemas/index.js`)

- **Extend** `appointmentCreateSchema` + `appointmentUpdateSchema` with
  `force: optBool` (else Zod strips it — see §7 gotcha).
- `weeklyScheduleReplaceSchema` — `{ slots: [{weekday:0..6, slot_label:string, capacity:int>=0}] }`
- `breakCreateSchema` — `{ weekday:0..6|null, slot_label:string, reason?:string }`
- `unavailabilityCreateSchema` — `{ type:'leave'|'holiday', start_date:date, end_date:date>=start, slot_labels?:string[]|null, reason?:string }`
- `emergencyLeaveSchema` — `{ start_date, end_date, slot_labels?, from_now?:bool, reason?:string }`
- `reassignBulkSchema` — `{ trigger:string, unavailability_id?:int, moves:[{appointment_id:int, to_doctor_id:int, to_doctor_name:string}], reason?:string }`

All `slot_label` values validated against `slot_catalog` at the handler (Zod
checks shape; DB FK + a membership query checks existence).
