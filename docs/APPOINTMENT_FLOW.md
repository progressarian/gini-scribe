# Appointment & Doctor Assignment — Simple Flow

_A plain-language explanation of how doctors get assigned to slots in Gini Scribe._

---

## Short answer: Who assigns the doctor?

**The receptionist (the person booking the appointment) picks the doctor manually**
from a dropdown when creating the appointment. There is **no auto-assignment** — the
system never picks a doctor for you.

The doctor availability you set up does **not** assign doctors. It only decides
**which time slots are shown as bookable** when the receptionist is booking.

So the chain is:

> **You set availability  →  System shows only free slots  →  Receptionist picks doctor + slot  →  Appointment is saved with that doctor.**

---

## Who can book? (Roles)

Booking happens on the **GHM page** ("New Appointment" button). These roles are allowed
to book / reassign:

| Role | Can book appointments? |
|------|------------------------|
| Reception | ✅ Yes |
| Coordinator | ✅ Yes |
| Consultant (doctor) | ✅ Yes |
| MO (Medical Officer) | ✅ Yes |
| Admin | ✅ Yes (and can bulk-reassign) |
| Nurse / Lab / Pharmacy | ❌ No (not for booking) |

> Note: right now a setting called `GRANT_ALL_CAPABILITIES` is **ON**, so effectively
> anyone logged in can book. Turn it off to enforce the table above.

---

## Step-by-step booking flow

1. **Receptionist clicks "New Appointment"** on the GHM page.
2. **Fills patient details** (name, phone, file number — a new patient auto-gets a
   `GNI-xxxxx` file number).
3. **Picks a doctor** from the *Doctor* dropdown. ← *this is the doctor assignment*
4. **Picks a date.**
5. The system instantly **loads that doctor's available slots** for that date
   (calls `/api/availability/day`).
   - Only **working/free** slots appear in the Time Slot dropdown.
   - Slots that are on leave, holiday, break, blocked, or full are hidden.
6. **Receptionist picks a slot** and submits.
7. The appointment is saved with that **doctor name + slot**, and the slot's booked
   count goes up by one.

---

## How availability decides which slots show

When a doctor + date is chosen, the system checks these in order and hides the slot
if any apply:

1. **Day off** — doctor's weekly off day (e.g. Sunday).
2. **Clinic holiday** — whole clinic closed that date.
3. **Outside working hours** — slot before `work_start` or after `work_end`.
4. **Lunch / break** — slot inside the break window.
5. **Leave / holiday / emergency** — a specific date the doctor marked off.
6. **Manually blocked** — that one slot was blocked by staff.
7. **Full** — slot already has its maximum bookings.
8. ✅ Otherwise → **Available** (shows in the dropdown).

This is the data you manage when you "set doctor availability."

---

## Can the doctor be changed after booking?

Yes:

- **Reception/Coordinator** can change the doctor on an existing appointment from the
  GHM page (inline edit). The change is logged.
- **Admin** can **bulk-reassign** patients to another doctor — e.g. when a doctor
  suddenly goes on leave. Here the system *does* suggest available doctors (same
  specialty + free capacity), but a human still confirms.

---

## What happens after the patient arrives (OPD flow)

1. **Booked** → status `scheduled` (doctor already set).
2. **Patient arrives** → reception checks them in → status `checkedin`.
3. **With the doctor** → status `in_visit`.
4. **Done** → status `seen` → a **consultation record** is created and all clinical
   data (medicines, diagnoses, labs) is linked to it.

The doctor stays the one chosen at booking, unless someone reassigns.

---

## Key tables (for developers)

| Table | What it holds |
|-------|----------------|
| `appointments` | The booking — patient, **doctor_name**, date, time_slot, status |
| `doctor_profile` | A doctor's weekly availability (off days, work hours, lunch) |
| `doctor_unavailability` | Specific dates a doctor is off (leave/holiday/emergency) |
| `clinic_holidays` | Whole-clinic closure dates |
| `appointment_slots` | Per-slot capacity + manual blocks + booked count |
| `slot_catalog` | The standard list of time slots |
| `active_visits` | Live OPD queue (who's with which doctor now) |
| `consultations` | Created when the visit is completed |
| `appointment_change_log` / `appointment_reassignments` | History of doctor/slot changes |

---

## One thing worth fixing (UX note)

The Doctor dropdown only lists doctors **who already have appointments** (it reads
distinct names from the `appointments` table). A brand-new doctor with zero bookings
won't appear in the list until they have at least one appointment. If you add new
doctors, this is worth changing to read from the doctors/`doctor_profile` table instead.

---

_Source: traced from `src/pages/GHMPage.jsx`, `server/routes/ghm-appointments.js`,
`server/services/availability.js`, `server/routes/doctorSchedule.js`, `server/routes/opd.js`,
and `shared/permissions.js`._
