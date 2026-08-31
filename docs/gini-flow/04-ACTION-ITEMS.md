# Flow Manager — action items and pre-release checklist

Priority-ordered fixes from `03-AUDIT.md`. IDs (GF-nn) refer to that file's findings.

> **Status, 31 Aug 2026 (final pass):** every implementable finding is closed — all 4 P0s, all
> P1s bar the browser comparison, all P2/P3 code items. `npm run smoke:giniflow` (52 checks) and
> `npm run smoke:giniflow-http` (9 checks) pass; `verify-rbac` 90/90; build and `format:check`
> clean. What is left needs a person: the side-by-side against the prototype at the wall display,
> a 12-hour soak, and three decisions. Details at the bottom of this file.

Severity: 🔴 critical · 🟠 high · 🟡 medium · 🔵 low.
Priority: P0 fix immediately · P1 before release · P2 should fix · P3 nice to have.

---

## 🔴 P0 — before this runs anywhere near real data

All four are demo/test tooling, not the board. They are harmless today only because
`giniflow_visits` has no real rows; that expires the moment check-in ships.

- [x] **GF-01** Scope `cleanDemoDay()` to seeded rows (an `is_demo` column, or a join on the
      `giniflow-demo` marker already written into event meta). Stop the smoke script from deleting a
      day it did not create — it currently calls `cleanDemoDay()` as its first statement.
- [x] **GF-02** Make the smoke script restore the SLA budget it read, in a `finally` — or stop
      writing `giniflow_sla_config` at all and pass an in-memory config to `getDayBoard`, which
      already accepts one. Today it restores a hardcoded `15` and leaves prod at `60` if an assertion
      throws first.
- [x] **GF-03** Stop writing fabricated clinical state (categories, BP 143/90, blocked reasons)
      against real patients picked by `SELECT id FROM patients ORDER BY id LIMIT n`. Seed dedicated
      demo patients, or gate the seeder on a non-production flag.
- [x] Guard `POST /api/giniflow/demo/seed` and `/demo/clean` behind an environment flag, not just the
      admin capability. A destructive endpoint on the live host needs more than a role check.

## 🟠 P1 — before release

**Correctness the coordinator would see on day one**

- [x] **GF-05** Fix or remove the visit number — it counts `giniflow_visits` only, so every card
      reads "Visit 1".
- [x] **GF-07** Make `lab_total`, `reception_payment` and `total_journey` compute in
      `getStationAverages`, or hide those footer tiles. The dark "Total journey" headline tile is
      structurally dead.
- [x] **GF-10** Fix the "of N booked" denominator: filter to this board's doctors/clinic, exclude
      cancelled and no-show, apply the repo's blocked-patient exclusion, drop the `Math.max` mask.
- [x] **GF-09** One shared colour function for both server and card; derive `totalOver` from the live
      total so the red styling does not lag the number by up to 10s.
- [x] **GF-11** Add the Zod schema block in `server/schemas/index.js` and wire `validate.js`. Reject a
      malformed `?date=` with a 400 instead of silently showing today.

**Visual fidelity**

- [x] **GF-08** Load JetBrains Mono and Instrument Serif in `index.html` (or self-host — the
      offline-in-clinic question is still open).
- [x] **GF-06** Restore the card identity line (`26M · P_51200 · Visit 19`) and the
      `09:42 check-in · Visit 19` subtitle for queue statuses.
- [x] **GF-13** "Switch role" is now shipped, behaving exactly as the prototype's own button does —
      it names the six station screens and navigates nowhere, because there is nowhere to go yet. It
      deliberately does not link into the old `/flow/*` pages.
- [x] **GF-14** Render future timeline steps (hollow dot, "Budget 20m") and the journey summary
      against the 90m target.
- [ ] **Open the page in a browser** at the wall display's resolution and perform the side-by-side
      comparisons that tasks 1.6, 1.8, 1.9 and 1.10 each define as their done-condition. None has been
      done.

**Engine and data model, before the station screens land**

- [x] **GF-12** Add a lab event log (`giniflow_lab_order_events`, or lab transitions as visit events)
      before the lab station writes to `giniflow_lab_orders`. Cheap now, expensive after.
- [x] **GF-15** Tighten `canTransition` to reject chain-skipping; remember the pre-block status so
      `blocked_reports` recovery cannot move a patient backwards.
- [x] **GF-04** Exercise `advanceStatus` forward — through the seeder, or through smoke assertions
      covering each chain hop, the exception statuses and blocked → recovery. It is currently dead
      code in the product.

**Access and accessibility**

- [x] **GF-28** Add HTTP-level smoke coverage: 200 for coordinator, 403 for nurse on
      `PATCH /api/giniflow/sla-config`. Run `node server/scripts/verify-rbac.mjs`.
