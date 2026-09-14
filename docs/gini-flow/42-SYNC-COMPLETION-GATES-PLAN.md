# 42 — Sync completion gates: one place for "HealthRay may not complete this step until…"

Status: **OPTIONAL — later.** Not needed for plan 40, which is a single condition. Written 14 Sep 2026. Generalises `40-ORDERED-TESTS-HOLD-PLAN.md`
(the first gate built this way) and the hold in `39-HYBRID-FLOOR-PLAN.md` §5/§14.

---

## 1. Why a framework, not another `if`

The ordered-tests rule is one instance of a pattern the floor keeps asking for:

> HealthRay says step **X** is done. Scribe must not mark it done until station **Y**, which
> Scribe owns, has recorded its own work.

Today every such rule is hand-written inside `syncAppointmentsToFlow()`:

- `healthrayMayWrite()` — the allowlist
- `revivesException()` / `atPharmacyLeg()` — never-undo rules
- `holdOnUnrecorded()` + `firstUnrecordedStation()` — reception, vitals, lab, machine
- `assertReportsAreIn()` in `statusEngine.js` — reports before the first doctor step
- `chiefRoomFree()` / `consultRoomFree()` — one patient per room

Each was added by a different plan, has a different switch (or none), logs differently, and is
shown on the board differently (or not at all). The next five requests will add five more. The
risks of continuing that way are already visible in plan 40: the ordered-tests rule and the desk
rule share one switch, and a gate that judged on stale data (the unread bill) completed steps it
should not have.

This plan defines a **gate registry**: each condition is a row with a key, the targets it guards,
a predicate, a label, a switch, and what to do when it refuses. The sync, the Behind panel,
`check-held.mjs` and the smoke tests all read the same registry.

---

## 2. What a gate is

```js
// shared/syncGates.js  (browser-safe: no process.env, no SQL)
export const SYNC_GATES = [
  {
    key: "machine",
    group: "ordered_tests",
    guards: DOCTOR_COMPLETING,          // chain statuses this gate protects
    label: "Machine Room",
    reason: "Machine test ordered and not finished",
    onRefuse: "release_from_room",      // 'hold' | 'downgrade' | 'release_from_room' | 'observe'
    order: 50,                          // first failing gate is the one named
  },
  …
];
```

```js
// server/services/giniflow/syncGates.js
export const GATE_SQL = {
  machine: `EXISTS (SELECT 1 FROM giniflow_lab_orders o
                     WHERE o.visit_id = v.id AND o.urgency = 'today'
                       AND o.kind = 'machine'
                       AND o.sample_status NOT IN ('reported', 'not_done'))`,
  …
};
export const gateEnabled = (gate) => …   // env switch per group, server-only

export async function firstClosedGate(db, visitId, target)   // the enforcement read
export async function recordGateObservation(db, day)         // the day-wide panel write
```

Rules the registry enforces by construction:

