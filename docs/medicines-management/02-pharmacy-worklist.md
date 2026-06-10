# 02 — Pharmacy Worklist (mark collection)

> The pharmacy-side screen + API: find a patient, see their prescribed medicines,
> and mark each **Given / Not given / Partial** with a reason. This is where the
> data gets entered.

## A. API (`server/routes/medicineCollection.js`)

| Method | Path | Purpose | Cap |
|--------|------|---------|-----|
| GET | `/api/pharmacy/collection/today?date=` | today's patients to serve (from appointments/OPD) with a roll-up status | PHARMACY/RECEPTION |
| GET | `/api/patients/:id/collection?date=` | a patient's current meds + each one's collection status for `date` (Doc 01 §C) | PHARMACY |
| POST | `/api/medications/:id/collection` | mark/Update one medicine — body: `{ status, reason?, qty_note?, date?, appointment_id? }` (upsert) | PHARMACY |
| POST | `/api/patients/:id/collection/bulk` | mark several meds in one call — body: `{ date, items:[{medication_id,status,reason?,qty_note?}] }` | PHARMACY |
| GET | `/api/patients/:id/collection/history` | all past collection events for the patient (Doc 03) | PHARMACY/clinical |

- Marking = **upsert** on `(medication_id, collected_date)`.
- `marked_by` = `req.doctor?.doctor_name`; `not_given`/`partial` **require**
  `reason` (validated).
- Zod: `collectionMarkSchema` (`status` enum, `reason` enum+text, `qty_note`,
  `date`), `collectionBulkSchema`.

### "today's patients" source — driven by `last_prescribed_date`
⚠️ **Corrected.** Don't drive this off appointment status (and never off
`medications.appointment_id` — it's ~empty). The reliable, verified signal is
"patients whose current meds were prescribed/updated that day":
```sql
SELECT p.id AS patient_id, p.name, p.file_no, p.phone,
       a.id AS appointment_id, a.doctor_name,          -- best-effort doctor context
       COUNT(m.*)::int AS med_count
  FROM medications m
  JOIN patients p ON p.id = m.patient_id
  LEFT JOIN appointments a
    ON a.patient_id = p.id AND a.appointment_date = $1::date
 WHERE m.is_active AND m.visit_status = 'current'
   AND m.last_prescribed_date = $1::date
 GROUP BY p.id, p.name, p.file_no, p.phone, a.id, a.doctor_name
 ORDER BY p.name;
```
(62–77 patients/day in real data.) Plus a free **patient search** box for anyone
not prescribed that day (e.g. an old prescription / refill pickup).

## B. UI — Pharmacy → "Medicine Collection"

### Worklist (left / top)
- **Date** picker (default today) + **search** patient.
- List of today's patients, each with a roll-up badge:
  **🟢 All collected · 🟡 Partial · 🔴 None · ⚪ Pending** + "given/total" count.
- Click a patient → opens their medicine list.

### Patient medicine panel (right / main)
For the selected patient + date, a table of their **current prescribed medicines**:

| Medicine | Dose · Freq · Timing | Status | Reason / note |
|----------|----------------------|--------|----------------|
| Metformin 500 | 1 · BD · After meals | ◉ Given ○ Not given ○ Partial | — |
| Glargine insulin | 10U · HS | ○ Given ◉ Not given ○ Partial | `Out of stock` |

- Per row: a 3-way control (Given / Not given / Partial).
- Choosing **Not given** or **Partial** reveals a **reason** dropdown
  (out_of_stock / patient_declined / buying_outside / not_available / other) +
  optional note (qty for partial, e.g. "15 of 30").
- **"Mark all given"** shortcut (common case) → one bulk call.
- **Save** → `bulk` upsert; the patient's roll-up badge updates live.
- Already-marked rows show who/when (`marked_by`, `marked_at`) and stay editable.

### Niceties
- Group medicines by `med_group` (diabetes / BP / …) like the prescription.
- A toggle **"show all active meds"** vs **"current prescription only"** (Doc 00 #1).
- Re-opening a past date shows that day's history (read of `collected_date`).

## C. Behaviour rules
- `pending` (no row) renders as an unselected control.
- Re-marking the same day updates the row; a different day creates a new row.
- `reason` required for not_given/partial (UI blocks save otherwise; server validates).
- Optional: stamp `station_tracking.rx_checkout` when a patient's collection is
  completed (ties into the existing journey board) — *nice-to-have, confirm*.

## D. Testing
- Mark given/not_given/partial → rows upserted; re-mark same day updates in place.
- not_given without reason → rejected (client + server).
- Roll-up badge: all-given → 🟢; one not_given → 🟡/🔴 per rule.
- Bulk "mark all given" writes one row per current med.
- A med collected today then again next visit → two history rows.
