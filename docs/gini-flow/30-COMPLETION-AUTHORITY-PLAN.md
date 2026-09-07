# Completion authority — who is allowed to close a visit

- Proposed: 7 Sep 2026
- Touches: `server/services/giniflow/appointmentSync.js` only (plus one smoke script)
- Migration: **none**

## 1. The two complaints this answers

**(a) The Rx Explain desk is empty.** `/giniflow/station/rx` shows "Nobody at the desk / Waiting 0"
on a full OPD day.

**(b) A patient still being served gets closed underneath the station.** A prescription was
explained at the desk, and thirty minutes later the visit read "Dispensed · visit closed" with every
medicine marked "Not marked".

They are the same defect seen from two ends: the floor's two different kinds of patient are being
treated identically, when the thing that separates them is precisely **who is entitled to say the
visit is over**.

## 2. What the live data says

Checked against production before writing this.

### 2.1 The desk is empty because nothing routes into it

The desk's queue is `doctor_done` / `rx_pending` / `with_rx`. On 7 Sep no visit in the hospital held
any of them. The board that day:

| status | booked | checked_in | vitals_done | with_doctor | pharmacy_pending | exited | no_show |
| ------ | -----: | ---------: | ----------: | ----------: | ---------------: | -----: | ------: |
| 7 Sep  |     35 |         10 |          14 |           1 |                3 |     15 |       7 |

Only Finalize in Scribe writes `doctor_done` → `rx_pending`. Every other patient is moved by the
HealthRay sync, which maps `completed` straight past the desk. The screen is not broken; nothing
feeds it.

### 2.2 The floor is overwhelmingly HealthRay-origin

Visits carrying a `consult_finalize` event (= the prescription was written in Scribe):

| day   | Scribe | HealthRay |
| ----- | -----: | --------: |
| 8 Sep |      0 |        52 |
| 7 Sep |      1 |        85 |
| 6 Sep |      0 |         5 |
| 5 Sep |      1 |        26 |
| 4 Sep |      1 |       110 |
| 3 Sep |      0 |       106 |
| 2 Sep |      0 |       106 |
| 1 Sep |      0 |       105 |

This is the fact that makes the plan safe: the "wait for Scribe" rule below applies to **roughly one
visit a day**, so it cannot fill the board with stuck cards.

### 2.3 What actually closed the patient

Ritesh Saini's full event trail, 7 Sep:

```
checked_in    reception  {}
with_vitals   vitals     {}
vitals_done   vitals     {"source":"manual", …}
with_sd       mo_sd      {}
ready_for_doctor mo_sd   {}
with_doctor   doctor     {}
doctor_done   doctor     {"source":"consult_finalize","medicines":2,"consultation_id":112653}
rx_pending    doctor     {"source":"consult_finalize"}
with_rx       nurse      {"source":"rx_station"}
exited        system     {"reason":"pharmacy_grace_elapsed","source":"healthray","grace_minutes":30}
```

Two things this settles:

- **HealthRay's `completed` did not close him.** `atPharmacyLeg()` already refuses to move a patient
  who is anywhere on `doctor_done … dispensed`. That guard works.
- **`sweepPharmacyLeg()` closed him** — a wall clock, thirty minutes after `with_rx`, while a nurse
  was working the desk. It is the only thing on that leg that closes a visit nobody asked to close.

## 3. The rule

> **The system that wrote the prescription is the system that closes the visit.**

| prescription written in | who may close the visit                   | why                                                                                                                                                 |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scribe** (Finalize)   | **only a station screen** — Rx / pharmacy | Scribe holds the record of what was explained and what was handed over. Closing it without a mark destroys that record and it cannot be re-entered. |
| **HealthRay**           | the sync's grace sweep, as today          | Nothing on this side is recording anything for these patients, so an unattended card is stale, not evidence. The board must drain.                  |

Everything else about the two is identical. Both appear in the Rx desk's **Waiting**, **At the
desk** and **Done** buckets; both get the same medicine card, the same counselling note, the same
call-in. Origin changes exactly one thing: whether a clock is allowed to end the visit.

### 3.1 How origin is decided

