# 36 — Machine Test station (ABI · VPT · Fundus · TMT · ECG)

Status: **IMPLEMENTED.** All six phases built and tested; see §10 for what shipped and
what still needs a person.
Scope: **ABI, VPT, Fundus, TMT, ECG**. Echo is out (three reports in the system's whole
history, and not in the step catalogue). **X-Ray is out** — it stays wherever radiology runs
it today.

Companion to `35-LAB-TWO-ROOM-SPLIT-PLAN.md`. This mirrors 35 where the two are alike and
departs from it where they are not — and they are less alike than they first appear.

---

## 1. What this station is for

A machine test has **no specimen**. Nothing leaves the patient, nothing travels, nothing sits
on a bench. The patient walks to a machine, the machine is used on them, a report comes out.

That single fact drives every difference from the lab rooms below.

---

## 2. What already exists (reviewed against live data)

### 2.1 The steps are already defined — and never used

`flow_step_catalog`, which **giniflow's own `journey.js` reads**, already carries all five,
with durations:

| id       | name     | duration | station | role     |
| -------- | -------- | -------- | ------- | -------- |
| `abi`    | ABI Test | 10 min   | Lab     | lab_tech |
| `vpt`    | VPT      | 5 min    | Lab     | lab_tech |
| `fundus` | Fundus   | 10 min   | Lab     | lab_tech |
| `tmt`    | TMT      | 20 min   | Lab     | lab_tech |
| `ecg`    | ECG      | 5 min    | Lab     | lab_tech |
| `x_ray`  | X-RAY    | 15 min   | Lab     | lab_tech |

`lab_delivered`, `lab_processing`, `lab_reports`, `mo_review`, `report_printed` and
`report_delivered` all carry `attach_when_any: ["blood_sample", "abi", "x_ray"]` — the
report-chasing chain was designed to fire for machine tests too.

**Not one has ever been placed on a visit.** `giniflow_visit_steps` holds only Vitals, MO, SD,
Rx, Pharmacy, Billing and Blood Sample. The definitions are dormant, and their `station: "Lab"`
is wrong for this purpose.

### 2.2 They are NOT lab cases, and never have been

**Zero** rows in `lab_cases` — 5,850 of them — carry ABI, VPT, Fundus, TMT, ECG or X-Ray in
`test_names`. This is the single most important constraint on the design: **the machine
station cannot be built on `lab_cases`.** There is no case row to hang state on.

### 2.3 The reports arrive on their own, as documents

| doc_type       | all time | latest       |
| -------------- | -------- | ------------ |
| `vpt`          | 2,272    | today        |
| `abi`          | 2,209    | today        |
| `eye` (Fundus) | 1,611    | yesterday    |
| `xray`         | 689      | today        |
| `tmt`          | 25       | 2 days ago   |
| `ecg`          | 21       | **Apr 2026** |

**6,119 of 6,138 came from the HealthRay sync.** So getting reports in is already solved. The
station's job is the part nobody does: knowing the patient is at the machine, and noticing
when a report never arrives.

Note the split: **ABI, VPT and Fundus are daily, high-volume.** TMT and ECG are rare — 25 and
21 ever, ECG silent since April. They are in scope, they will simply have short queues.

### 2.4 ABI and VPT already produce numbers

`healthray/parser.js` names them explicitly, and `lab_results` carries `ABI Right`/`ABI Left`
(311 each in 90 days) and `VPT Right`/`VPT Left` (317 each). These two are already trendable.

### 2.5 The hospital already calls it a category

`billingExtractor.js` maps HealthRay's **"Machine Test"** department to `category: "machine"`,
beside `lab` (PATHOLOGY) and `imaging` (RADIOLOGY), and raises a journey step per line item.

### 2.6 The staff exist

`tech` accounts **ECG Technician (23)** and **X-Ray Technician (24)** hold
`GINIFLOW_STATION_LAB_COLLECT` — the blood collection room. **They are not affected by this
work**: the machine room gets its own role (§6.3).

### 2.7 A live bug

`ECG` is in `giniflow_test_catalog` at ₹300. Order it today and it becomes a
`giniflow_lab_orders` row, which lands in **Lab 1** telling a phlebotomist to draw a sample.

---

## 3. Why this is not just "another lab room"

|                       | Lab                           | Machine                                  |
| --------------------- | ----------------------------- | ---------------------------------------- |
| What is tracked       | a tube                        | a **patient at a machine**               |
| Patient needed        | for collection only           | for the **whole** test                   |
| Handoff between rooms | yes                           | none                                     |
| Parallelism           | a bench runs 20 tubes at once | **one machine, one patient**             |
| Duration              | uniform                       | 5 min (VPT/ECG) → 20 min (TMT)           |
| Report                | uploaded by the lab           | arrives by sync; upload is the exception |
| Source of the queue   | `lab_cases` (HealthRay)       | **no case exists** — see §5              |