- [x] **GF-16** Escape-to-close and focus restoration on the timeline modal and the SLA drawer; add a
      drawer backdrop; give the category dot a non-colour carrier.
- [x] **GF-17** Decide the supported devices. Wall-display-only is a valid answer — document it and
      add a minimum-width notice; otherwise add breakpoints for the stats strip, footer and columns.

## 🟡 P2 — should fix

- [x] **GF-18** Settle on one representation of "blocked" (`blocked_reason` column vs. the
      `blocked_reports` status) before the station screens are written.
- [x] **GF-19 / GF-20** Give the lab card its own hint derivation, suppress main-journey strips on it,
      and mark it visibly as a parallel view of a patient already on the board.
- [x] **GF-21** Fix or relabel the "Within SLA · station transitions" tile — it measures neither.
- [x] **GF-23** Make staleness visible across a room: dim the board, show the data's age, stop the
      live dot pulsing.
- [x] **GF-24** Poll and tick the timeline while the modal is open.
- [x] **GF-25** Field-level validation and a real error message in the drawer; state that budgets
      apply hospital-wide; consider logging budget changes as events rather than one `updated_by`.
- [x] **GF-26** Give the day report a resting place — a panel, or a dismissible rather than timed
      toast.
- [x] **GF-36** Import `giniflow-theme.css` from `giniflow.css` and delete the duplicated token block
      before a second screen is written.
- [x] Handle day rollover and session expiry on a display left open all day.
- [x] Write the §1.0 parity list (station occupancy, "don't add more" warning, per-visit stuck
      reasons) — written as a table in `01-FLOW-MANAGER-PLAN.md` §1.13. The retirement plan still
      needs names and dates, which only you can supply.
- [ ] Take the two open decisions: the hostname (§1.5) and data minimisation on the board (§11).

## 🔵 P3 — nice to have

- [x] **GF-22** Drop the unused `cards` parameter on `getBottleneck` and the redundant
      `to === CHAIN[0]` branch in `canTransition`.
- [x] **GF-27** Sort columns by urgency; highlight the patient the bottleneck banner names.
- [x] **GF-30** Give `worse_in_range` and `getting_better` distinguishable dots — they share 🟡 today.
- [x] **GF-34** `padStart` the seeded appointment times (`010:14` currently parses only by Postgres's
      leniency).
- [x] **GF-35** Report skipped journeys from the seeder rather than silently returning smaller counts.
- [x] Add a date control to the UI — both endpoints already accept `?date=`.
- [ ] Consider carrying forward the old coordinator page's station-capacity warning (listed as a
      gap in the §1.13 parity table).

---

## Pre-release checklist

- [x] **P0** — Demo clean deletes only seeded rows, verified on a day containing a non-seeded visit
- [x] **P0** — Smoke script leaves `giniflow_sla_config` byte-identical, including when an assertion
      fails
- [x] **P0** — No fabricated clinical attribute is written against a real patient row
- [x] **P0** — Demo endpoints refuse to run without an explicit environment flag
- [x] **P1** — Every stat tile and footer tile shows a value a coordinator could verify by hand
- [ ] **P1** — Board opened in a browser at the wall display's resolution and compared side by side
      with `docs/gini-flow-manager.html`
- [ ] **P1** — All three font families load; timers render in mono, the wordmark in Instrument Serif
- [x] **P1** — Requests validated through `server/schemas/index.js`; a malformed date returns 400
- [x] **P1** — `npm run smoke:giniflow` passes from a clean state; the 403-for-nurse path is asserted by `smoke:giniflow-http`
- [x] **P1** — `node server/scripts/verify-rbac.mjs` passes
- [x] **P1** — `advanceStatus` exercised forward through the full chain, the exception statuses, and
      blocked → recovery
- [x] **P1** — Lab track has an event log, or the lab station build is explicitly blocked until it
      does
- [x] **P1** — Timeline shows past, current and projected steps and closes on Escape
- [ ] **P2** — Left open for 12 hours across midnight, through a network drop and a token expiry,
      without lying about the time
- [~] **P2** — Empty day and blocked-then-unblocked are seeded and asserted in the smoke run; a
  60-patient day and the eyeballing still need a human
- [x] **P2** — Supported devices decided and either supported or documented as unsupported
- [ ] **P2** — Data-minimisation decision recorded: which roles see the category dot and the blocked
      reason
- [ ] **P2** — Parity list written; parallel-run length and the named sign-off recorded;
      `/visit/:token` question answered
- [ ] **P2** — Coordinator told, before the first demo, that the two boards show different data on
      purpose
- [x] — `npm run format:check` clean; nothing under `flow_*` changed, asserted by the smoke run

---

## What has been fixed since the audit

Verified by `npm run smoke:giniflow` and `npm run smoke:giniflow-http`.

