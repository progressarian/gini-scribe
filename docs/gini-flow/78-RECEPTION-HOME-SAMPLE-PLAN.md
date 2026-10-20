# 78 — Reception records the home sample

Status: Part 1 (§1–§10) and Part 2 (§11) built 20 Oct 2026. Both migrations (`2026-12-04_home_sample_records.sql`, `2026-12-05_visit_lab_site.sql`) are applied on production. See "As built" and §11.8.

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
| Q6  | **"Collected by"**: free text or a pick list?                                        | **Decided: a pick list** of the two home collection staff, Harwinder and Pratham.                                                                                                                    | A pick list of staff accounts. Collectors may not have Scribe logins.                                                                                                                                         |

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

### 5.1 Table (migration `server/migrations/2026-12-04_home_sample_records.sql`)

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
   `cd server && node migrations/_runOne.mjs migrations/2026-12-04_home_sample_records.sql`
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
  - `server/migrations/2026-12-04_home_sample_records.sql`;
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

## As built

- **Migration file:** `server/migrations/2026-12-04_home_sample_records.sql`. The `2026-12-02` date was already taken.
  Run it on production first: `cd server && node migrations/_runOne.mjs migrations/2026-12-04_home_sample_records.sql`.
- **Arrivals:** `ARRIVAL_SELECT` is unchanged, because the billing counter shares it. Instead, `getArrivals` runs a second small query, `homeForDay` in `homeSampleRecords.js`, that returns home-tag visits and their latest record. Each row gains `homeCollection`, `homeRecordsOn` and `homeRecord`.
- **Table check:** `homeSamplesReady()` checks `to_regclass` and caches the answer. A found table is remembered. A missing one is checked again after 60 s, so the feature turns on after the migration without a restart.
- **GHM ops chip (Q4):** `VISIT_HOME_SAMPLE_SQL(v, { reception })` adds reception's latest record only when it is "collected", and `ghm-appointments.js` passes `reception` only when the table exists. `GHMPage.jsx` already shows "🏠 Collected · Harwinder 08:40", so it was not changed. The floor board and the home collection report still read only the lab's marks.
- **Rules:** time, collector, amount and mode are checked in `shared/homeCollectors.js`, which both the window and the server use. Time is entered as HH:MM for today, in IST.
- **Live:** a save publishes a `visit` event (SSE and realtime) and needs no new connection. The saving screen also refreshes arrivals, history and GHM.
- **Styles:** row and check-in styles are in `giniflow-station.css`. Window styles are in `homeSample.css`, and the window reuses the cancellation dialog's classes.
- **Tests:** G105 passes all 10 checks. P4C-13, P4C-43, P4C-51, G98 and GHM G03 also pass (66 tests).

## 11. Part 2 — Reception and the lab set the category (plan, 20 Oct 2026)

### 11.1 Ask

> "Like the lab collection station, we can also categorize patients at the reception station: at billing they can categorize the patient as GHM or home collection lab, and the lab collection station can categorize them too."

Today only the OBT team can set the 🏠 Home collection tag, on the GHM ops booking form, or it comes from an approved request in the patient app. Reception and the lab can't change it, so a patient who asks at the desk ("send someone home for my sample tomorrow", or "I'll give it here instead") has to be sent back to OBT.

### 11.2 Decisions (answered 20 Oct)

