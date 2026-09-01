# Pharmacy station — dispensing, counselling, and the exit

**Date:** 2 Sep 2026
**Status:** built — service, 5 endpoints, page + 2 components, hook, `smoke:giniflow-pharmacy`
**Brief:** `Gini-Flow-Developer-Brief.docx` §1.2, §2.3 (trigger 5), §4.6, §5 (Phase 4)
**Route:** `/giniflow/station/pharmacy`
**Receives from:** `14-CONSULTANT-PRESCRIPTION-PLAN.md` — Finalize is what fills this queue

The last station on the floor. When it marks a patient dispensed, the visit ends and the board's
"Done today" column is the only place they appear again.

---

## 1. Which prototype files this screen comes from

The brief attaches 8 HTML files. For the pharmacy, exactly one is a build target — all in
`docs/Flow-Manage/`:

| File                                           | What it holds                                                                                                                                              | Use                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **`gini-stations.html`** → `#s-pharmacy`       | The queue: three day counts, "To dispense" list with stock warnings per patient, "Dispensed today"                                                         | **Build** — §4                               |
| **`gini-stations.html`** → `#pharmPane`        | The detail slide-over: counselling note (Hindi + English), stock warnings, the full medicine card with per-medicine Dispense buttons, "Mark all dispensed" | **Build** — §5–7                             |
| `gini-doctor-final.html` → `s-medcard`         | The card this station renders, in the consultant's own layout                                                                                              | Reference — the data is the same `buildCard` |
| `gini-flow-manager.html`                       | Where a dispensed patient lands (Done today)                                                                                                               | Built (Phase 1)                              |
| `gini-doctor-view.html`, `gini-doctor-v2.html` | Earlier doctor iterations                                                                                                                                  | **Superseded — ignore**                      |

**One file to build from: `gini-stations.html`.** Its `#s-lab`, `#s-reception` and `#s-referrals`
sections are the lab station (built), reception (built) and referrals (not this plan) — the pharmacy
work is `#s-pharmacy` and `#pharmPane` only.

## 2. Where this sits

```
Finalize ──► pharmacy_pending ──► dispensed ──► exited
             (this queue)         (all meds     (the visit is
                                   handed over)   over)
```

All three statuses exist; the `pharmacy` SLA budget (10 min) exists; the board's "At pharmacy" column
already renders `doctor_done` + `pharmacy_pending`. **No status-chain work is needed.**

## 3. What already exists — and what that means

The single most important finding of this plan: **the repo already has a per-medicine dispensing
record, and it is in daily use.**

| Need                       | Already in the repo                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-medicine dispense mark | **`medicine_collections`** — `(medication_id, patient_id, appointment_id, collected_date, status, reason, qty_note, marked_by)`, unique on `(medication_id, collected_date)` |
| The API for it             | `server/routes/medicineCollection.js` — mark one, **mark many in one call**, today's list, per-patient history, a not-collected report                                       |
| The capability             | `MED_COLLECTION`, already granted to `pharmacy`                                                                                                                              |
| The medicine card          | `medicineCard.buildCard(patientId)` — built for the consultant, grouped by timing, external meds flagged                                                                     |
| Stock                      | `pharmacy_inventory` — created, **empty** (`14` §7)                                                                                                                          |
| WhatsApp                   | `services/msg91.js` — real WhatsApp sending, template-based                                                                                                                  |

**So this station is mostly a screen over things that exist.** The plan's job is to say what it must
NOT duplicate:

- **Do not create a `giniflow_dispensing` table.** `medicine_collections` is the dispensing record,
  it already has a bulk endpoint, and the not-collected report is built on it. A second one would
  split "did the patient get their medicines" across two tables.
- **Do not re-implement the medicine card.** `buildCard` is the one implementation, by design
  (`14` §5). The pharmacy renders it with dispense controls attached; it does not compute it again.

### 3.1 WATI is not this repo's messenger

The brief says WhatsApp via **WATI**. This repo sends WhatsApp through **MSG91**
(`control.msg91.com/api/v5/whatsapp/...`), template-based, with `MSG91_WA_TEMPLATE_NAME` /
`MSG91_WA_FLOW_TEMPLATE_NAME` in env and a dev fallback that logs instead of sending.

