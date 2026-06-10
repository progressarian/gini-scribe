# 03 — Doctor / Management Report + History

> The visibility layer: doctors and management see **which patients collected
> which medicines**, filter by date/doctor, drill into a patient, and view the
> full **history** over time.

## A. What questions it answers
- For a day/range: **which patients got all / some / none** of their medicines?
- **Which specific medicine** did a patient not get, and **why** (out of stock,
  declined, buying outside)?
- Over time: a patient's **collection history** — did they consistently collect
  their insulin? When did they stop?
- Per doctor: of *my* patients prescribed today, who actually collected?

## B. API (`server/routes/medicineCollection.js` — read endpoints)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/pharmacy/collection/report?from=&to=&doctor=&status=` | one row per patient-visit: prescribed/given/not_given/partial counts + roll-up status |
| GET | `/api/patients/:id/collection/history` | full per-medicine event log for a patient (newest first) |
| GET | `/api/pharmacy/collection/not-collected?from=&to=` | worklist of **not_given** items (clinically important follow-ups) |

### Report query (per patient per day)
```sql
SELECT mc.patient_id, p.name, p.file_no, mc.collected_date,
       a.doctor_name,
       COUNT(*)                                      AS lines,
       COUNT(*) FILTER (WHERE mc.status='given')     AS given,
       COUNT(*) FILTER (WHERE mc.status='not_given') AS not_given,
       COUNT(*) FILTER (WHERE mc.status='partial')   AS partial
  FROM medicine_collections mc
  JOIN patients p ON p.id = mc.patient_id
  -- doctor context: prefer the stored appointment_id, else match the patient's
  -- appointment on the collection date (med.appointment_id is unreliable).
  LEFT JOIN appointments a
    ON a.id = COALESCE(
         mc.appointment_id,
         (SELECT id FROM appointments a2
           WHERE a2.patient_id = mc.patient_id
             AND a2.appointment_date = mc.collected_date
           ORDER BY created_at DESC LIMIT 1))
 WHERE mc.collected_date BETWEEN $1 AND $2
   AND ($3::text IS NULL OR a.doctor_name ILIKE $3)
 GROUP BY mc.patient_id, p.name, p.file_no, mc.collected_date, a.doctor_name
 ORDER BY mc.collected_date DESC, p.name;
```
Roll-up status derived in SQL or JS: `all` (given=lines), `partial`
(partial>0 or mixed), `none` (not_given=lines).
> Doctor attribution is **best-effort** (the prescribing doctor isn't stored on
> the collection). If exact attribution matters, also resolve via
> `medications.consultation_id → consultations.con_name`.

> Note: the report is built from **collection rows** (what was actually
> recorded). "Prescribed but pharmacist never opened the patient" shows up via
> the live worklist's *pending* (Doc 02), not here — the report is the record of
> what happened. (See Doc 01 §F.)

## C. UI

### Option A — a tab on the existing GHM/OPD reports area
A **"Medicine Collection"** report view:
- Filters: **date range**, **doctor**, **status** (all / partial / none).
- Table: Patient · File · Date · Doctor · `given/total` · status badge.
- Row click → patient drill-down (the per-medicine breakdown + reasons).
- A **"Not collected"** sub-tab = every `not_given` line with its reason — a
  follow-up worklist for CC/doctors (e.g. "patient didn't get insulin → call").

### Patient drill-down / history
- Reuses the medicine-card layout: each medicine with its collection status,
  reason, who/when, across dates (timeline).
- Surfaced on the **patient page** too (a small "Pharmacy collection" panel),
  so a doctor opening the chart sees what the patient actually got.

## D. Who sees it
- **Doctors / management:** read the report + patient history.
- **Pharmacy:** read (they enter it).
- Gate reads on `ANALYTICS`/clinical caps; writes stay `PHARMACY` (Doc 04).

## E. Testing
- Report aggregates match the per-patient roll-up from Doc 01 §D.
- Doctor filter scopes to that doctor's appointments.
- "Not collected" lists exactly the `not_given` rows with reasons.
- History shows multiple pickups of the same med on different dates.

## F. Future hooks (not v1)
- Notify the doctor/CC when a clinically critical med (insulin, etc.) is
  `not_given` (reuse MSG91/push).
- Trend: % of patients fully collecting over weeks (management KPI).
