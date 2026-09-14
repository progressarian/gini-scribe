# 41 — Machines in Flow settings, not in code

Status: **S1–S5 and S7 shipped 14 Sep 2026** (machines read from the database, identical to the old literal; `npm run smoke:machine-catalog`). **S6 — the Flow settings editor — not started.** Beyond §3 D1, the migration also added `machine_order` (Machine Room tab order — `display_order` put TMT before Fundus) and `machine_full_name`. Follows `36-MACHINE-TEST-STATION-PLAN.md` and `39-HYBRID-FLOOR-PLAN.md` §16.

---

## 1. What was asked

> `MACHINES` is hard-coded — why? Move it so it can be managed from Flow settings.

Today every machine the Machine Room knows — ABI, VPT, Fundus, TMT, ECG, 2D Echo — is a literal in
`shared/machineStages.js`. Adding Echo on 14 Sep 2026 took a code change, a migration and a deploy, and
the patient's Echo could not appear until all three shipped. The value fields for TMT, Fundus, ECG and
Echo are a developer's guess, and the floor cannot correct them.

---

## 2. What the hard-coded list decides today

| Field              | Used by                                                               | Also in the database?                                     |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------------- |
| `id`               | order ↔ machine, journey step id, Machine Room tabs                   | yes — `flow_step_catalog.id` (`abi`, `vpt`, … `echo`)     |
| `name`, `fullName` | Machine Room cards, journey, billing-scan log                         | `flow_step_catalog.name` (differs: "ABI Test" vs "ABI")   |
| `durationMin`      | Machine Room wait estimate (`waitMinutesFor`)                         | **duplicated** — `flow_step_catalog.default_duration_min` |
| `tests`            | HealthRay bill-line matching, order test name, catalogue price lookup | price only — `giniflow_test_catalog.test_name`            |
| `values`           | starter rows on the values form                                       | no                                                        |
| `docTypes`         | reconciliation: which HealthRay report belongs to which machine       | no (values come from `CLASSIFIER_TYPES`)                  |
| `handover`         | ECG can be closed without a report                                    | no                                                        |
| `icon`             | Machine Room tabs and cards                                           | no                                                        |

Readers: `machineStation.js` (21 uses), `machineSync.js` (6), `labResults.js`, `journey.js`,
`shared/journeyOrder.js`, `MachineStationPage.jsx` (10), `JourneyBuilder.jsx`.

**Stays in code:** `MACHINE_RUNGS` / `MACHINE_RAIL` — the Ordered → On the machine → Done → Report
ladder is behaviour, not reference data, and every rule in `advanceMachineTest` is written against it.

---

## 3. Design

### D1 — The step catalogue is the machine list

`flow_step_catalog` already has one row per machine, and its `id` is already the machine id. A second
table would be a second list to keep in step. So a machine is **a catalogue step marked as one**:

```sql
ALTER TABLE flow_step_catalog
  ADD COLUMN machine            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN machine_short_name TEXT,               -- "ABI" (card label); name stays "ABI Test"
  ADD COLUMN machine_icon       TEXT,
  ADD COLUMN bill_names         TEXT[] NOT NULL DEFAULT '{}',  -- ["2D Echo","Echo","Echocardiography"]
  ADD COLUMN order_test_name    TEXT,               -- the giniflow_test_catalog row it bills against
  ADD COLUMN value_fields       TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN report_doc_types   TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN hands_over         BOOLEAN NOT NULL DEFAULT FALSE;
```

The migration fills these for the six machines from the current literal, byte for byte, so behaviour on
the day it ships is identical. Duration comes from `default_duration_min` only — `durationMin` is deleted.
Price stays in `giniflow_test_catalog`, joined through `order_test_name`.

### D2 — One loader, one shape

`server/services/giniflow/machineCatalog.js`:

- `getMachines(db)` → `[{ id, name, fullName, icon, durationMin, tests, values, docTypes, handover }]`,
  the same shape the literal has today, read from `flow_step_catalog WHERE machine AND is_active`.
- Cached in-process for **60 s**, cleared on any write through the settings routes, so an admin's edit
  shows on the next screen refresh without a restart. The worker picks it up within a minute.

