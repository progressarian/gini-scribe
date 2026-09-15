# 46 — X-Ray Station, ordered before Echo

Status: **IMPLEMENTED**, pending a person to hold the role. See §5.

Companion to `45-ECHO-STATION-PLAN.md`, which this repeats almost exactly —
plus one new primitive Echo didn't need: a machine can require another
machine done first.

## 1. Starting point — different from Echo's

Echo, before `36-MACHINE-TEST-STATION-PLAN.md` onboarded it, was dormant but
catalogued. X-ray was neither: `flow_step_catalog.x_ray` existed with
`machine = false` and had **never had a single `giniflow_visit_steps` row
placed against it**, no `giniflow_test_catalog` row, no `giniflow_lab_orders`
ever raised with an X-ray test name — while carrying real clinical volume
(**79 X-ray documents in the last 30 days**, arriving and classifying
correctly as `documents.doc_type = 'xray'` the whole time). `36` deliberately
kept X-ray out ("X-Ray is out — it stays wherever radiology runs it today",
repeated in `2026-09-20_machine_step_catalog.sql`). This plan reverses that
call, the same way Echo's own exclusion got reversed later.

## 2. What shipped

- `server/migrations/2026-09-29_machine_xray.sql`:
  - Widened the `machine_station` CHECK to `'machine_room' | 'echo' | 'xray'`.
  - Added `flow_step_catalog.machine_requires_before TEXT` — a machine can
    name another machine's id it can't start until that one is `reported`.
    No FK; matched by convention like `order_test_name` already is, so a
    later rename doesn't need a migration to fix.
  - Flipped `x_ray`: `machine = TRUE`, `machine_station = 'xray'`,
    `report_doc_types = ARRAY['xray']` (documents already classify this way —
    no classifier change needed), duration unchanged at 15 min.
  - Set `echo.machine_requires_before = 'x_ray'` — the one instance of the
    new primitive today.
  - Seeded `giniflow_test_catalog` with an `X-Ray` row at a ₹500 placeholder
    price (`source: 'prototype_placeholder'`, same shape as Echo's).
- `shared/machineStages.js`: `shapeMachine()` exposes `requiresBefore`.
- `server/services/giniflow/machineStation.js`:
  - `assertReadyToStart` (the service-side refusal) gained a third check
    alongside vitals and blood-drawn: if the machine being started has
    `requiresBefore` set, refuse if an order for that other machine on the
    same visit is still open (`sample_status <> 'reported'`).
  - `getMachineQueue`'s row-level `blockedReason`/`nextAction` computation
    gained the same check, done as a pass over the **whole day's unfiltered
    rows before the station filter** — the blocking order (X-ray) usually
    lives on a different screen than the row it blocks (Echo), so the button
    must still come back disabled even though X-ray's own order is invisible
    on the Echo screen itself.
  - Both checks are one-directional and generic: only a machine that names a
    `requiresBefore` is affected. X-ray's own start is never blocked by
    anything (no machine currently names X-ray as *their* `requiresBefore`
    dependency in the other direction).
- Route, capability (`GINIFLOW_STATION_XRAY`, `GINIFLOW_XRAY_REPORT_REMOVE`),
  role (`xray_tech`), page (`XrayStationPage.jsx`), launcher tile, login
  entry — all identical in shape to Echo's, reusing
  `mountMachineStationRoutes` and `MachineStationPage` unchanged.
- `stationSummary.js`'s Echo-only split (`machine` count minus Echo's) was
  generalized to loop every non-`machine_room` station in the catalogue, so
  X-ray's tile came for free and a future third split needs no code change.
- `seed-xray-demo.mjs` — same shape as `seed-echo-demo.mjs`, plus one patient
  carrying both an open X-ray and an open Echo order, so the new gate is
  visible from the browser, not just the verification script.

## 3. Verified (synthetic order, cleaned up after — no data kept)

- Starting Echo while its visit's X-ray order is still open: refused, both at
  the button (`blockedReason: "X-Ray must be done before this test"`,
  `nextAction: null`) and at the service if forced anyway.
- Starting X-ray itself: unaffected, always offered.
- X-ray marked `reported`: Echo's start is then offered and succeeds.
- Machine Room, Echo and X-ray queues stay mutually exclusive
  (`machinesForStation` scoping, unchanged from Echo's own work).
- Launcher tiles: `machine` / `echo` / `xray` all report independent, correct
  counts.
- Samples-only patient hiding (`floorSettings.js`) needed no changes — it's
  already wired generically into the queue/candidates queries X-ray reuses.

## 4. Still needs a person

- An admin sets X-ray's real price on `/settings/tests` (₹500 placeholder
  ships with the migration).
- An admin creates the X-ray technician's account on `/admin/doctors` with
  role **X-Ray Station** and sets their PIN.
