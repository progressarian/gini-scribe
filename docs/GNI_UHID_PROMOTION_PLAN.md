# Bookings keep a stale GNI number after the patient gets a UHID — Plan

Status: draft, awaiting review. Data fix for the two upcoming bookings applied on 2026-10-15; no code changed yet.

## 1. The problem

A patient booked by the call team before they have a HealthRay chart gets a temporary Scribe number (`GNI-xxxxx`, made in `routes/ghm-appointments.js` / `routes/appointments.js`). When they later register at the hospital, the HealthRay sync recognises the same person by phone and name and upgrades the **patient** record to the real UHID (`P_xxxxxx`) in `services/healthray/db.js` (the `matchIdentitylessByPhone` branch, about line 524).

Each **appointment** keeps its own copy of the number (`appointments.file_no`), written at booking time. Nothing updates those copies when the patient is upgraded, so older bookings keep showing the dead GNI number.

Example (2026-10-15): Sunita — patient 53494, GNI-00138 → P_182201 on 15 Oct.

- Her 15 Oct visit (from HealthRay) shows P_182201.
- Her 16 Oct booking (made 26 Sep) showed GNI-00138.
- The GHM screen and the WATI CSV listed her for 16 Oct as a new patient, although she had already been seen on 15 Oct.

### Why it matters beyond the label

These GHM services match a patient's bookings **by `appointments.file_no`**, not by `patient_id`:

- `ghmDayWindow.js`: `prev.file_no = a.file_no`, `later.file_no = …`, `booked.file_no = …`;
- `ghmMissed.js`.

With two different numbers on one person's bookings, GHM cannot see that the 16 Oct "new" patient already came on 15 Oct. So the earlier-visit and missed logic, and therefore the New / Follow-up split in the CSV, can be wrong.

## 2. Size today (prod, read-only, 2026-10-15)

- **Upcoming bookings with a stale GNI number: 2.** Both fixed on 2026-10-15, logged in `appointment_change_log` as "Admin fix (Claude)":
  - appt 112165, Sunita, 16 Oct, GNI-00138 → P_182201 (booking already cancelled);
  - appt 112451, Rajesh Jindal, 21 Oct, GNI-00158 → P_182007.
- **Past bookings with a stale GNI number: 17.** Not touched yet.
- No upcoming booking differs from its patient's number for any other reason.

## 3. Fix

### 3.1 Code — `server/services/healthray/db.js`

In the same branch that upgrades the patient's `file_no` from `GNI-…` to the HealthRay UHID, also update that patient's bookings:

```sql
UPDATE appointments
   SET file_no = $new_file_no, updated_at = NOW()
 WHERE patient_id = $patient_id
   AND file_no ~ '^GNI-[0-9]+$'
```

- It runs only when the patient's number actually changed from GNI to P\_. It is a no-op otherwise.
- **All** of that patient's GNI bookings are updated, past and future, so history and the GHM matching agree.
- Each changed booking gets an `appointment_change_log` row (field `file_no`, label "UHID", changed_by "HealthRay sync"), so the desk can see why the number changed.
- Nothing else is touched: patients, consultations, labs and bills already key on `patient_id`, or on the patient's own `file_no`.

### 3.2 Backfill — `server/scripts/backfill-gni-booking-uhid.mjs`

A one-off for the 17 past bookings (and anything new found at run time):

- dry run first, printing each row (appointment, patient, old → new);
- then `--apply`, in batches of 100, with a change-log row per booking;
- rerunnable: it only selects bookings whose GNI number differs from the patient's P\_ number.

### 3.3 Not in scope

- The GHM display (`routes/ghm-appointments.js`, `GHMPage.jsx`) is not changed. Once the copies are right, it shows the right number. These files belong to the other session's GHM work.
- **Merging true duplicates** — two separate patient records for one person (the OBT GNI-shell family-chart case) — is a different problem with its own recipe.

## 4. Tests (e2e DB only)

`e2e/healthray/H…-gni-booking-takes-uhid.spec.js`:

1. A GNI patient with two bookings (one past, one future). Running the HealthRay patient upsert with a matching phone and name and a new UHID gives the patient `P_…` and **both** bookings `P_…`. Change-log rows are written.
2. A patient who already has a P\_ number: the upsert does not touch their bookings.
3. Phone matches but the name does not (the sync refuses the match): nothing changes.
4. GHM day window: after the upgrade, the 16 Oct booking sees the 15 Oct visit as an earlier visit.

Then:

- run the existing HealthRay, GHM and Gini Flow suites;
- `npm run format:check`;
- the backfill dry run on prod (read-only) for you to review before `--apply`.

## 5. Order

1. Code change and tests 1–3.
2. Test 4: GHM matching after the upgrade.
3. Backfill script — dry run on prod, review, apply only with your OK.
4. Commit only when asked.
