# Rx Explain station — the nurse desk Gini Flow lost

- Proposed: 5 Sep 2026
- Restores `flow_step_catalog.rx_explain` — "Prescription Explain", 5 min, Nursing Station, role
  `nurse`, `display_order` 16 (`server/migrations/2026-06-15_flow_management.sql`)
- Pairs with `25-PRINT-PRESCRIPTION-PLAN.md`, which grants this station the printout

## 1. Why this exists

The old flow module has a nurse desk between the consult and the pharmacy whose job is explaining
the prescription to the patient. Gini Flow dropped it. The nurse's capabilities show the loss
exactly:

| desk                     | old module            | Gini Flow                    |
| ------------------------ | --------------------- | ---------------------------- |
| vitals                   | `FLOW_STATION_VITALS` | `GINIFLOW_STATION_VITALS` ✅ |
| dietitian                | `FLOW_STATION_DIET`   | — (out of scope here)        |
| **prescription explain** | **`FLOW_STATION_RX`** | **— missing**                |

Today a nurse has `GINIFLOW_VIEW` (read the board) and the vitals station. The step where a patient
is told what their medicines are and how to take them has no screen at all.

This is not a new idea being invented — it is a station the hospital already staffs, restored into
the system that replaced the one it lived in.

## 2. Where it sits in the chain

`display_order` 16 in the old catalog: after the consult (7), before billing (17) and pharmacy (18).
In Gini Flow:

```
… with_doctor → doctor_done → [ rx_explain ] → pharmacy_pending → dispensed → exited
```

The position is forced by the data, not chosen: the prescription must **exist** (Finalize has run,
so `doctor_done` has been written) and the medicines must **not yet be collected** (the patient
still has to reach the counter). There is exactly one gap that satisfies both.

### 2.1 The status pair

Following the queue/station convention the chain already uses everywhere else (`sd_pending` /
`with_sd`, `vitals_pending` / `with_vitals`):

| status       | means                                                   |
| ------------ | ------------------------------------------------------- |
| `rx_pending` | consult finished, waiting for the nurse to call them in |
| `with_rx`    | at the desk, prescription being explained               |

`doctor_done` stays as it is — the transitional status Finalize writes — and `rx_pending` becomes
the queue that forms behind it.

## 3. Who gets access

| role            | station | why                                                                   |
| --------------- | :-----: | --------------------------------------------------------------------- |
| **nurse**       |   ✅    | whose desk this is; already holds `FLOW_STATION_RX` in the old module |
| **coordinator** |   ✅    | the floor's fixer; already holds reception + MO stations              |
| **admin**       |   ✅    | holds everything                                                      |
| consultant      |   ⚠️    | see §3.1                                                              |
| mo              |   ❌    | the workup happens before Finalize; nothing to explain yet            |
| pharmacy        |   ❌    | has its own counselling note at its own station (`16` §5.1)           |
| reception       |   ❌    | a clinical explanation, not a desk transaction                        |

New capability: `GINIFLOW_STATION_RX`, named to match the four that already exist
(`GINIFLOW_STATION_VITALS`, `_RECEPTION`, `_MO`, `_DOCTOR`, `_PHARMACY`).

### 3.1 The consultant question

On a thin day the consultant may explain the prescription themselves rather than send the patient to
a desk nobody is standing at. Two options:

- **(a) Grant it.** Consultant can work the station when the nurse is away.
- **(b) Don't, but allow the skip.** The consultant finalizes and the patient goes straight to
  pharmacy; `rx_pending` is passed through, not parked in.

Recommend **(b)**. Granting a station to a role that will use it twice a month adds a screen to their
menu they will never open, and the skip has to exist anyway for the days nobody staffs the desk
(§6.1).

## 4. What the station does

Nothing here is new work — every piece already exists for the pharmacy station and the consultant's
medicine card. This station is a different **audience** for the same data.

### 4.1 The queue (left)

Same shape as every other station queue:

| group           | holds                        | ordered by         |
| --------------- | ---------------------------- | ------------------ |
| At the desk     | `with_rx`                    | —                  |
| Waiting         | `rx_pending`                 | longest wait first |
| Explained today | `pharmacy_pending` and later | most recent first  |

Budget **5 minutes**, taken from the old catalog's `default_duration_min` for `rx_explain`. New
`giniflow_sla_config` row at `display_order` 7, pushing `pharmacy` → 8 and the rest down one.

### 4.2 The detail pane (right)