`GET /api/giniflow/machines` returns the list to the browser (any Gini Flow capability).
`useMachines()` wraps it with a long `staleTime`.

### D3 — The helpers take the list instead of importing it

`shared/machineStages.js` keeps the ladder and turns its lookups into pure functions of a list:
`machineFor(machines, id)`, `machineForTest(machines, name)`, `machineHandsOver(machines, id)`,
`machineDocTypes(machines)`, `waitMinutesFor(machines, id, ahead)`. No module-level `MACHINES`.
Every caller passes what `getMachines()` / `useMachines()` returned. This is the bulk of the change and
it is mechanical.

### D4 — Flow settings

In **Settings → Flow → Step catalog**, each row gets a **Machine test** toggle. Turning it on opens the
machine fields under the row:

| Field                       | Input                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| Short name, icon            | text                                                                 |
| Names on the HealthRay bill | tag list — at least one required                                     |
| Bills against (price)       | pick from the test catalogue (category `machine`)                    |
| Value fields                | tag list, ordered                                                    |
| Report types                | multi-select from `CLASSIFIER_TYPES` (`abi`, `ecg`, `echo`, `tmt` …) |
| No report needed            | checkbox (ECG)                                                       |

`PATCH /flow/step-catalog/:id` accepts the new fields (ADMIN, as today). Adding a new machine = add a
step, tick Machine test, fill the fields, add its price in the test catalogue. No deploy.

---

## 4. Guards

- **Bill names must be unique across machines.** Two machines both claiming "Echo" would make the
  billing scan raise two orders for one line — the save is refused with the name that collides.
- **A machine with open orders cannot be un-marked or deactivated.** Same rule the step catalogue's
  delete already applies to steps in use; the admin is told how many orders are open.
- **Renaming never re-keys orders.** Orders store the test name they were raised under. Matching an
  order back to its machine checks `order_test_name` _and_ every `bill_names` entry, so an order raised
  as "ABI" still resolves after the admin adds "ABI Test".
- **Empty or broken catalogue:** if the query fails, the loader logs and returns the last good cached
  list; it never returns an empty list silently (an empty list would make the billing scan match
  nothing and the Machine Room show no tabs).

---

## 5. Steps

| #   | Step                                                                                                                                                                                                                                            | Files                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| S1  | Migration: columns + backfill the six machines from the literal                                                                                                                                                                                 | `migrations/2026-09-23_machine_catalog.sql`                          |
| S2  | Loader + cache + `GET /api/giniflow/machines` + `useMachines()`                                                                                                                                                                                 | `machineCatalog.js`, `giniflowStations.js`, `useGiniflowMachine.js`  |
| S3  | Helpers take a list; delete `MACHINES` and `durationMin`                                                                                                                                                                                        | `shared/machineStages.js`, `shared/journeyOrder.js`                  |
| S4  | Server readers switch to `getMachines()`                                                                                                                                                                                                        | `machineStation.js`, `machineSync.js`, `labResults.js`, `journey.js` |
| S5  | Screens switch to `useMachines()`                                                                                                                                                                                                               | `MachineStationPage.jsx`, `JourneyBuilder.jsx`                       |
| S6  | Settings: Machine test toggle + fields, PATCH validation and guards                                                                                                                                                                             | `FlowAdminPage.jsx`, `routes/flow.js`                                |
| S7  | Smoke: the six machines resolve exactly as before; a bill with "2D ECHO", "ABI,VPT", "ECG" (category `ECG`) raises the same orders; a machine added through settings appears in the Machine Room and is picked up from a bill without a restart | `scripts/smoke-machine-catalog.mjs`                                  |

S1–S5 ship together and change nothing visible — the same six machines, now read from the database.
S6 is what the floor sees. S7 runs before either is deployed.

---

## 6. Not in scope

- The machine ladder (§2 "stays in code").
- Prices — already editable in the test catalogue.
- Radiology beyond the machine room (X-Ray stays where it is).

## 7. Open questions for the floor

1. **Value fields** for TMT, Fundus, ECG and 2D Echo — the current ones were chosen by a developer.
   Once S6 ships the floor can set them; until then, send the list and they go into the S1 backfill.
2. **Who edits machines** — ADMIN only (as the step catalogue today), or also a Machine Room lead?