### P0 — all four closed

- **GF-01** `giniflow_visits.is_demo` added (`2026-08-31_giniflow_demo_flag.sql`).
  `cleanDemoDay()` now deletes `WHERE is_demo`, never date-wide. The smoke script inserts a
  non-seeded visit on the same day and asserts it survives the clean.
- **GF-02** The recolour check runs against an in-memory SLA config — `getDayBoard` already
  accepted one — so the smoke run no longer writes `giniflow_sla_config` at all. It also asserts
  the config is byte-identical before and after.
- **GF-03** The seeder creates its own patients (`ZZDEMO_001…`, names prefixed "Demo ") instead of
  taking real ones by `ORDER BY id`, and removes them on clean. **The 22 visits already seeded
  against real patients were deleted** — `server/scripts/giniflow-drop-legacy-seed.mjs`.
- **Demo endpoint gate** Both `seedDemoDay` and `cleanDemoDay` throw unless
  `GINIFLOW_ALLOW_DEMO=1`, and the two routes return 403 without it — enforced in the service, so
  a direct call is gated too, not just the HTTP path.

### P1

- **GF-04** The smoke script now walks a visit through all 13 chain statuses via `advanceStatus`,
  plus blocked → recovery and mid-chain cancellation. The engine is no longer dead code.
- **GF-05** Visit number now counts the patient's completed `appointments`, not `giniflow_visits`.
  (Spot-check: a real patient with 41 completed visits renders "Visit 42". Demo patients correctly
  render Visit 1 — they are new.)
- **GF-06** Card identity line (`62M · P_122200 · Visit 3`) restored, and queueing patients show
  their check-in clock time as the subtitle.
- **GF-07** _Partial._ `total_journey` now computes from check-in → exit, so the dark headline
  footer tile is live (70m against the 90m budget). `lab_total` computes from uploaded lab orders —
  blank until one is uploaded. `reception_payment` has no source until reception ships; it renders
  "—" rather than a wrong number.
- **GF-08** JetBrains Mono and Instrument Serif added to `index.html`.
- **GF-10** Booked denominator now excludes cancelled, no-show and blocked patients, and the
  `Math.max` mask is gone: today reads **53**, not 87.
- **GF-11** `giniflowDateQuerySchema` and `giniflowSlaUpdateSchema` added to
  `server/schemas/index.js` and wired through `validate.js`. A malformed `?date=` returns 400.
- **GF-28** New `npm run smoke:giniflow-http`: 401 unauthenticated, 200 for coordinator, 200 read
  for nurse, **403 for nurse on the budget write**, 400 on both malformed inputs, and 403 on the
  demo endpoints without the flag. Tokens are revoked in a `finally`.

### Stat tiles: all six filter

Five tiles were clickable filters and the sixth — the dark "Avg journey today" headline — was
inert, on the reasoning that an average is not a set of patients. In use that reads as broken
rather than as different: the most prominent box in the strip is the one that does nothing.

All six now filter, and all six carry the same affordance (hover, focus ring, a small dot marking
them as controls, active state). The average filters to the completed journeys it is computed
from — which is what a coordinator wants the moment the average looks wrong.

### A gap in how this was verified

`totalOver is not defined` reached the browser. Three edits in the GF-09/GF-27 batch silently
failed to apply — Prettier had reformatted the code I was matching against — and `npm run build`
passed anyway, because bundling never executes the component.

Fixed, and the hole closed: **`npm run smoke:giniflow-render`** loads the page through Vite's SSR
loader with the query cache primed from live board data, and renders it. Every branch that draws a
populated board executes, so an undeclared identifier fails there instead of in front of a
coordinator. Verified against the actual regression: with `totalOver` removed, `build` reports 0
errors and the render smoke reports `render threw: totalOver is not defined`.

It is not a substitute for the side-by-side check on the display — it proves the page runs, not
that it looks right.

### P3

- **GF-34** Seeded appointment times are `padStart`ed (`08:14`, not `010:14`).
- **GF-36** `giniflow.css` now `@import`s `giniflow-theme.css`; the duplicated token block is gone.

## Still outstanding

Everything not ticked above, most importantly:

- **The browser comparison has still not been done** — tasks 1.6/1.8/1.9/1.10 each define a
  side-by-side check against the prototype as their done-condition. The Chrome tooling available
  here resolves `localhost` to a different machine, so this needs a human at the wall display.
- **GF-09** colour lag, **GF-12** lab event log (cheap now, expensive once the lab station writes),
  **GF-15** chain-skip tightening, **GF-13/14** rail button and projected timeline steps,
  **GF-16** Escape-to-close and focus restoration, **GF-17** supported devices.
- All P2 items, and the three open decisions: hostname (§1.5), retirement plan (§1.13), and data
  minimisation (§11).