| #   | Question                                                      | Answer                                                                                                                                                                            |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Where is the choice saved?                                    | **The same booking tag** the GHM ops page sets (`appointments.home_collection`), so every screen agrees. Each change goes into the GHM "status changed" history with who made it. |
| P2  | Where at reception?                                           | **The Bill tab**, in the patient header at the billing desk.                                                                                                                      |
| P3  | After the sample is collected?                                | **Locked.** Once the sample is collected (by the lab, at home or at GHM, or by reception's "Collected at home" record), the category can't change.                                |
| P4  | A patient tagged home by a patient-app request is marked GHM? | **GHM wins for today.** That day's visit is treated as GHM, and the app request itself is not changed.                                                                            |

### 11.3 The control

Both screens use one shared control, `LabSiteControl`:

```text
Lab sample   ( ) 🏥 At GHM   (•) 🏠 Home collection        set by E2E Reception 10:42
```

- **Bill tab:** it sits in the patient header (`PatientHeader.jsx`), under the scheme. It is shown when the patient has a visit today.
- **Lab collection station:** it sits in the patient pane (`LabRoom.jsx`), above the tests, on Scribe orders and HealthRay cases alike.
- Changing it asks once, naming the patient: "Mark Manmeet Singh (P_182226) as 🏠 Home collection for today?" Then it saves. The toast says "Manmeet Singh: lab sample set to 🏠 Home collection".
- **Locked** (P3): the radios are disabled, with the reason, for example "Sample collected at home 08:40 (Harwinder) — can't change". The server refuses too (409).
- Words go with the icons, so the choice never depends on colour alone. It works with the keyboard and fits at 390 px.

### 11.4 What changes when it is switched

- **To 🏠 Home collection:**
  - Reception's 🏠 line and **🏠 Home sample** button (Part 1) appear;
  - the lab station shows the 🏠 tag and its existing **🏠 Collected at home** action;
  - the GHM ops chip shows "🏠 Not collected yet".
- **To 🏥 At GHM:** the 🏠 parts disappear from reception, the lab and GHM ops, and the patient follows the normal lab flow. Reception's earlier home records stay in history.
- **Bills, payments and lab orders don't change** either way, as in Part 1.

### 11.5 Server

- **Migration** `2026-12-05_visit_lab_site.sql`:
  - adds `giniflow_visits.lab_site` (`'home'` or `'ghm'`, nullable), plus `lab_site_by` and `lab_site_at`;
  - the field is needed for P4 (GHM must win over an app request) and for walk-ins without a booking.
- **`HOME_COLLECTION_SQL`** becomes: `lab_site` when it is set, otherwise today's rule (booking tick or app request).
- **API:** `POST /api/giniflow/visits/:visitId/lab-site { site }`, in a new service `labSite.js`. In one transaction it:
  - sets `giniflow_visits.lab_site`;
  - sets today's `appointments.home_collection` when there is a booking (P1);
  - writes the change to `appointment_change_log` through `logAppointmentEvent`, with field `home_collection` and label "Home Collection", so GHM's "status changed" tab lists it;
  - publishes a `visit` signal, so reception, the lab, the board and GHM ops refresh.
- **Who:** `BILLING_DESK` (Bill tab) or `GINIFLOW_STATION_LAB_COLLECT` (lab). Everyone else gets 403.
- **Refusals:**
  - not today's visit → 400;
  - sample already collected (P3) → 409 "The sample is already collected — the category can't change";
  - no-show or cancelled → 409.

### 11.6 Rollout — the order matters (lesson from plan 77)

`HOME_COLLECTION_SQL` is read by the reception, lab station, floor board and GHM screens. If the code reads `lab_site` before the column exists, those screens go empty on your local dev, which uses the production database. So:

1. **You run both migrations on production first** (`2026-12-04_home_sample_records.sql` from Part 1, then `2026-12-05_visit_lab_site.sql`), and tell me.
2. **Only then** do I write the code that reads `lab_site`.
3. Then deploy.

### 11.7 Tests (e2e, test DB only) — `G106-lab-site-category.spec.js`

1. On the Bill tab, a booked patient is switched to 🏠 Home collection. Reception Arrivals shows the 🏠 line, the lab station shows 🏠, GHM ops shows "🏠 Not collected yet", and the GHM status-changed history has the entry with the reception user.
2. At the lab station, a home-tagged patient is switched to 🏥 At GHM. The 🏠 parts disappear everywhere, and bills and orders are unchanged.
3. An app-request home patient is switched to GHM: GHM wins for that visit (P4), and the app request row is unchanged.
4. A walk-in without a booking can be set to home.
5. Locked after collection, three ways: the lab marks the sample collected at GHM, the lab marks it collected at home, or reception records "Collected at home". In each case the radios are disabled with the reason, and the API returns 409.
6. Roles: OBT and doctor are refused with 403; a past visit with 400.
7. 1366 px and 390 px: the control fits on both screens, and the keyboard works.

Rerun G105, G98, P4C-13, P4C-43 and GHM G03.

### 11.8 As built (20 Oct 2026)

- **Migration:** `2026-12-05_visit_lab_site.sql`. It waits at most 5 s for its lock and adds the check `NOT VALID` before validating it, because `giniflow_visits` is busy all day. Applied on production 20 Oct, and confirmed by a read-only check.
- **Rule:** `HOME_COLLECTION_SQL(v)` is now `COALESCE(v.lab_site = 'home', <booking tick or app request>)`. Where there is no visit row, it falls back to today's rule.
- **API:** `GET` and `POST /api/giniflow/stations/lab-site/:visitId` (`labSite.js`).
  - **Guard:** `BILLING_DESK` or `GINIFLOW_STATION_LAB_COLLECT`.
  - **Lock (P3):** applies when any of these exist:
    - a `sample_collected` event on the visit's orders;
    - a `sample_taken` action on one of the patient's cases that day;
    - reception's latest home record saying "collected".
  - **Booking change:** written to `appointment_change_log` with the label "Home Collection" and the values "No"/"Yes", the same words the GHM page logs.
- **OBT edits win again:** when the GHM ops page changes a booking's Home Collection tick, `followBookingTag` clears `lab_site` on that day's visit, so the booking decides once more.
- **Screens:** one `LabSiteControl`, which reads its own state and leaves the hot queries alone.
  - It is placed in the Bill tab patient header (`PatientHeader.jsx`) and at the top of the lab order and case panes (`LabRoom.jsx`).
  - Lab case rows now carry `visitId`.
- **Tests:**
  - G106 passes all 8 checks.
  - G105, G98, G103, G104, P4C-43 and GHM G03 pass.
  - P4C-13 passes, but its "open a bill from `?tab=bill&visit=`" test timed out once and passed on retry.
- **Only when there is a blood test (20 Oct, at the user's request):**
  - **Shown when:** the visit has a Scribe blood order for today (`kind = 'lab'`, with tests), a live HealthRay lab case today with tests, a lab test on a live bill line (service item linked to a catalogue test whose category is `lab`, such as HBA1C added at the counter), or is already tagged home, so a wrong tag can still be removed.
  - **Hidden otherwise.** Machine tests (ECG, X-ray, echo) don't count.
  - **Server:** refuses with 400 "This patient has no lab test today".
  - **Later orders:** if the doctor orders a blood test later, the control appears on the next refresh.
  - **Tests:** G106 check 9 covers this, and G106 passes all 9 checks.
- **Bill tab placement changed (20 Oct, plan 80):** the Lab sample control is now its own card under the bill items, not in the patient header. In the header it pushed the payments table off a 720 px laptop screen (P4C-52).
