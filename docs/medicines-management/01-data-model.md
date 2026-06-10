# 01 — Data Model

> One new table: **`medicine_collections`** — an append/upsert log of *whether a
> patient collected each prescribed medicine at the pharmacy*. Additive only;
> nothing in `medications` is changed.

## A. Why a separate table (not a column on `medications`)
`medications` rows persist and are re-prescribed across visits, so a single
`collected` column would be overwritten and lose history. A per-event log keyed
by *(medicine, pickup date)* preserves the history and rolls up per patient/visit.

## B. The table

```sql
-- migrations/2026-06-XX_medicine_collections.sql
CREATE TABLE IF NOT EXISTS medicine_collections (
  id              SERIAL PRIMARY KEY,
  medication_id   INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  patient_id      INTEGER NOT NULL REFERENCES patients(id),
  appointment_id  INTEGER REFERENCES appointments(id),   -- the visit this pickup is for (nullable)
  collected_date  DATE NOT NULL DEFAULT CURRENT_DATE,     -- the pickup day (the "visit" key)
  status          TEXT NOT NULL
                    CHECK (status IN ('given','not_given','partial')),
  reason          TEXT,        -- out_of_stock | patient_declined | buying_outside | not_available | other
  qty_note        TEXT,        -- free text, e.g. "15 of 30 tablets", "1 strip"
  marked_by       TEXT,        -- pharmacist (req.doctor.doctor_name)
  marked_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  -- one status per medicine per pickup-day (re-mark = update; new day = new row)
  UNIQUE (medication_id, collected_date)
);
CREATE INDEX IF NOT EXISTS idx_medcoll_patient_date
  ON medicine_collections (patient_id, collected_date);
CREATE INDEX IF NOT EXISTS idx_medcoll_appt
  ON medicine_collections (appointment_id);
CREATE INDEX IF NOT EXISTS idx_medcoll_date
  ON medicine_collections (collected_date);
```

### Design notes
- **`pending` is the absence of a row.** A medicine with no `medicine_collections`
  row for the chosen date is "not yet marked". This avoids pre-creating rows when
  a prescription is written.
- **`UNIQUE (medication_id, collected_date)`** → marking is an **upsert**: the
  pharmacist can change a med from `not_given` → `given` the same day; a pickup on
  a later date creates a *new* row (the history).
- **`appointment_id`** links the pickup to the visit (for doctor context in the
  report). **Nullable and best-effort.** ⚠️ Do NOT take it from the medication —
  `medications.appointment_id` is almost never populated (verified: 24 of
  ~79,600 rows). Instead, at mark time, look it up from the patient's appointment
  on `collected_date`:
  ```sql
  SELECT id FROM appointments
   WHERE patient_id=$1 AND appointment_date=$2::date
   ORDER BY created_at DESC LIMIT 1   -- best-effort; NULL if none
  ```
  The collection record stands on its own without it; it's only for richer
  reporting/doctor attribution.
- **`collected_date`** (not a timestamp) is the grouping key — a patient collects
  a given medicine at most once per day in practice.

## C. The "what to show for collection" query
The patient's current prescription = active, current-visit meds, LEFT-JOINed to
any collection row for the chosen date:

```sql
SELECT m.id AS medication_id, m.name, m.dose, m.frequency, m.timing, m.when_to_take,
       m.med_group, m.sort_order,
       mc.status, mc.reason, mc.qty_note, mc.marked_by, mc.marked_at
  FROM medications m
  LEFT JOIN medicine_collections mc
    ON mc.medication_id = m.id AND mc.collected_date = $2::date
 WHERE m.patient_id = $1
   AND m.is_active = true
   AND m.visit_status = 'current'      -- toggle: drop this to show ALL active meds
 ORDER BY m.med_group, m.sort_order, m.name;
```
`status IS NULL ⇒ pending`.

## D. Roll-up status (per patient for a date)
```sql
SELECT
  COUNT(*)                                            AS total,
  COUNT(*) FILTER (WHERE mc.status='given')           AS given,
  COUNT(*) FILTER (WHERE mc.status='not_given')       AS not_given,
  COUNT(*) FILTER (WHERE mc.status='partial')         AS partial,
  COUNT(*) FILTER (WHERE mc.status IS NULL)           AS pending
FROM medications m
LEFT JOIN medicine_collections mc
  ON mc.medication_id=m.id AND mc.collected_date=$2::date
WHERE m.patient_id=$1 AND m.is_active AND m.visit_status='current';
```
→ `all` (given=total) · `partial` (some given/partial, none pending) ·
`none` (all not_given) · `pending` (any pending).

## E. (Optional, later) convenience view
```sql
CREATE OR REPLACE VIEW v_patient_collection_day AS
SELECT mc.patient_id, mc.collected_date,
       COUNT(*) AS lines,
       COUNT(*) FILTER (WHERE mc.status='given')     AS given,
       COUNT(*) FILTER (WHERE mc.status='not_given') AS not_given,
       COUNT(*) FILTER (WHERE mc.status='partial')   AS partial
  FROM medicine_collections mc
 GROUP BY mc.patient_id, mc.collected_date;
```
Drives the report's per-patient-per-day summary without recomputing each time.

## F. Reconciliation note
"How many were *prescribed*" at a past date is hard to reconstruct (meds change),
so the report is built from the **collection rows themselves** (what was actually
given/not). The live worklist (§C) is the only place that compares against the
*current* active prescription. This keeps the model honest and simple.
