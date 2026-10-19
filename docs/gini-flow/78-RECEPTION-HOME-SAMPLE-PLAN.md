# 78 — Reception records the home sample

Status: plan (19 Oct 2026), third revision. All six questions answered by the user the same day. Waiting for approval to build.

## 1. Ask

> Patients with the home collection tag on the GHM ops page: when they arrive, reception checks whether the sample was collected at home and whether payment is done. If nothing is recorded, reception asks the patient. If the sample was collected, reception updates it and takes the payment if pending. If not, the patient goes through the normal lab station flow, keeping the tag. Reception can also mark "sample collected" and "payment pending / done" whenever the home collection staff tell them, by phone or in person.

> "We don't care about the lab, from HealthRay or whatever, for this feature."

This is a **reception record**. It doesn't read or change lab orders, HealthRay lab cases, the lab station, bills, payments or cash shifts.

## 2. Decisions

Answered 19 Oct: **Q1 record only · Q2 new table · Q3 sample required · Q4 yes, on GHM ops · Q5 stay in Expected · Q6 a pick list of the two home collection staff, Harwinder and Pratham.**

The two names live in one shared list (`shared/homeCollectors.js`), used by the window and checked by the server, so adding or removing a collector is a one-line change.

| #   | Question                                                                             | Recommended                                                                                                                                                                                          | Other choice                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **"Paid at home"**: is it only a record of what the collector reported?              | **Yes, a record only**, shown as "Paid at home (reported) ₹1,260 · cash". Bills, receipts and the cash shift don't change. When the cash reaches the desk, reception enters it on the bill as today. | It also creates a real payment on the patient's bill. This needs a bill to exist, puts home cash into the receptionist's shift, and is a bigger change.                                                       |
| Q2  | **Storage**: a small new table, needing one migration on production?                 | **Yes.** You run the migration **before** deploying. Until it exists the screens behave as today: no 🏠 parts, nothing broken (see §6).                                                              | Store it in the visit's event history. Not recommended: about 70 queries read that history without filtering, including the patient's waiting timers and timeline, so a home-sample entry would reset clocks. |
| Q3  | **At ✓ Arrived**, must reception answer before checking in?                          | **The sample question is required.** The payment question is required only when the sample was collected at home; if not collected, payment follows the normal flow.                                 | Show the questions but allow "Skip — ask later".                                                                                                                                                              |
| Q4  | Show reception's record on the **GHM ops page** too (the 🏠 chip the OBT team sees)? | **Yes.** The chip shows the latest of reception's record or the lab's own "collected at home" mark.                                                                                                  | Reception screen only.                                                                                                                                                                                        |
| Q5  | Sample collected at home and the patient **isn't coming in at all**?                 | **Leave as today:** they stay in Expected, with "Collected at home" showing, so nobody marks them no-show by mistake.                                                                                | Add "Not coming in — sample taken at home", which closes the visit as completed (a later plan).                                                                                                               |
| Q6  | **"Collected by"**: free text or a pick list?                                        | **Free text**, suggesting names already used in the last 30 days.                                                                                                                                    | A pick list of staff accounts. Collectors may not have Scribe logins.                                                                                                                                         |

## 3. The flow

1. **The home collection tag is set as today:** "Home collection" on the GHM ops booking form, or an approved request in the patient app (`HOME_COLLECTION_SQL`).
2. **Reception sees it on Arrivals.** A home-tag patient, expected or on the floor, shows:
   - **🏠 Home collection**;
   - **Sample:** Not recorded · Collected at home 08:40 (Harwinder) · Not collected;
   - **Payment:** Not recorded · Paid at home (reported) ₹1,260 · Pending (yellow).
3. **The collector reports, before the patient comes:** reception opens **🏠 Home sample** on the patient's row and records what they were told. The patient stays Expected.
4. **The patient arrives:**
   - **Something already recorded:** reception reads it on the row, confirms with the patient, and presses ✓ Arrived as normal.
   - **Nothing recorded:** pressing ✓ Arrived shows the home questions at the top of the check-in panel. Reception asks the patient, answers, then checks in.
5. **Collected at home + payment pending:** the row keeps the yellow **Payment pending** pill. When the patient pays at the desk, reception takes the money on the bill as usual and changes the home record to "Paid".
6. **Not collected:** nothing else changes. The patient goes through the normal flow (payment first, then the lab station), and the 🏠 tag stays on the reception row.
7. **Corrections:** the record can be changed any time that day. Every save is kept as history.