| block                             | source                                       | new? |
| --------------------------------- | -------------------------------------------- | ---- |
| Full medicine card                | `medicineCard.js` `buildCard(patientId)`     | no   |
| Counselling note, Hindi + English | `counsellingNote.js` — pure, template-driven | no   |
| **Print prescription**            | `25-PRINT-PRESCRIPTION-PLAN.md`              | no   |
| Diagnosis + plan summary          | the consultation Finalize wrote              | no   |
| **Explained ✓** button            | advances `with_rx` → `pharmacy_pending`      | yes  |

The **full** card, not the pharmacy's filtered view — external medicines are `Ext` and the pharmacy
cannot dispense them (`14` §123), but the nurse must still explain them. Same reasoning as
`25` §5.

`counsellingNote.js` is deliberately reused rather than re-written: it is a template composed from
each medicine's `change_type`, so _"the note cannot drift from what was actually prescribed."_ The
pharmacist and the nurse should read the patient the same words.

### 4.3 What it must NOT do

- **No editing the prescription.** Finalize is irreversible by design (`14` §303); a nurse changing
  a dose here would be an undocumented amendment. Corrections go through the consultant's addendum
  path (`24-ADDENDUM-V11-PLAN.md`).
- **No dispensing.** That is the pharmacy's `GINIFLOW_STATION_PHARMACY`, and the split is the point:
  one desk explains, another hands over.

## 5. Blast radius

`CHAIN` is _"the ONLY definition of the journey"_, so inserting a status is not a local change.

| file                                                      | change                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/giniflowStatus.js`                                | `CHAIN`, `STATUS_LABEL`, `STATUS_TO_SLA_KEY`, `WAIT_STATUSES`, `BOARD_COLUMNS` (9th column), `COLUMN_ENTRY_STATUS`, `ORDERED_COLUMNS` |
| migration                                                 | `giniflow_sla_config` row `rx_explain` 5 min; renumber `display_order` 7–10                                                           |
| `finalize.js`                                             | advances `doctor_done → pharmacy_pending` today; must stop at `rx_pending`                                                            |
| `pharmacyStation.js`                                      | `QUEUE_STATUSES = ["doctor_done", "pharmacy_pending"]` — `doctor_done` no longer belongs to pharmacy                                  |
| `doctorStation.js`                                        | `DONE_STATUSES`, and the `pharmacy` hand-over group keyed on `doctor_done`                                                            |
| `appointmentSync.js`                                      | `PHARMACY_LEG = ["doctor_done", "pharmacy_pending", "dispensed"]`                                                                     |
| `board.js`                                                | the new column's cards and its average                                                                                                |
| `shared/permissions.js` + `auth.js` + routes + a new page | the capability, both sides                                                                                                            |

### 5.1 `MAX_FORWARD_JUMP`

`canTransition` allows a forward jump of at most 2. Inserting a status widens two existing gaps:

- `doctor_done → pharmacy_pending` was 1, becomes 2 — still legal, but now at the limit
- the HealthRay sync's `completed → exited` inference and `sweepPharmacyLeg` both cross this region
  with `allowSkip: true`, so they are unaffected — **but that must be verified, not assumed**

Check every `advanceStatus` call that lands in or crosses `doctor_done … pharmacy_pending` before
merging.

## 6. The adoption risk, stated plainly

The floor recorded **1 dispense in 5 days** (`25` §2). Adding a ninth station is another screen
needing a person. Two consequences:

### 6.1 The skip must be free

If nobody staffs the desk, patients must not pile up in `rx_pending` the way they piled up at
`vitals_done` when the SD screen went unworked. Either:

- the pharmacy queue accepts `rx_pending` as well as `pharmacy_pending`, so an unstaffed desk is
  invisible rather than blocking; **or**
- a sweep like `sweepPharmacyLeg` advances `rx_pending` past its budget automatically.

Prefer the first: it degrades to today's behaviour exactly.

### 6.2 Ship it dark

Add the status and the capability, grant it to nobody but admin, confirm the board still balances
for a day, then grant `nurse`. A chain change that turns out wrong is expensive to reverse —
`giniflow_visit_events` is append-only.

## 7. Open questions

1. **Is the nurse desk actually staffed?** It exists in the old catalog, which is evidence it was
   designed for, not that someone stands there. Worth confirming on the floor before building —
   this whole plan is moot if the answer is no.
2. **Does "Explained ✓" need a signature?** The pharmacy records who dispensed. If "who explained
   this to the patient" is ever asked, `actor_id` on the event answers it for free — but only if we
   decide now that the question matters.
3. **Dietitian too?** The old catalog also has `dietitian` (order 15, `FLOW_STATION_DIET`), lost the
   same way. Out of scope here; noted so it is not lost twice.
4. **Billing.** Order 17 in the old catalog, between this desk and pharmacy. Gini Flow has
   `reception_payment` for lab tests only. Whether consultation billing belongs on the chain is a
   separate decision.
