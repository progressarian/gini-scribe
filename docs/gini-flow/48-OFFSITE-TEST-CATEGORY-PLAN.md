# 48 · A third test category — tests that are neither the lab nor a machine

Status: plan. Not implemented.

## The question

On `/settings/tests` every test must be filed under one of two stations —
🩸 Lab or 🫀 Machine. The floor wants to price and order things that are
neither: an ultrasound done at the partner centre, an MRI/CT the patient is
sent out for, outside histopathology, a dressing or injection charge. Today
the only two answers are both wrong:

- file it as **lab** and the order lands in the blood collection queue telling
  a phlebotomist to draw a tube that does not exist;
- file it as **machine** and it wants a `flow_step_catalog` machine row, a
  station screen and somebody standing at it.

## What already exists (checked, 2026-10)

- `giniflow_test_catalog.category` is `lab | machine`, CHECK-constrained by
  `server/migrations/2026-09-19_machine_test_station.sql`. The list lives once
  in code as `CATEGORIES` in `server/services/giniflow/testCatalog.js`, and
  `server/schemas/index.js` builds both catalogue Zod schemas off it.
- The order carries the station as `giniflow_lab_orders.kind`, same two values,
  same CHECK, copied from the catalogue when the order is raised and never
  re-read (`moStation.js` `kindOf`, ~line 778) so moving a test between stations
  never drags yesterday's orders across.
- **X-Ray is already a machine test with its own station** —
  `2026-09-29_machine_xray.sql` priced it, flipped `flow_step_catalog.x_ray` to
  `machine = TRUE, machine_station = 'xray'`, and `/giniflow/station/xray`
  runs it. So X-ray is not the gap; it is the template for anything the
  hospital runs in-house.
- Ordering is category-agnostic: the MO's chips and the consultant's picker
  read `giniflow_test_catalog WHERE is_active` with no category filter.
- Billing is `kind`-agnostic: `receptionStation.js` `ORDER_SELECT` /
  `getPaymentQueue` never mention `kind`, so an order of a new kind is priced,
  paid and claimed with no change at all.
- Everything _downstream_ is not: `kind = 'lab'` or `kind = 'machine'` appears
  ~30 times across `board.js`, `labStation.js`, `machineStation.js`,
  `machineCatalog.js` and `labResults.js`. A third value is invisible to all of
  them — which is exactly what we want for the two queues, and exactly what we
  must fix by hand for results, the journey and the exit gates.

## Two answers, and which one you want

### A. It is run inside the hospital → make it a machine. No code.

Anything with a room and a person — ultrasound in-house, TMT, PFT, audiometry,
a dressing bay. This path is finished and needs no deploy:

1. `/settings/tests` → add the test, station **🫀 Machine**, set the price.
2. `/settings/flow` → the step → **Machine settings** → tick `machine`, pick
   that priced test as `order_test_name`, set short name, icon, report types.
3. It now bills at reception and queues in the **Machine Room** station.

The only thing that needs a migration is giving it a _separate_ station screen
(its own queue and capability) rather than sharing the Machine Room — that is
the `machine_station` CHECK, one station page and one capability, exactly what
plans 45 (Echo) and 46 (X-Ray) did. Start without it; split only when the
Machine Room queue is actually crowded.

### B. It is done elsewhere, or there is nothing to run → `offsite`, a third category. (Recommended feature work.)

A priced line the floor can order and reception can bill, which never enters
the lab queue or a machine queue, and which closes when the report comes back
or somebody ticks it off. This is the real gap.

## Plan for B

**Phase 0 — vocabulary and constraints (one migration).**
`server/migrations/2026-10-06_offsite_test_category.sql`: drop and re-add
`giniflow_test_catalog_category_check` as `('lab','machine','offsite')` and
`giniflow_lab_orders_kind_check` the same. Nothing is backfilled; every
existing row stays `lab`/`machine`. Apply with
`node migrations/_runOne.mjs migrations/2026-10-06_offsite_test_category.sql`
— remember `DATABASE_URL` is production.