A visit is **Scribe-origin** if any of its events carries `meta->>'source' = 'consult_finalize'`.

Finalize writes that on both `doctor_done` and `rx_pending`, inside the same transaction as the
medicines, so it exists for every Scribe prescription and cannot exist without one. Alternatives
rejected:

- _a `consultations` row for the day_ — present for HealthRay-synced clinical notes too (Asha
  Sharma, Anupam Berry and 11 others on 7 Sep have one and were never touched in Scribe). Would
  mark almost the whole floor Scribe-origin and stop the board draining. **This is the trap.**
- _`medications.consultation_id`_ — same problem, same reason.
- _a new column on `giniflow_visits`_ — a migration to store a fact the event log already holds.

### 3.2 One interpretation to confirm

For HealthRay patients the brief says "auto complete from HealthRay once completed is there".
Note that HealthRay's `completed` is what puts them on this leg in the first place (§4.1) — acting
on it again at the desk would close them the instant they arrive. So for HealthRay patients
"auto-complete" means **the existing 30-minute grace sweep**, unchanged. Nothing new is introduced;
it simply stops applying to Scribe visits.

## 4. The changes

All three are in `server/services/giniflow/appointmentSync.js`.

### 4.1 Route HealthRay patients into the Rx desk — `effective`

```js
if (target === "exited" && awaitingMedicines.has(appt.patient_id)) {
  effective = "rx_pending"; // was: "pharmacy_pending"
}
```

A patient HealthRay reports complete, who has medicines with nothing recorded against them, is
parked at the **start** of the last leg rather than in the middle of it. The nurse explains, marks
explained, and the counter picks them up.

Nobody loses sight of them: the pharmacy's own queue is
`doctor_done / rx_pending / with_rx / pharmacy_pending`, so the counter still sees every one of
these patients exactly as it does today. The board moves them from "At pharmacy" to "Prescription
Explain", which is where they actually are.

This is safe on re-sync: `rx_pending` is inside `PHARMACY_LEG`, so the next poll's `atPharmacyLeg`
guard leaves them where they are.

### 4.2 The grace sweep skips Scribe-origin visits — `sweepPharmacyLeg`

Add to the sweep's `WHERE`:

```sql
AND NOT EXISTS (
  SELECT 1 FROM giniflow_visit_events e2
   WHERE e2.visit_id = v.id AND e2.meta->>'source' = 'consult_finalize'
)
```

A Scribe visit now leaves the Rx desk only via **Mark explained** and the pharmacy only via
**Dispense**. Consequence, accepted deliberately: a Scribe patient nobody marks stays on the board
until someone does. At ~1 visit/day that is a visible reminder, not a pile-up — and it is the
outcome asked for.

This covers the pharmacy leg as well as the Rx desk, because `PHARMACY_LEG` spans both. That is the
whole of "same in pharmacy roles as well": one guard, both stations.

### 4.3 The stale comment above `PHARMACY_LEG`

It states `completed` "parks them at the pharmacy". After §4.1 it parks them at the Rx desk.
Correct the existing text; add no new commentary.

## 5. What is deliberately NOT changed

- **The sweep itself stays** for HealthRay patients. It exists because the floor does not work these
  screens (`giniflow-floor-still-on-healthray`); removing it would refill the board with patients
  who left hours ago.
- **The 30-minute window stays at 3 × the pharmacy SLA budget (10 min).** Lengthening it is a
  separate argument, and after §4.2 it no longer harms the patients it was harming.
- **The post-close 409 stays.** `recordMedicine` and `dispenseAll` still refuse a closed visit. With
  §4.2 a Scribe visit can no longer be closed out from under the counter, so the case it was
  protecting against is now unreachable rather than merely mitigated.
- **`patientsAwaitingMedicines` is untouched** — both its branches (`medications` today, and
  `appointments.healthray_medications`) already describe exactly "has medicines, has collected
  nothing".

## 6. Why the Rx desk needs no work at all

Checked, not assumed. `getRxQueue` / `getRxPatient` never require a consultation:

- both LATERAL joins to `consultations` and to the prescription `documents` row are `LEFT` — a
  HealthRay patient yields `consultationId: null`, `canPrint: false`, and renders;