**Use MSG91.** Adding WATI would mean two WhatsApp vendors, two template approval queues and two
sets of credentials for one hospital. What survives from the brief is the _warning_: a new template
needs approval and that takes days, so the medicine-card template should be submitted the week this
plan is picked up, not the week the screen is finished.

## 4. Screen 1 — the queue (`#s-pharmacy`)

### 4.1 Three counts

| Tile               | Value                                                  |
| ------------------ | ------------------------------------------------------ |
| **To dispense**    | `pharmacy_pending` today — "prescription ready"        |
| **Stock warnings** | of those, how many have a low or out-of-stock medicine |
| **Dispensed**      | `dispensed` or `exited` today                          |

### 4.2 The card

From the prototype, per patient:

```
SK  Sandeep Kumar  P_177562                              ⚠ 1 out of stock
    50M · Finalized 10:22 · Dr. Bhansali · 7 medicines            [Dispense]
    💊 Cospiaq · Lipaglyn · Atchol 40 · CONCOR AM · Fenofibrate 145  +1 low
                                                          2m since finalized
```

- **Finalized at** — the `doctor_done` event's time, not "checked in": what this station waits on is
  the doctor finishing.
- **Medicine names inline** — the pharmacist starts pulling stock from the list before opening
  anything.
- **The timer** is minutes since `pharmacy_pending`, coloured against the 10-minute `pharmacy`
  budget, live-ticking like every other station.
- **Stock chips** (`⚠ 1 out of stock`, `+1 low`) are **absent entirely while `pharmacy_inventory` is
  empty** — not rendered as "all in stock". The prototype's `All in stock` line is a claim this
  system cannot currently make (`14` §7, review CS-06).

Ordering: priority (`10-QUEUE-CONTROL-PLAN.md`), then longest waiting. Same `compareQueue`.

## 5. Screen 2 — the detail pane (`#pharmPane`)

Three blocks, in the prototype's order, which is the order the counter uses them.

### 5.1 Counselling note — Hindi first, then English

The prototype writes it out longhand. It is **generated from the prescription's `change_type`
values** (brief §4.6), which is why `change_type` was added to `medications` in `14` §1:

> आज की दवाइयाँ: … Atchol की dose बढ़ाई गई है (20mg से 40mg), और एक नई दवाई Fenofibrate 145mg शुरू की गई है …
>
> In English: Two changes today — Atchol dose increased to 40mg, and Fenofibrate 145mg added for very
> high triglycerides.

Composed from the `changed`, `new` and `stopped` rows plus each one's `clinical_note` — a template,
not free text, so it cannot drift from what was actually prescribed. **Hindi is rendered first**
because it is the language the sentence will be read aloud in.

Where a medicine has no Hindi instruction, that line is English-only. Machine-translating a dosing
instruction is not on the table.

### 5.2 Stock warnings for this prescription

Per medicine, only where inventory knows: `Lipaglyn 4mg — only 9 tabs left. Enough for ~9 days.` and
`Telma AM 40+5 — out of stock. Doctor has been notified.` Inert until stock data exists.

### 5.3 The medicine card, with dispense controls

`buildCard`, rendered as the prototype does — slot by slot with the clock time, and for each medicine:
name, dose, form, route, **what it is for**, the English instruction, the Hindi instruction, and the
prescriber. Then per row:

| Case          | Control                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| Gini medicine | **`Dispense`** → `medicine_collections` status `given`                                       |
| Not available | **`Not given`** + a reason (out of stock, patient declined, brought from outside)            |
| Out of stock  | The alternative the consultant recorded, or `Use <alternative>` — never a bare block         |
| **External**  | **No control.** Shown, marked `External · not dispensed by Gini`, with the prescriber's name |

## 6. Mark all dispensed — the exit

The prototype's green button. What it does, in one transaction:

```
Mark all dispensed
  ├─ medicine_collections   → every Gini medicine marked `given` (existing bulk endpoint)
  ├─ giniflow_visits        → pharmacy_pending → dispensed → exited   (advanceStatus ×2)
  └─ WhatsApp               → medicine card to the patient   (AFTER commit, fire-and-forget)
```

**Two rules the screen must enforce:**