## 4. Screens

### 4.1 Arrivals row (`ArrivalRow` in `ReceptionStationPage.jsx`)

Home-tag patients only:

```text
08:55  Manmeet Singh                                 [✓ Arrived] [No-show] [Cancel] [Bill]
       24M · P_182226 · 98729…
       🏠 Home collection · Sample: Collected at home 08:40 (Harwinder) · Payment pending
                                                                    [🏠 Home sample]
```

- The status line reuses the existing badge styles (`badge`, `sp`), with words as well as colour.
- **🏠 Home sample** is a quiet secondary button (`st-btn st-btn-g`), so ✓ Arrived stays the main action.
- It appears in Expected and On the floor, not in Not coming.
- At 390 px the status line wraps under the name, the button goes full width, and nothing scrolls sideways.

### 4.2 The window

```text
🏠 Home sample — Manmeet Singh · P_182226 · 24M · booked 08:55

Sample
  (•) Collected at home    Time [08:40]   Collected by [Harwinder ▾]
  ( ) Not collected — the patient gives the sample at GHM

Payment                      (shown only when "Collected at home")
  (•) Paid at home         Amount ₹[1260]   Mode [Cash ▾  UPI  Card]
  ( ) Pending

Note [optional, up to 160 characters                        ]

Last saved by E2E Reception at 09:12 · History (2)

                                   [Cancel]  [Save]
```

- It uses the existing modal pattern (`role="dialog"`, focus on the first control, Esc closes, focus goes back to the button).
- **Rules, each with a message under its field:**
  - Time is required when Collected, and can't be in the future ("The collection time can't be in the future") or before today.
  - Collected by is required when Collected: Harwinder or Pratham, picked from the list.
  - Amount is required when Paid, from 1 to 1,00,000 rupees, whole rupees.
  - Mode is required when Paid.
- Save shows "Saving…" and can't be pressed twice. A success toast says "Home sample saved for Manmeet Singh", and the row updates straight away.
- **History** lists every save: who, when and what. It can't be edited.

### 4.3 Check-in panel (`CheckInPanel`)

For a home-tag patient with nothing recorded, the same Sample and Payment controls appear in a box at the top: "🏠 Home collection — ask the patient". The arrive button stays disabled, with "Answer the home sample question first", until the Q3 answers are in.

The home record is saved first, then check-in runs. If check-in fails, the home record stays, because it is still true.

## 5. Server

### 5.1 Table (migration `server/migrations/2026-12-02_home_sample_records.sql`)

```sql
CREATE TABLE IF NOT EXISTS giniflow_home_samples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES giniflow_visits(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  visit_date DATE NOT NULL,
  sample TEXT NOT NULL CHECK (sample IN ('collected', 'not_collected')),
  collected_at TIMESTAMPTZ,
  collected_by TEXT,
  payment TEXT CHECK (payment IN ('paid', 'pending')),
  amount NUMERIC(10, 2),
  mode TEXT CHECK (mode IN ('cash', 'upi', 'card')),
  note TEXT,
  entered_by INTEGER REFERENCES doctors(id),
  entered_role TEXT,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_giniflow_home_samples_visit
  ON giniflow_home_samples (visit_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_giniflow_home_samples_day
  ON giniflow_home_samples (visit_date);
```

Rows are only ever **added**; the latest row per visit is the current answer. That keeps the full history with no separate audit table.

### 5.2 API (`server/routes/giniflowStations.js` → new service `server/services/giniflow/homeSampleRecords.js`)

| Method | Path                                                            | Does                                                            |
| ------ | --------------------------------------------------------------- | --------------------------------------------------------------- |
| POST   | `/api/giniflow/stations/reception/:visitId/home-sample`         | Validates (Zod schema `homeSampleRecordSchema`) and adds a row. |
| GET    | `/api/giniflow/stations/reception/:visitId/home-sample/history` | Lists every save for that visit, newest first.                  |

- **Guard:** the reception station capability (`GINIFLOW_STATION_RECEPTION`), the same as the rest of the reception station.
- **Refusals:** a non-home visit → 400 "This patient did not opt for home collection"; a visit not today → 400; an unknown visit → 404; everything else → 403.
- **Errors** go through `handleError`, so no SQL text reaches the screen.
- **After saving:** it publishes a `visit` signal for that day, so every open reception screen and the GHM ops page refresh without a reload.

### 5.3 Reads

