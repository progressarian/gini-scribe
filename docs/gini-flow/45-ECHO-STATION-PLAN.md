# 45 — Echo Station (split out of the Machine Room)

Status: **IMPLEMENTED**, pending a person to hold the role. See §5.

Companion to `36-MACHINE-TEST-STATION-PLAN.md`, which put ABI, VPT, Fundus, TMT,
ECG and (later, `2026-09-22_machine_echo.sql`) 2D Echo behind one screen and one
role, `machine_tech`. This splits Echo back out into its own screen and its own
role, run by its own person, while the patient's path through the floor stays
exactly as it was.

## 1. What changed, and what didn't

**Didn't change:** the sequencing engine. The board's "machine tests open" gate
(`getTestsPlacement`/`placeCard` in `server/services/giniflow/board.js`) is
generic across every `kind = 'machine'` order regardless of which machine — a
patient with an open Echo order was already kept out of the Chief/consultant
columns, the same as an open ABI order, before this work. Vitals-before-machine
and blood-drawn-before-machine (`assertReadyToStart` in `machineStation.js`)
already applied to Echo the same as any other machine. There is no ordering
between machines (ABI before Echo, say) — every open machine-category test just
has to be done, in any order, before Chief.

**Changed:** who can see and operate which machine.

## 2. Design

`flow_step_catalog` gained `machine_station` (`'machine_room' | 'echo'`,
default `'machine_room'`), the same admin-data move `36` Phase 0 made for
`giniflow_test_catalog.category` — which STATION a test belongs to is data, not
code.

`shared/machineStages.js` exposes `machinesForStation(machines, station)`, used
everywhere a machine list needs narrowing:

- `machineStation.js`'s `getMachineQueue(..., { station })` filters both the
  per-machine catalogue and the day's orders to one station. A one-off test
  name that matches no catalogue machine stays the Machine Room's problem, as
  it always has — Echo, a single named machine, never inherits ambiguous work.
- `addMachineTest`, `advanceMachineTest`, `removeMachineReport` (and the
  report-upload route) all gained an `assertMachineInStation` guard — refused
  in the service (403), not just hidden on the screen, so an echo_tech acting
  on an ABI order through a stale tab or a hand-built request is refused the
  same way P1/P2/P3 refuse.
- `server/routes/giniflowStations.js` mounts the whole route set twice via
  `mountMachineStationRoutes({ prefix, gate, station, reportRemoveCap })` —
  `machine` under `GINIFLOW_STATION_MACHINE`/`machine_room`, `echo` under
  `GINIFLOW_STATION_ECHO`/`echo` — rather than duplicating ~150 lines of route
  code.
- `src/pages/giniflow/MachineStationPage.jsx` takes a `station`/`label` prop
  and carries `station` to its sub-components via `StationContext` instead of
  prop-drilling. `EchoStationPage.jsx` is a two-line wrapper:
  `<MachineStationPage station="echo" label="Echo Station" />`.
- Station summary tiles split the combined machine count
  (`server/services/giniflow/stationSummary.js`) into `machine` (now excludes
  Echo) and a new `echo` tile, via `stationOrderCounts()` in
  `machineCatalog.js` — the same flatName test-matching `openMachineOrders`
  already used for a single machine, generalized to a set.

### Access

| | |
|---|---|
| Capability | `GINIFLOW_STATION_ECHO` |
| Route | `/giniflow/station/echo` |
| Roles | **`echo_tech`** (new) and `admin` |
| Tile | ❤️ Echo Station |
| Summary key | `echo` |

`echo_tech` is modelled on `machine_tech`: `PATIENT_READ, PATIENT_CHART,
LAB_PORTAL, LAB_REQUESTS, GINIFLOW_VIEW, GINIFLOW_BOARD, GINIFLOW_STATION_ECHO`.
`machine_tech` does not get `GINIFLOW_STATION_ECHO`, and `echo_tech` does not
get `GINIFLOW_STATION_MACHINE` — each is confined to its own screen. `admin`
holds both through `ALL`.

## 3. Data model

- `server/migrations/2026-09-27_machine_station_split.sql` — the
  `machine_station` column and the backfill of Echo's row. A no-op for every
  other machine.

## 4. Explicitly out of scope

The coordinator board keeps labelling any open machine-category order,
Echo included, as **"Machine Room — …"**. Splitting Echo into its own board
column was not asked for, and the settled rule ("a patient with machine tests
open is shown only in the Machine Room column, not also in Chief/consultant")
already holds regardless of which machine — an unrequested redesign here would
touch `board.js`'s placement logic for no requested benefit. Can be split out
later if the floor asks for it.

## 5. Still needs a person

An admin creates the Echo technician's account on `/admin/doctors` with role
**Echo Station** and sets their PIN — the same as Vanshika's Machine Room
account was created out-of-band in `36`.