**Phase 1 — make it selectable.**

- `CATEGORIES` in `server/services/giniflow/testCatalog.js` gains `"offsite"`;
  both Zod schemas follow for free.
- `STATIONS` in `src/pages/TestCatalogPage.jsx` gains
  `{ value: "offsite", label: "📄 Referred out" }`; the filter chips and the
  per-station counts are built off that array and need no other change.
- `addCatalogTest`'s `CATEGORIES.includes(category) ? category : "lab"` already
  handles the new value.

**Phase 2 — raise the order with the right kind.**
`moStation.js` `kindOf` is `categoryOf[name] === "machine" ? "machine" : "lab"`
— a hardcoded two-way test that silently files offsite as lab. Replace with a
whitelist: the category if it is one of the three, else `lab`. The splitter
below it already groups by kind and writes one order per kind, so an MO ticking
HbA1c + USG gets a lab order and an offsite order, priced separately. Reception's
own Blood Sample step (`journey.js`, hardcoded `'lab'`) stays as it is — that
desk only ever offers lab tests.

**Phase 3 — decide, explicitly, what offsite does to the floor.**
Proposed, and each is a one-line rule rather than a new screen:

- _Queues_: nothing. No lab column, no machine column. The `kind = 'lab'` and
  `kind = 'machine'` filters in `board.js` already give us this for free —
  the plan is to leave them alone, not to widen them.
- _Holding the patient_: an offsite order must **not** hold the visit on the
  floor (the patient is walking out to get it done). Audit each open-test gate —
  `moStation.js` `openOrders`, `observation.js`, the pharmacy/exit checks in
  `journey.js` — and confirm each one is already scoped to a kind; anything
  scoped only by `sample_status <> 'reported'` needs `AND o.kind <> 'offsite'`.
  This is the one place where "invisible by default" is wrong by default.
- _Payment_: unchanged. It appears on reception's card like any other order,
  because `getPaymentQueue` never filtered by kind.
- _Closing_: the report arrives as a document days later. Reuse the existing
  upload path — `labStation.js` `uploadReport` branches on
  `kind === 'machine' ? machine : lab`; add an offsite branch that stores under
  `giniflow/offsite/...` and advances the order to `reported` without touching
  the lab sample chain. Plus a plain "received"/"cancelled" tick somewhere the
  coordinator can reach, so an order that never comes back can be closed.
- _Results_: `labResults.js` `orderContext` / `suggestedRows` /
  `recordEntries` branch on `kind === 'machine'` and otherwise fall through to
  the lab path. Offsite falls into the lab path, which is acceptable — typed
  values against an outside report are still lab-shaped — but the
  `advanceSample(..., 'uploaded')` call at the end must be checked against the
  offsite status chain before this ships.

**Phase 4 — a smoke script.** `server/scripts/smoke-offsite-tests.mjs`, in the
shape of the existing `smoke-giniflow-*` scripts: add an offsite test, order it
alongside a lab test, assert two orders with two kinds, assert it shows on
reception's pending list, assert it does **not** appear in the lab queue, the
machine queue or any board column, and assert it does not hold the exit.

## Sequencing

Phase 0–2 is a half-day and is safe on its own: an offsite test becomes
orderable and billable, and behaves like a lab order minus the lab queue.
Phase 3 is the part that needs the floor's answer to one question —
_does an un-returned outside report hold the patient's visit open, or not?_ —
before the gate audit is written. Phase 4 before any of it reaches the floor.

## Open questions for the floor

1. Should an offsite order block visit completion until the report lands, or
   close the visit and chase the report separately? (Assumed: close.)
2. Does reception take the money for an outside test at all, or is the patient
   billed by the centre that does it? (Assumed: we price it; ₹0 is allowed.)
3. Do any of these need to be visible to the coordinator as a follow-up task,
   or is the document arriving enough?