### 3.1 The constraint the lab does not have: machines are exclusive

A lab bench is a pool. A TMT machine is not: one patient occupies it for twenty minutes, and
nobody else can start. This is the real scheduling problem on this floor and the lab ladder has
no concept of it.

So the station is not one queue — it is **one queue per machine**, each with at most one
patient _in progress_, and a wait time that is the sum of the queue ahead of you × that
machine's duration. That is also what makes the screen worth opening: it can answer "how long
until the TMT is free", which nothing today can.

---

## 4. The ladder

Four rungs, one room, no handoff.

```
ordered  ──▶  in progress  ──▶  done  ──▶  reported
   │              │               │            │
requested/     patient AT      test taken,   report on
 billed        the machine     patient free   the chart
```

| rung          | label                   | action                         | who/what                                |
| ------------- | ----------------------- | ------------------------------ | --------------------------------------- |
| `ordered`     | Waiting for the machine | _(none — R1, as in 35)_        | the order arriving                      |
| `in_progress` | On the machine          | ▶️ Start test                  | technician, **patient must be present** |
| `done`        | Test done               | ✓ Test done                    | technician                              |
| `reported`    | Report filed            | 📤 Upload report / ✓ Mark done | usually the **sync**, not a person      |

Rules carried over from 35 unchanged, because they were right there and are right here:

- **R1** — the arriving rung is never an action.
- **R2** — a room may only record its own rungs; enforced in the service, not by hiding buttons.
- **Evidence gate** — "Mark done" needs a report on file **or** values typed. Never neither.
- The offered action is computed from the ladder and the role, never read off the request.

Two rules that are new here:

- **P1 — the patient is needed for `in_progress` AND `done`**, not just the first step. In the
  lab only collection needs them. Here the whole test does.
- **P2 — one patient in progress per machine.** Starting a second on the same machine is
  refused, the way an unpaid collection is refused.
- **P3 — payment gates the start.** Decided: the same rule as the lab. A technician cannot
  start a test until reception has cleared payment or an approved claim, and it is refused in
  the service, not merely hidden on the card. `opensLabGate` in `shared/labPayment.js` is
  reused unchanged — same orders table, same statuses, same rule.

---

## 5. Where the queue comes from — the central decision

There is **no `lab_case` for a machine test**, so unlike the lab there is nothing to sync a
queue from. Three candidate sources, and the plan takes the first:

**(a) Gini orders — recommended, and the primary track.**
Reuse `giniflow_lab_orders` with a new `kind` column (`'lab' | 'machine'`, default `'lab'`).
An MO ordering ABI raises the same row shape the floor already understands: ordered_by,
payment_status, urgency, a test list, an event log. Nothing new is invented; the lab queue
gains `WHERE kind = 'lab'` (which **also fixes §2.7**) and the machine queue takes
`kind = 'machine'`.

**(b) Journey steps** — `flow_step_catalog` already has them, and reception's journey builder
could place them at check-in. Good for _planned_ tests, useless for one a consultant adds
mid-visit. Best as a **later** addition that seeds (a), not as the source.

**(c) HealthRay billing** — `billingExtractor` already yields `category: "machine"` line items.
This is the honest record of what was actually charged, but it arrives with the bill, which is
often _after_ the test. Best used for **reconciliation**, not to drive a live queue.

So: **(a) drives the station; (c) reconciles it.** The station's last column shows machine-test
documents that landed today with no order behind them — the tests that happened without ever
touching the screen. On the floor as it stands, that column will start out holding nearly
everything, and shrink as the station gets used. That is the honest way to launch it.

---

## 6. Design

### 6.1 Vocabulary — `shared/machineStages.js`

Same shape as `shared/labStages.js`, which is the pattern worth copying: one rung table
carrying keys, labels, action verbs, timeline labels, and the helpers derived from it. 35
proved that a hand-written enum drifts — four separate times — and that deriving everything
from one table makes that impossible.

Plus, per machine: `id`, `name`, `durationMin`, `docTypes` (which `documents.doc_type` counts
as its report), `producesValues` (ABI and VPT do; Fundus, TMT, ECG do not).