1. **A medicine marked "not given" blocks the blanket button.** If anything was not handed over, the
   button becomes `Dispense the rest` and the not-given rows keep their reason. A patient who left
   without two of their medicines must not be recorded as fully dispensed — that is exactly what the
   not-collected report exists to catch.
2. **`exited` ends the visit.** Like the board's Done drop (`BQ-03`), it confirms first, and says
   what it does: the patient's journey closes and the day's stats recompute.

## 7. Server side

New `server/services/giniflow/pharmacyStation.js`:

| Function                                     | Does                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `getPharmacyQueue(date, now)`                | three counts, to-dispense list, dispensed-today list                       |
| `getPharmacyPatient(visitId)`                | counselling note + stock warnings + `buildCard` + per-row collection state |
| `dispenseItem(medicationId, status, reason)` | delegates to the existing collection service                               |
| `dispenseAll(visitId, actorId)`              | bulk mark + `dispensed` → `exited`, one transaction                        |
| `sendCardToPatient(visitId)`                 | MSG91 template send, after commit, idempotent                              |

New `server/services/giniflow/counsellingNote.js` — pure, testable, no database: takes the
prescription rows and returns `{ hindi, english, changes[] }`. Pure because it is the one thing here
that is a language artefact rather than a query, and it is worth being able to test its output
without a floor.

## 8. API

Behind a new `GINIFLOW_STATION_PHARMACY` capability (granted to `pharmacy` and `admin` only):

| Method | Path                                                       | Body                                 |
| ------ | ---------------------------------------------------------- | ------------------------------------ |
| GET    | `/api/giniflow/stations/pharmacy/queue`                    | `?date`                              |
| GET    | `/api/giniflow/stations/pharmacy/:visitId`                 | —                                    |
| POST   | `/api/giniflow/stations/pharmacy/:visitId/dispense/:medId` | `{ status, reason?, qtyNote? }`      |
| POST   | `/api/giniflow/stations/pharmacy/:visitId/dispense-all`    | `{ confirm: true }`                  |
| POST   | `/api/giniflow/stations/pharmacy/:visitId/send-card`       | — (also fired automatically on exit) |

Plus `STATION_CAPS.pharmacy` in the launcher gate and an `href` on the existing Pharmacy tile —
both now present, exactly as the Consultant tile gained them in `13` §3.

## 9. Client

| File                                              | Holds                                              |
| ------------------------------------------------- | -------------------------------------------------- |
| `src/pages/giniflow/PharmacyStationPage.jsx`      | queue + detail pane (one screen, as the prototype) |
| `src/pages/giniflow/pharmacy/CounsellingNote.jsx` | the Hindi/English block with the send button       |
| `src/pages/giniflow/pharmacy/DispenseCard.jsx`    | the medicine card with per-row controls            |
| `src/queries/hooks/useGiniflowPharmacy.js`        | queue, patient, dispense, dispense-all, send       |

`.gf` is `height:100vh / overflow:hidden`, so the queue and the pane each declare their own scroll
container — the trap that caught both consultant screens.

## 10. Smoke coverage

`smoke:giniflow-pharmacy` — the queue's three counts; a card carrying the finalized time and medicine
names; the counselling note naming exactly the changed and new medicines and nothing else; external
medicines having no dispense control; **a "not given" row blocking dispense-all**; `dispensed` and
`exited` both logged once with `actor_role = 'pharmacy'`; `medicine_collections` rows written for
every Gini medicine and none for externals; the WhatsApp send not running inside the transaction.

## 11. Open questions

1. **The WhatsApp template.** Body variables for the medicine card, and its MSG91 approval — start
   now, it gates §6's last branch. Until it is approved, `sendCardToPatient` logs in dev exactly as
   `sendOtpSms` already does.
2. **Stock, still** (`14` §7). Everything stock-shaped on this screen is inert without it — including
   the "Stock warnings" count tile, which will read 0 rather than being hidden.
3. **Does the pharmacy hand out a printed card too?** The prototype only sends. If a printed card is
   wanted, `prescriptionHtmlPdf.js` already renders one.
4. **`stampRxJourney`** — the existing collection endpoint stamps the OLD `flow_*` module's journey.
   Calling it from Gini Flow would reconnect the two systems (§2.3, GF-13). The Gini Flow path should
   skip that stamp; confirm nothing downstream depends on it for pharmacy-marked meds.
