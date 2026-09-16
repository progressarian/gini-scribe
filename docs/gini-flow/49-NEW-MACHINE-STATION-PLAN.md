# 49 · Adding a machine test — and, when it needs one, a station of its own

Status: plan. Not implemented. Companion to 48 (offsite tests), and the
generalisation of 45 (Echo) and 46 (X-Ray), which each did this by hand.

## Where the line actually falls

X-Ray and Echo are both `category = 'machine'` in `giniflow_test_catalog`, and
both have a station of their own — that is two different decisions, taken in
two different places, and only the first one is admin work today:

|                                             | Where it lives                      | Who can change it                             |
| ------------------------------------------- | ----------------------------------- | --------------------------------------------- |
| Is this a machine test?                     | `giniflow_test_catalog.category`    | admin, on `/settings/tests`                   |
| Which machine runs it?                      | `flow_step_catalog.machine*`        | admin, on `/settings/flow` → Machine settings |
| Which **station screen** owns that machine? | `flow_step_catalog.machine_station` | **nobody — migration + deploy**               |

So a new machine test that shares the **Machine Room** queue is already zero
code: price it, tick `machine`, point `order_test_name` at it, done. A new
machine test that needs **its own screen, its own queue and its own tech role**
— what Echo and X-Ray got — is currently nine files and a migration.

## What a fourth station costs today (the checklist 45 and 46 each ran)

Using a hypothetical `usg` station as the example:

1. **Migration** — widen `flow_step_catalog_machine_station_check` (currently
   `('machine_room','echo','xray')`, `2026-09-29_machine_xray.sql`) to include
   `'usg'`, and set `machine_station = 'usg'` on that step.
2. **`shared/giniflowStatus.js`** — `MACHINE_STATION_COLUMN` (line 328) gains
   `usg: "usg"`; `MACHINE_COLUMNS`, `SIDE_TRACK_COLUMNS` and `isMachineColumn`
   derive from it. Add the matching `BOARD_COLUMNS` entry (key, name, icon,
   slaKey) or the board has a track with no column to draw it in.
3. **`shared/permissions.js`** — `ROLES.USG_TECH`, `C.GINIFLOW_STATION_USG`,
   `C.GINIFLOW_USG_REPORT_REMOVE`, and the role's capability list (copy
   `echo_tech`). `GRANT_ALL_CAPABILITIES` is `false`, so nothing works until
   this is done on both sides.
4. **`server/routes/giniflowStations.js`** — the station→capability map
   (line ~887), a `usgGate`, the `/giniflow/machines/usg` endpoint, and one
   `mountMachineStationRoutes({ prefix: "usg", gate, station, reportRemoveCap })`
   call. The route factory already exists; this is registration, not new logic.
5. **`src/pages/giniflow/UsgStationPage.jsx`** — four lines wrapping
   `<MachineStationPage station="usg" label="USG Station" />`.
6. **`src/pages/giniflow/MachineStationPage.jsx`** — the report-remove
   capability map (line ~48).
7. **`src/router.jsx`** — `lazyWithRetry` import + `/giniflow/station/usg`.
8. **`src/config/routes.js`** — the route's capability, and the role's landing
   page.
9. **`src/pages/giniflow/StationsLauncherPage.jsx`** — the tile.
10. **`src/pages/giniflow/FlowManagerPage.jsx`** — `NOTIFY_TARGET` (line ~1469)
    so the manager can ring that desk, and the column list at ~991.

Nothing here is hard. It is all the _same_ nine edits every time, and the
failure mode is silent: miss step 2 and the patient is on a machine the board
cannot draw; miss step 3 and the tech gets a blank screen.

## The plan: make a station a row, not a release

One registry, `giniflow_machine_stations`, that every one of the ten
touchpoints reads instead of a literal:

```
id            text primary key      -- 'usg'
name          text                  -- 'USG Station'
icon          text                  -- '🫧'
column_key    text                  -- board column key, usually = id
sla_key       text
display_order int
is_active     bool
```

- **Phase 1 — the table and the constraint.** Create it, seed the three rows we
  have (`machine_room`, `echo`, `xray`), and replace the `machine_station`
  CHECK with a foreign key to it. From here, adding a station is an INSERT.
- **Phase 2 — the board reads it.** `MACHINE_STATION_COLUMN` and the machine
  `BOARD_COLUMNS` entries become derived from the registry rather than literals
  in `shared/giniflowStatus.js`. This is the one genuinely fiddly part: the
  shared module is imported synchronously by both sides, so the registry has to
  reach the client through the board payload (the board already ships its column
  list) rather than by making a shared constant async.
- **Phase 3 — routes and pages become loops.** The backend already has
  `mountMachineStationRoutes` — mount it over the registry at boot instead of
  three hand-written calls. The frontend already has one generic
  `MachineStationPage` — replace the per-station page files with a single
  `/giniflow/station/:station` route that validates `:station` against the
  registry, and the launcher tiles with a map over it.
- **Phase 4 — capabilities.** The awkward one, and the reason to do it last:
  `shared/permissions.js` is a static matrix by design and a per-station
  capability cannot be invented at runtime. Proposal: one
  `GINIFLOW_STATION_MACHINE_ANY` capability plus a per-user station allow-list
  on the doctor record, so a new station grants access by assigning techs to it
  rather than by shipping a new capability. If that is too large a change to
  RBAC, keep step 3 of the checklist manual — one small PR per station — and
  still take Phases 1–3, which remove seven of the ten edits.
- **Phase 5 — an admin screen.** A "Stations" section on `/settings/flow`:
  name, icon, order, active; plus the station picker added to the existing
  `MachineSettings` panel so an admin can move a machine between stations. The
  move must apply to the **next** order only, the same rule
  `giniflow_lab_orders.kind` already follows, or a test somebody is mid-way
  through jumps off the tech's queue.

## Sequencing, and what to do in the meantime

Phases 1–3 are the value: they turn nine edits into two (the registry row and,
until Phase 4, the capability). Phase 5 is what actually answers "how do I add
it myself". If a station is needed **before** this lands, run the checklist
above — it is exactly what `45-ECHO-STATION-PLAN.md` and
`46-XRAY-STATION-PLAN.md` did, and both are worth reading as worked examples.

## Open question

Does the new test genuinely need a separate screen, or only a separate machine?
The Machine Room queue already handles several machines at once and splitting
it was justified for Echo and X-Ray by volume and by a different person
standing at each. A machine that shares a tech should share the screen — that
is zero code, today.