- `buildCard()` reads **all active medications for the patient**, not today's rows, so the card is
  populated even when nothing was written today (this is why Ritesh's card showed 2 medicines with
  `meds_today = 0`);
- `buildCounsellingNote()` works off that same card.

The only visible difference for a HealthRay patient is a missing **Print Rx** button, which is
correct — Scribe never generated that PDF.

## 7. Verification

**Smoke:** `smoke:giniflow-appointment-sync`, `smoke:giniflow-pharmacy`, `smoke:giniflow-sync`.
Add one case to the appointment-sync smoke: a Scribe-origin visit parked on the leg past the grace
window is **not** swept, while a HealthRay-origin one beside it **is**.

**On production, after deploy:**

```sql
-- should be 0: no Scribe visit closed by a clock, ever again
SELECT count(*) FROM giniflow_visit_events e
 WHERE e.meta->>'reason' = 'pharmacy_grace_elapsed'
   AND EXISTS (SELECT 1 FROM giniflow_visit_events f
                WHERE f.visit_id = e.visit_id AND f.meta->>'source' = 'consult_finalize')
   AND e.occurred_at > now() - interval '1 day';

-- should be non-zero on the next OPD day: the desk has a queue
SELECT current_status, count(*) FROM giniflow_visits
 WHERE visit_date = current_date
   AND current_status IN ('doctor_done','rx_pending','with_rx') GROUP BY 1;
```

## 8. Rollback

Three edits in one file, no migration and no schema change. Reverting the commit restores today's
behaviour exactly; visits already parked at `rx_pending` are picked up by the pharmacy queue either
way, so a revert strands nobody.

## 9a. Review findings (7 Sep, against the code and prod)

Two things the first draft above got wrong or left out. Both are recorded rather than quietly fixed,
because each is a judgement the floor may want to make differently.

**R1 — a Scribe visit nobody marks is never closed, not even the next day.** `sweepPharmacyLeg`
filters `v.visit_date = $1::date`, so once the day rolls over nothing looks at yesterday's visits at
all. After §4.2 an unmarked Scribe visit therefore keeps `with_rx` permanently.

Blast radius is smaller than it sounds: every station queue and the board filter on today, so a
stale visit never appears on a live screen. It shows only in history and in the `total_journey` SLA,
which will count it as a journey that never ended.

Decision: **accept, do not add an end-of-day sweep.** A visit that was genuinely never closed is
honest data, and inventing a closing time would put a fake number into the outcomes report. If these
accumulate, the fix is a dated "closed at end of day, unmarked" event — deliberately distinguishable
from a real dispense — not a silent exit.

**R2 — the Rx column will now go red on almost every patient.** `rx_pending` bills to the
`rx_explain` SLA (5 min), while the sweep that clears it is 30 min. A HealthRay patient nobody
serves is therefore red for 25 of the 30 minutes they are parked there.

That is arithmetically unavoidable while the desk is unstaffed, and it is not wrong — it is a desk
with a queue nobody is working. But it moves ~30–50 red cards a day into a column that was empty, so
the board will look considerably worse the morning this ships. Flagging it so it reads as expected
rather than as a regression. If it proves too noisy, the honest lever is the `rx_explain` budget in
`giniflow_sla_config`, not the sweep.

## 10. Risks

| risk                                                        | severity | mitigation                                                                                             |
| ----------------------------------------------------------- | :------: | ------------------------------------------------------------------------------------------------------ |
| Scribe visits accumulate because nobody marks them          |   med    | ~1/day (§2.2). They sit in the Rx column where they are meant to be seen. Revisit if Scribe use grows. |
| Origin test matches a visit the floor considers HealthRay's |   low    | `consult_finalize` is written only by Finalize, only with medicines, in the same transaction.          |
| Pharmacy's "At pharmacy" column looks emptier               |   low    | Patients moved to the Rx column, one step earlier. The counter's own queue is unchanged (§4.1).        |
| Sweep query cost grows by a NOT EXISTS per candidate row    |   low    | Runs once per sync over one day's visits; the subquery hits `giniflow_visit_events(visit_id)`.         |