- `ARRIVAL_SELECT` (`receptionStation.js`) adds `home` (`HOME_COLLECTION_SQL`) and the latest `giniflow_home_samples` row as `home_record`. `shapeArrival` adds `homeCollection` and `homeRecord: { sample, collectedAt, collectedBy, payment, amount, mode, enteredBy, enteredAt }`.
- **GHM ops (Q4):** `BOOKING_HOME_SAMPLE_SQL` also considers the latest reception record, so the chip shows the newest of the two.

## 6. Rollout, safely (lesson from plan 77)

1. **You run the migration on production first:**
   `cd server && node migrations/_runOne.mjs migrations/2026-12-02_home_sample_records.sql`
2. **Then deploy.**
3. **Safety net:** the server checks once at start-up (`to_regclass('giniflow_home_samples')`), and on every save, whether the table exists.
   - If it's missing, `ARRIVAL_SELECT` leaves the home record out. Arrivals works exactly as today, with no 🏠 Home sample button.
   - A save returns 503 "Home sample recording isn't switched on yet".
   - So local dev on the production database, or a deploy before the migration, can't empty a screen.

## 7. Edge cases

- **Walk-in with a home tag** (an app request within 7 days): it works the same way.
- **Two visits merged:** the record follows the surviving visit (the reads use the visit id after merge; `merged_into_visit_id` is excluded, as today).
- **No-show or cancelled:** the button is hidden. A record made earlier stays in history.
- **Patient blocked:** blocked patients are already hidden from Arrivals.
- **Past days:** recording is for today only. History stays visible.
- **The tag is removed after a record was made:** the record stays in history. The row no longer shows home parts, because the tag decides.

## 8. Not changed

- Lab orders, HealthRay lab cases, the lab station and the home collection report.
- Bills, payments, receipts and cash shifts (Q1).
- Booking home collection on the GHM ops page.
- The one-live-connection rule on the reception screen. No new connection is opened; the existing `visit` signal is used.

## 9. Files

- **New:**
  - `server/migrations/2026-12-02_home_sample_records.sql`;
  - `server/services/giniflow/homeSampleRecords.js`;
  - `shared/homeCollectors.js` (Harwinder, Pratham);
  - `src/components/giniflow/HomeSampleDialog.jsx` (with `homeSample.css`);
  - `src/queries/hooks/useHomeSample.js`;
  - `e2e/giniflow/G105-reception-home-sample.spec.js`.
- **Changed:**
  - `server/routes/giniflowStations.js`, `server/schemas/index.js`;
  - `server/services/giniflow/receptionStation.js` (`ARRIVAL_SELECT`, `shapeArrival`);
  - `server/services/giniflow/homeCollection.js` (`BOOKING_HOME_SAMPLE_SQL`, for Q4);
  - `src/pages/giniflow/ReceptionStationPage.jsx` (`ArrivalRow`, `CheckInPanel`);
  - `src/pages/GHMPage.jsx` (chip wording, for Q4).

## 10. Tests (e2e, test DB only)

`e2e/giniflow/G105-reception-home-sample.spec.js`:

1. A home-tag patient shows 🏠 Home collection with "Sample: Not recorded · Payment: Not recorded" and the 🏠 Home sample button; a normal patient shows none of these.
2. Before arrival: Collected 08:40 by Harwinder, Paid ₹1,260 cash. The row reads exactly that, the patient stays Expected, a row is added with the reception user, and **no bill or payment row is written**.
3. ✓ Arrived with nothing recorded: the home box appears and Arrive stays disabled until the sample is answered (and payment, when collected). After saving, check-in completes.
4. Not collected: the payment questions hide, the row shows "Not collected", and check-in works normally.
5. Collected + Pending: the yellow pill shows; changing to Paid removes it, and History lists both saves in order.
6. Validation on screen and API: a future time, a missing collector or a name not on the list, amount 0, a non-home visit (400), a past day (400), and lab and doctor roles (403).
7. The GHM ops chip shows "🏠 Collected · Harwinder 08:40" after the reception save (Q4).
8. Live: a second reception screen shows the new record without reloading.
9. Table missing (dropped inside the test transaction): Arrivals still loads, with no 🏠 parts; a save returns 503.
10. 1366 px and 390 px: the row and the window fit, and nothing scrolls sideways; keyboard Tab/Esc work in the window.

Rerun P4C-13 (one live connection), P4C-43 (check-in and bill), P4C-51, G98 (home collection), and the GHM specs that cover the home chip.