1. **One predicate, two readers.** `firstClosedGate` and `recordGateObservation` are generated
   from the same `GATE_SQL`, so the gate can never hold a patient the panel says is clear
   (plan 39 §14's invariant, now structural rather than by convention).
2. **Gates guard targets, not stations.** A gate lists the chain statuses it protects. A write
   to a status no gate guards is never held.
3. **Absences are never gated.** `no_show`, `cancelled` are excluded at registry load.
4. **Gates bind the sync only.** A person at a station screen is never refused by a sync gate;
   station-side rules stay in the station services (`assertPatientIsFree`, payment gates).
5. **No news is not good news.** A gate whose data comes from a paced HealthRay read must also
   declare a freshness predicate (plan 40 §5.2). A stale read closes the gate; a stale read past
   its safety valve lapses it with `meta.gate_lapsed` on the event.
6. **Every refusal is attributable.** The event log does not record holds (nothing moved), so the
   visit row carries `held_gate`, `held_since`, and the cron line counts refusals per gate.
7. **Every group has its own switch**: `SCRIBE_GATE_<GROUP>=0` releases that group alone.

---

## 3. The current rules, migrated into the registry

No behaviour change — this is step 1, a refactor with the existing smoke tests as its proof.

| Key            | Group           | Guards           | Predicate today (source)                             | On refuse                      | Switch today                |
| -------------- | --------------- | ---------------- | ---------------------------------------------------- | ------------------------------ | --------------------------- |
| `reception`    | `desk_steps`    | all chain writes | no non-system `checked_in` event (`observation.js`)  | hold                           | `SCRIBE_HOLD_ON_UNRECORDED` |
| `vitals`       | `desk_steps`    | all chain writes | no `giniflow_vitals`, no person-written vitals event | hold                           | same                        |
| `lab`          | `ordered_tests` | all chain writes | lab order undrawn                                    | hold                           | same                        |
| `lab_results`  | `ordered_tests` | all chain writes | lab order drawn, not reported                        | hold                           | same                        |
| `machine`      | `ordered_tests` | all chain writes | machine order not reported                           | hold                           | same                        |
| `chief_room`   | `rooms`         | `with_sd`        | another visit `with_sd` (`chiefRoomFree`)            | downgrade → `sd_pending`       | none                        |
| `consult_room` | `rooms`         | `with_doctor`    | another visit `with_doctor` (`consultRoomFree`)      | downgrade → `ready_for_doctor` | none                        |

`onRefuse` therefore has three shapes: `hold` (write nothing), `downgrade` (write an earlier
status of the same station), `release_from_room` (plan 40 §5.3).

`assertReportsAreIn` stays in `statusEngine.js` — it binds **people** too (a consultant claiming a
patient), so it is not a sync gate. The registry references it in docs only.

---

## 4. Plan 40, expressed as gates

The ordered-test predicates are not new SQL: they come from `TESTS_HOLD_SQL` in
`server/services/giniflow/testsHold.js` (being built in another session), broken down by station
(plan 40 §5.4a). Lab orders finish at `uploaded` and machine orders at `reported`; HealthRay lab
cases finish at a `report_uploaded` action.

| Key           | Group           | Guards                                  | Predicate                                                 | On refuse           |
| ------------- | --------------- | --------------------------------------- | --------------------------------------------------------- | ------------------- |
| `bill_unread` | `ordered_tests` | `DOCTOR_COMPLETING`                     | HR `completed` seen after the last successful bill read   | hold (valve 20 min) |
| `payment`     | `ordered_tests` | `DOCTOR_COMPLETING`, `with_sd` re-entry | bill-raised order not cleared in Scribe (plan 40 G15)     | release_from_room   |
| `lab`         | `ordered_tests` | `DOCTOR_COMPLETING`, `with_sd` re-entry | undrawn order **or** same-day HR lab case not yet sampled | release_from_room   |
| `lab_results` | `ordered_tests` | `DOCTOR_COMPLETING`, `with_sd` re-entry | drawn, report not uploaded (plan 40 Q1)                   | release_from_room   |
| `machine`     | `ordered_tests` | `DOCTOR_COMPLETING`, `with_sd` re-entry | machine order not `reported` or `not_done`                | release_from_room   |

---

`with_sd` re-entry is the patient going back to the Chief after tests (plan 40 §5.3a). The same
gates that hold the doctor leg's completion also hold that return, so one registry entry serves
both. A gate that guards a room entry also needs a **display rule**: while it is closed, the
patient is shown at the station that owes the work (Lab track / Machine Room), not in the room's
queue (plan 40 Q3). The registry therefore carries a `showAt` field (`lab`, `machine`) that
`board.js`, `moStation.js` and `doctorStation.js` read.

---

## 5. Candidate conditions of the same type

Each of these is a real gap in the current code of the same shape — HealthRay would complete a
step that a Scribe station has not recorded. None is agreed; each needs a floor owner's "yes"
before it is built. Listed with the evidence already in the code.

| #   | Condition                                                      | Guards                  | Predicate sketch                                                                                 | Evidence / why it matters                                                                                 |
| --- | -------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| C1  | **Payment for an ordered test not cleared**                    | `DOCTOR_COMPLETING`     | `urgency='today'` order with `payment_status NOT IN ('paid','claim_approved')`                   | plan 39 §16: "for both payments clear should be done"; `labPayment.js` already defines settled            |
| C2  | **Referral raised, not seen** (dietitian, podiatry, eye…)      | `DOCTOR_COMPLETING`     | open row in the referrals station for the visit                                                  | `referralsStation.js` exists and is manual; HealthRay cannot see it                                       |
| C3  | **MO report review outstanding**                               | `sd_pending`, `with_sd` | reports arrived (`results_received` event) and no `reports_reviewed` event                       | `moStation.js` `needs_consultant` outcome; the Chief sees reports the MO never read                       |
| C4  | **Imaging/X-Ray ordered** (radiology outside the machine room) | `DOCTOR_COMPLETING`     | billed `imaging` line (`billingExtractor.js` category) with no document of that type today       | plan 36 §2.3: 689 X-Ray docs, not in any station                                                          |
| C5  | **Prescription not yet in Scribe**                             | `rx_pending`            | no HealthRay Rx PDF (`hasReceivedPrescriptionPdf`) and no `consult_finalize` / pasted Rx         | the older module already refuses completion without the PDF; Rx Explain has nothing to explain without it |
| C6  | **Follow-up tests booked for today but not ordered**           | `DOCTOR_COMPLETING`     | appointment `healthray_follow_up` lists tests and no order exists                                | GHM follow-up memory: tests hide in four places; a missed order is a missed report at the next visit      |
| C7  | **Vitals out of range and not acknowledged**                   | `sd_pending`, `with_sd` | latest `giniflow_vitals` beyond the vitals station's red thresholds and no acknowledgement event | `vitalsStation.js` thresholds; the 166/106 nobody looked at (comment in `appointmentSync.js`)             |
| C8  | **Patient blocked mid-visit**                                  | all                     | `patients.is_blocked`                                                                            | blocked patients are excluded at list time only; a block set after arrival does not stop the sync         |
| C9  | **Samples-only visit reaching a doctor status**                | doctor statuses         | `labOnlyPredicate`                                                                               | already enforced inside `advanceStatus` (`assertNotLabOnly`) — migrate for visibility, not behaviour      |

| C10 | **Journey step and order disagree** | `DOCTOR_COMPLETING` | an order is `reported`/`not_done` but its journey step is still `pending`, or the reverse | plan 40 G7: machine steps are never ticked by the station. This is a consistency check (observe only), not a hold |

Every gate in this list shares one prerequisite: **the evidence it reads must be closed by the
station that did the work, in the same transaction.** Plan 40 G7 (machine steps never ticked) and
G8 (no `not_done` state) are that prerequisite failing. Before a candidate is built, check that its
station can both _finish_ and _decline_ the work. Otherwise the gate turns into a permanent hold.

Two that look like the same shape but are **not** gates, and should stay out:

- **Pharmacy dispensing** — comes after everything HealthRay knows (plan 39 §11). HealthRay can
  never be ahead of it, so there is nothing to hold. It is an SLA question.
- **Doctor's own station taps in Scribe** — no Chief or consultant uses Scribe (plan 39 §2), so
  gating on their taps would hold every patient permanently.

---

## 6. How a gate shows on the floor

One idiom, reused — no new components:

| Place                    | What it shows                                               | Existing piece                               |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------- |
| Board card               | `⚠ HealthRay: finished · held — Machine test not finished`  | `.wait4` line, `behind` object in `board.js` |
| Behind panel             | grouped by gate label, worst wait first                     | `getBehindVisits` / `getBehindTheFloor`      |
| Station card (the owner) | `Consultation finished in HealthRay — waiting on this test` | `blockedReason` slot in lab/machine stations |
| Cron log                 | `held: machine 4 · lab 2 · bill_unread 3 · reception 11`    | `server/services/cron/index.js` sync line    |
| CLI                      | `node scripts/check-held.mjs --gate machine`                | `check-held.mjs`                             |

`BEHIND_STATIONS` / `BEHIND_STATION_LABEL` in `observation.js` become derived from the registry.
`giniflowBehindQuerySchema` validates `station` against the registry keys, so a new gate cannot
drift from the API (the enum-drift lesson recorded in `shared/machineStages.js`).

---

## 7. Data changes

Migration `2026-09-25_giniflow_sync_gates.sql`:

| Column on `giniflow_visits` | Type        | Meaning                                                               |
| --------------------------- | ----------- | --------------------------------------------------------------------- |
| `held_gate`                 | text        | first closed gate for the write the sync last attempted; NULL = clear |
| `held_since`                | timestamptz | when that gate first closed (written only on change)                  |
| `behind_station`            | (existing)  | kept, populated from the registry for back-compat with the panel      |

Written with the same "only when it changes" rule as `recordHealthrayObservation`, so the age is
"since when", not "last polled".

---

## 8. Work items

| #   | Work                                                                                                                   | Where                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| F1  | Registry (keys, groups, guards, labels, onRefuse, order)                                                               | `shared/syncGates.js`                                 |
| F2  | Predicates + `gateEnabled` + `firstClosedGate` + `recordGateObservation`                                               | `server/services/giniflow/syncGates.js`               |
| F3  | Migrate §3 rules; `appointmentSync.js` asks the registry instead of calling each rule                                  | `appointmentSync.js`, `observation.js`                |
| F4  | `held_gate` / `held_since` migration                                                                                   | `server/migrations/`                                  |
| F5  | Board, panel, schema and `check-held.mjs` read labels from the registry                                                | `board.js`, `FlowManagerPage.jsx`, `schemas/index.js` |
| F6  | `smoke:sync-gates` — for every registry entry: closed → held, open → written, switch off → written, absence never held | `server/scripts/smoke-sync-gates.mjs`                 |
| F7  | Plan 40's gates added as registry entries                                                                              | per plan 40                                           |
| F8+ | One work item per approved candidate in §5                                                                             | —                                                     |

F6 is generated from the registry: adding a gate without a fixture fails the smoke run.

---

## 9. Sequencing

1. **F1–F3 + F6, behaviour-neutral.** Existing `smoke:hybrid-floor`, `smoke-floor-journey.mjs`
   and `smoke-observation.mjs` must pass unchanged. Ship alone.
2. **F4 + F5** — the panel and cards read the registry; `held_gate` starts recording.
3. **Plan 40** on top (F7), in plan 40's own order.
4. **Candidates from §5**, one per release, each observation-only for a day
   (`onRefuse: "observe"`, a fourth mode that records `held_gate` but writes anyway) before its
   switch turns on.

Plan 40 can be built first without this framework if the floor needs it this week; the cost is
refactoring its gates into the registry afterwards (small — it is designed on the same split).

---

## 10. Decisions

- **G-a — build the registry before or after plan 40?** Recommended: plan 40 first (it is the
  urgent floor request), registry immediately after, since plan 40 already splits the switches.
- **G-b — which §5 candidates to take forward**, and in what order. Recommended start: C1
  (payment — the floor already asked for it in plan 39 §16) and C5 (Rx not in Scribe — the Rx
  desk otherwise opens an empty card).
- **G-c — the observe mode as a mandatory first step for every new gate.** Recommended yes: every
  hold so far (plan 39 §14) produced numbers nobody predicted on its first morning.
