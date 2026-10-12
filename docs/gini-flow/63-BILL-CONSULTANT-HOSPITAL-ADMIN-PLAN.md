# 63 — Bill consultant and "Hospital Admin" (tests-only) bills

Status: built (2026-10-12). Tests: `e2e/billing/phase4/P4C-41-bill-consultant.spec.js`. Migration `2026-11-21_bill_consultant.sql`.

## Why

HealthRay prints a **Consult Name** on every OPD bill. A patient who only gives samples is billed
under **Dr. Hospital Admin** (`LAB_ONLY_DOCTOR`, `doctors.id` 25, role `consultant`). Scribe has no
such choice: the counter bill's consultant is derived (first line with a doctor → visit doctor →
appointment doctor), so a tests-only bill prints no consultant at all, and reception cannot say
"this bill is tests only".

Case that raised it — P_129030 Sohan Singh, 9 Oct: lab tests registered under Hospital Admin
(OPD/2627-16259), then reception made a **second** HealthRay appointment under Dr. Beant
(OPD/2627-16260) instead of changing the first. Scribe already makes one visit and one bill of it.

Since 14 Sep: 257 Hospital Admin appointments; 38 of those patients also saw a doctor that day.

## Decisions (2026-10-12)

| #   | Decision                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | A patient who also sees a doctor that day gets **one** Scribe bill under the doctor: consultation + tests. The Hospital Admin part is never a separate bill.        |
| H2  | A patient with no doctor consultation is a **tests-only** patient: bill under **Hospital Admin**, no consultation line. No floor stations (unchanged).              |
| H3  | The counter gets a **Consultant** choice on the bill, including **Hospital Admin (tests only)**, like HealthRay's Consult Name.                                     |
| H4  | Discounts are applied **in Scribe** by reception (line discount, code, additional discount). HealthRay's discounts are **not** copied — HealthRay is being retired. |

## Behaviour

### B1. The bill's consultant

New nullable `bills.consultant_id` → `doctors(id)`. The consultant shown and printed is the first of:

1. `bills.consultant_id` (set by reception);
2. the doctor on the bill's consultation line;
3. the visit's doctor (`assigned_doctor_id`), then the appointment's doctor — **only for a doctor visit**;
4. **Hospital Admin** when the visit is samples-only (`labOnlyPredicate`) or has no consultation line.

One shared SQL fragment / helper, used by the counter, the bill PDF ("Consult Name") and the
reports (`BILL_CONSULTANT`), so the three never disagree. Hospital Admin is found by name
(`LAB_ONLY_DOCTOR`), never by id.

### B2. Counter — Consultant selector

In the bill header row next to **Category** (`PatientHeader.jsx`), a labelled select:

- **Today's doctors first** — the visit's doctor and any other doctor the patient is booked with today;
- then **all active consultants**;
- then **Hospital Admin (tests only)**.

Shows the current consultant from B1. Draft bills only; on a final bill it is read-only (a fee change
after finalise stays with the existing consultant-change / credit-note flow, plan 62).

### B3. Choosing the consultant

| Reception picks                                      | On a draft bill                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Hospital Admin**                                   | `consultant_id` = Hospital Admin; any consultation line is removed (reason "Tests only — Hospital Admin"); auto-fill never adds a consultation to this bill again. |
| **A doctor**, bill has no consultation               | `consultant_id` = doctor; that doctor's consultation is added for the visit type (same item lookup as `ConsultationSuggestion`).                                   |
| **A doctor**, bill has another doctor's consultation | swapped through the existing `consultantChangedIn` draft path (remove + add, audited).                                                                             |
| **Same as now**                                      | nothing.                                                                                                                                                           |

The choice changes the **bill only**. It does not move the patient on the floor and does not change
the visit's doctor (that is the floor's reassign, plan 62). If a samples-only booking was really a
doctor visit, reception corrects it in HealthRay — Scribe now follows the appointment's doctor
(G77) and the patient becomes a normal floor patient.

Every change is written to `billing_audit` (old → new consultant, lines removed/added).

### B4. Samples-only patients at the counter

Already: listed with the **Samples only** badge, no "consultation" hint, HealthRay bill read once
HealthRay shows them checked in (G79) so the tests fill in. New: consultant defaults to Hospital
Admin (B1.4) and prints as **Consult Name: Dr. Hospital Admin**.

### B5. Doctor patient with an extra samples-only booking (H1)

Already one visit and one draft with both HealthRay invoices' lines merged. Keep; covered by a test.
The draft's consultant is the doctor (B1.2/B1.3).

### B6. Reports

Lines with no doctor fall back to the bill's consultant (B1). Effect: tests-only bills move from
"No consultant" to **Dr. Hospital Admin** in the consultant reports — the same as HealthRay. Doctor
bills are unchanged.

## Not in scope

- Copying HealthRay discounts (H4).
- Changing the consultant on a **final** bill (plan 62 flow handles fee changes).
- Removing the "consultation only after HealthRay billed one" gate
  (`healthrayBilledConsultation`). It stays while HealthRay is live; when HealthRay is retired the
  gate becomes "the visit's consult step is done". Hospital Admin bills never auto-add a
  consultation either way.

## Tasks (each tested before the next)

1. Migration `bills.consultant_id` + shared consultant resolver (B1); counter API returns
   `consultant` and `consultant_options`. Test: samples-only → Hospital Admin; doctor visit → doctor;
   explicit choice wins.
2. `PATCH` bill consultant (desk capability, drafts only, audited) with B3's three cases. Tests per row.
3. Counter UI selector (B2), loading/disabled/error states, keyboard and label. Screen test.
4. Bill PDF Consult Name and reports use the resolver (B1, B6). Tests: PDF field, report bucket.
5. P_129030-shaped test: lab-only + doctor same day → one bill under the doctor with both (B5).

## Answered (2026-10-12)

1. Options list: today's doctors first, then all active consultants, then Hospital Admin.
2. Picking a doctor on a samples-only patient's bill changes the bill only, never the floor.