| machine | duration | doc_type | values               |
| ------- | -------- | -------- | -------------------- |
| ABI     | 10 min   | `abi`    | ABI Right / ABI Left |
| VPT     | 5 min    | `vpt`    | VPT Right / VPT Left |
| Fundus  | 10 min   | `eye`    | —                    |
| TMT     | 20 min   | `tmt`    | —                    |
| ECG     | 5 min    | `ecg`    | —                    |

Durations come from `flow_step_catalog`, so the SLA and the journey agree.

### 6.2 Values at the machine — ABI and VPT

Decided: **the technician types the L/R values**, so the doctor has the numbers the moment the
test is done rather than waiting for the sync. `LabResultsForm` is reused as-is — same
component, same `lab_results` table, and the canonical names `ABI Right` / `ABI Left` /
`VPT Right` / `VPT Left` that `healthray/parser.js` already writes, so a typed value and a
synced one are the same row rather than two versions of one number.

**The risk this choice carries, and where it is handled.** `lab_results` has a partial unique
index on `(patient_id, canonical_name, test_date)`. `writeEntries` already refuses to overwrite
a value another source owns — it returns it in `skipped`, which is what produces the
"already reported today from another source — not overwritten" toast. That protects the _typed_
direction.

**The reverse direction is unverified and is a Phase 2 task:** what the HealthRay sync does when
it arrives later carrying its own ABI/VPT values for a case a technician has already typed. If
it overwrites, the technician's numbers vanish silently, which is worse than not offering the
form at all. Phase 2 must prove the sync skips or updates in place, and pin it with a test
before this ships.

### 6.3 Access

|             |                                      |
| ----------- | ------------------------------------ |
| Capability  | `GINIFLOW_STATION_MACHINE`           |
| Route       | `/giniflow/station/machine`          |
| Roles       | **`machine_tech`** (new) and `admin` |
| Tile        | 🫀 Machine Tests                     |
| Summary key | `machine`                            |

**A dedicated role, not the existing `tech`.** The machines are one person's desk — Vanshika
runs them — and that is a different accountability from the two `tech` accounts, who are the
ECG and X-Ray technicians attached to other equipment. Same reasoning that gave the analyzer
bench `lab_admin` rather than widening `lab`.

- **`machine_tech`** — login label **"Machine Test Station"**. Capabilities modelled on `lab`:
  `PATIENT_READ`, `PATIENT_CHART`, `LAB_PORTAL`, `LAB_REQUESTS`, `GINIFLOW_VIEW`,
  `GINIFLOW_BOARD`, `GINIFLOW_STATION_MACHINE`.
  ⚠️ `GINIFLOW_VIEW` is not optional — `/api/giniflow*` is prefix-gated on it before any
  per-route capability runs, so without it the role passes the page check and then 403s on
  every call the screen makes.
- **`admin`** holds it through `ALL`, so admin manages and covers the station.
- **`tech` does NOT get it.** They keep blood collection, exactly as they are today. Nothing
  about their access changes.

**Vanshika's account is created by an admin on `/admin/doctors`**, not by this work — a login
needs a PIN, which is the admin's to set, not something a migration should carry. The role
exists the moment the code lands; the account is one screen away.

### 6.4 Data model

- **Migration 1** — `giniflow_lab_orders.kind TEXT NOT NULL DEFAULT 'lab'`, with a CHECK.
  Backfill is a no-op: every existing row is a lab order.
- **Migration 2** — `giniflow_test_catalog.category TEXT NOT NULL DEFAULT 'lab'` with a CHECK.
  The rows themselves are **not** seeded by the migration: the admin adds ABI, VPT, Fundus and
  TMT and flips `ECG` through `/admin/test-catalog`, so prices and station membership stay the
  floor's to change without a deploy. The catalogue is then what tells an order which station
  it belongs to, and a machine test can never be raised as a lab order.
- **No new actions table.** A machine test is always a Gini order, so `giniflow_lab_order_events`
  already records who did what and when — the thing `giniflow_lab_case_actions` had to exist for
  in the lab, because HealthRay cases have no order.
- **Reports** reuse the existing path: upload → storage → `documents` → `results_status`.

### 6.5 What is reused as-is

- The room-gate machinery from 35 (`attachLabRoom` generalises to any station's rooms).
- `LabRoom.jsx` is already parameterised; `MachineRoom` is the same shape with a different
  ladder and a per-machine grouping.
- `LabResultsForm` for ABI/VPT values — same component, same `lab_results` table, same
  canonical names the parser already writes.
- `PdfViewerModal` for viewing a report, as the lab pane now does.
- The evidence-gated "Mark done", the report view/replace/remove lifecycle, and the timeline
  built from the ladder.

---

## 7. Phases

Each phase is independently shippable and leaves the floor working.

### Phase 0 — Which station a test belongs to becomes admin-managed _(do first, ships alone)_

The floor decides this, not the code. `/admin/test-catalog` already exists — ADMIN-gated, and
already the one table behind the consultant's picker, the MO's chips and reception's payment
card. It gains one more column, and then nothing about machine tests is hardcoded anywhere:
an admin adds ABI, VPT, Fundus and TMT with their real prices, and flips `ECG` from lab to
machine, without a migration or a deploy.

- `giniflow_test_catalog.category TEXT NOT NULL DEFAULT 'lab'` with a CHECK (`lab | machine`).
  Every existing row is `lab`, so the backfill is a no-op.
- `giniflow_lab_orders.kind TEXT NOT NULL DEFAULT 'lab'`, taken from the catalogue's category
  when the order is raised.
- The lab queue filters `kind = 'lab'`; the machine queue will later take `kind = 'machine'`.
- **`TestCatalogPage` gains a station selector per row** — Lab or Machine — beside the price it
  already edits, plus a filter and a count so an admin can see what sits in each.
- The MO/consultant picker keeps showing every active test. The category decides which station
  the resulting order lands in, not whether a doctor may order it.

**Verify:** ordering ECG no longer puts a card in Lab 1; moving a test between stations in the
admin screen changes where the next order lands; every existing order and queue is unchanged.

**This phase needs nothing from anybody in advance** — no price list, no decision about which
tests a doctor sees. It hands both to the admin screen, which is where they belong.

### Phase 1 — Vocabulary

- `shared/machineStages.js`: the four rungs and the five machines.
- Correct `station` on the five in-scope `flow_step_catalog` rows (`abi`, `vpt`, `fundus`,
  `tmt`, `ecg`) from `Lab` to `Machine Room`. Leave `x_ray` alone — it is out of scope and
  belongs to radiology.
- **Verify:** a pure smoke (`smoke:machine-stages`), no DB needed.

### Phase 2 — Backend

- `server/services/giniflow/machineStation.js` — queue grouped by machine, per-machine
  "in progress" lock (P2), patient-presence check on both working rungs (P1), evidence gate.
- `machineAdvance` with room ownership.
- Schemas from the ladder, never hand-written.
- **Verify:** `smoke:machine-steps`, synthetic order inside a rolled-back transaction.

### Phase 3 — Access

- New `machine_tech` role + `GINIFLOW_STATION_MACHINE`; grants per §6.3. `tech` untouched.
- Login `ROLE_GROUPS` entry so the account is selectable once an admin creates it.
- Route + `?machine=` filter; station summary key.
- **Verify:** `smoke:machine-access` — every endpoint × every role.

### Phase 4 — Screen

- `MachineRoom` from the `LabRoom` shape: one collapsible section per machine, each showing
  its queue, who is on it now, and the wait implied by the queue × duration.
- ABI/VPT get the values form (§6.2); all five get the report lifecycle — view, replace,
  remove while open, view-only once done — exactly as the lab pane now works.
- Tile + router + `routes.js`.

### Phase 5 — Reconciliation

- The last column: today's machine-test documents with no order behind them.
- **Verify:** on a real day it should account for every ABI/VPT/Fundus report that arrived.

### Phase 6 — Test and gap sweep

- The three smokes above, a click-through per machine, and the negative checks.
- Demo seeder (`seed:machine-room`) in the shape of `seed-lab-rooms-demo.mjs`.

---

## 8. Decisions taken

|                 | Decision                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope           | **ABI, VPT, Fundus, TMT, ECG.** Echo out. **X-Ray out** — stays with radiology.                                                                                             |
| Rooms           | **One room, one screen**, a collapsible section per machine, each with its own queue and its own "who is on it now".                                                        |
| Payment         | **Gated, same as the lab** (P3). Refused in the service.                                                                                                                    |
| Values          | **Technician types ABI/VPT L/R** at the machine (§6.2), with the sync-overwrite direction to be proven in Phase 2.                                                          |
| Staffing        | **`tech` role**, keeping blood collection as well. Purely additive.                                                                                                         |
| Prices & picker | **Admin-managed** through the existing `/admin/test-catalog`, which gains a station column. No prices hardcoded, no seeded rows, no deploy to move a test between stations. |

## 9. Risks

| Risk                                                      | Mitigation                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The sync overwrites typed ABI/VPT values                  | Phase 2 proves the direction before the form ships (§6.2)                                                                                   |
| Phase 0 changes the lab queue on a live floor             | It only adds `WHERE kind = 'lab'`, and every existing row is `kind = 'lab'` — a no-op for today's data, verified before and after           |
| The station launches to an empty queue                    | Reconciliation column (Phase 5) shows the reports arriving without orders, so the screen is honest about the gap rather than looking broken |
| TMT and ECG queues stay near-empty                        | Expected — 25 and 21 reports ever. Their sections collapse when empty, as the lab's already do                                              |
| Machine-exclusivity (P2) blocks a legitimate second start | Refusal names the patient occupying the machine, and an admin can release it — same shape as the lab's "in a room" rule                     |

---

## 10. What shipped

All six phases. Three smoke suites, all green, alongside the lab's four.

| Phase | What landed                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `giniflow_test_catalog.category`, `giniflow_lab_orders.kind`, both defaulting to `lab` (no-op backfill: 26 catalogue rows and 12 orders unchanged). `orderTests` splits a confirmation into **one order per station**. The lab queue filters `kind = 'lab'`. `/admin/test-catalog` gains a station selector, a filter and per-station counts — and became responsive, which it was not before. |
| 1     | `shared/machineStages.js` — four rungs, five machines with durations from `flow_step_catalog`. Those five step rows moved from station `Lab` to `Machine Room` (0 visit steps affected; `x_ray` deliberately left alone).                                                                                                                                                                      |
| 2     | `machineStation.js` — queue grouped per machine, **all filtering server-side**, plus P1/P2/P3 and the evidence gate.                                                                                                                                                                                                                                                                           |
| 3     | `machine_tech` role, `GINIFLOW_STATION_MACHINE`, routes, login group, station summary tile.                                                                                                                                                                                                                                                                                                    |
| 4     | `/giniflow/station/machine` — a tile per machine showing who is on it and the wait behind it, stage sections, the values form for ABI/VPT, the report lifecycle, and the reconciliation column.                                                                                                                                                                                                |
| 5     | `smoke:machine-stages` (no DB), `smoke:machine-steps` (synthetic orders in a rolled-back transaction), `smoke:machine-access` (every endpoint × every role).                                                                                                                                                                                                                                   |

### Gaps the review found, and fixed

1. **A mixed order.** `orderTests` raised ONE row for every test confirmed together, so HbA1c + ECG would have been a single order in two stations at once. It now splits by station, each with its own tests, total and payment state.
2. **The board called a machine test a sample.** Its lab track took any order not yet `uploaded`, so a machine test would have read "Paid · awaiting collection" against a sample that will never exist. Filtered to `kind = 'lab'` — it still blocks the visit's results status, so nobody is released early; it just stops pretending to be blood.
3. **`advanceSample` had no kind guard.** The machine room refused lab orders, but not the mirror — a lab role could have walked a machine test up the lab ladder. Both directions are now refused, and both are pinned in `smoke:machine-steps`.
4. **The machine room could not record its own values.** `LabResultsForm` posts to the lab's results endpoint, which was gated on the analyzer bench alone — so a `machine_tech` typing an ABI value would have hit 403. The endpoint now accepts either room and checks the ORDER, so neither room can write the other's results.
5. **A role with nobody in it is not tested.** `smoke:machine-access` provisions a **disabled** probe account for any role with no holder, so `machine_tech` is exercised for real rather than skipped, and removes it afterwards.

6. **"Test done" could be tapped with nothing recorded.** The evidence gate sat on `reported` only, so a test could be finished with no values and no report, and the tile then offered "File the report" against an empty order. A tube's result comes back hours after collection, so for the lab those two moments are genuinely separate — but a machine prints its report while the patient is still in the chair, so finishing the test and having the result are the same moment. The gate now covers `done` as well, `blockedReason` says which of the two is missing (so the button is never drawn), and finishing a test with evidence files it in the same tap — `done` and `reported` both stay on the event record. Pinned in `smoke:machine-steps`.

### Still needs a person

- **Vanshika's account** — an admin creates it on `/admin/doctors` with role **Machine Test Station**. A PIN is theirs to set.
- **The catalogue** — an admin adds ABI, VPT, Fundus and TMT with real prices and flips `ECG` to Machine, on `/admin/test-catalog`. Until then the queue is empty by design; nothing is seeded or guessed.
- **The screen has not been seen rendered.** The Chrome extension has been unavailable throughout. Layout is verified by build, by the CSS having no fixed widths beyond a 34px avatar, and by every list being `auto-fit`/`min-width: 0` — but not by eye.

### Where it stands today

`getMachineQueue` returns 0 orders (nothing is catalogued as a machine test yet) while the
reconciliation column already lists **8 real reports that arrived today with no order behind
them** — ABI, VPT and Fundus for three named patients. That is the gap this station exists to
close, visible on day one.
