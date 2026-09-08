# 34 — Lab billing as a step on the patient's journey

Asked for 2026-09-08: the journey needs a **lab billing** stop, so a patient who
is sent for tests is shown paying for them, and the floor can see who is stuck at
the counter.

## 1. What exists today

**The money is already modelled properly.** `giniflow_lab_orders` carries
`amount_total`, `amount_paid`, `amount_claimed` and a derived `payment_status`
(28-LAB-PAYMENT-SPLIT-PLAN.md). Reception works `getPaymentQueue` and settles
through `clearPayment`, and the lab's collection gate opens only on `paid` or
`claim_approved`. Nothing about that needs changing.

**The journey plan does not know any of it.** `giniflow_visit_steps` is seeded
from `flow_step_templates` per visit type (29-RECEPTION-JOURNEY-PLAN.md). Every
template already contains a `billing` step — but it sits **seventh of eight**,
between `rx_explain` and `pharmacy`. That is the medicines bill at the end of the
visit, not the tests bill at the start:

```
FU_APPT        vitals → mo_assessment → wait_sd → sd_consult → rx_ready
               → rx_explain → billing → pharmacy
FU_APPT_TESTS  vitals → mo_assessment → blood_sample → lab_delivered
               → lab_processing → lab_reports → report_printed → report_delivered
               → mo_review → rx_ready → wait_sd → sd_consult → rx_explain
               → billing → pharmacy
```

So a patient goes `blood_sample` with nothing in front of it, while in the
building they must pay before the lab will draw anything.

**How a step gets ticked.** A step with a `chain_status` is ticked by
`syncFromStatus`, inside the same transaction as the status change. A step
without one is `manual: true` and somebody presses the tick; `setStepStatus`
refuses a tick while an earlier step is unfinished. `is_background` steps with no
chain status are left out of the plan entirely — which is why `lab_processing`
and the `report_*` steps never appear.

## 2. The gaps

**G1 — no lab billing stop exists.** Neither in the catalog nor in any template.

**G2 — `billing` is ambiguous.** One row named "Billing" for what is now two
different counters in the same visit.

**G3 — tests ordered mid-visit never reach the plan.** `orderTests` in
`moStation.js` writes the order, the event and the status, and does not touch
`giniflow_visit_steps`. A patient checked in as `FU_APPT` who is then sent for
bloods keeps a journey with no lab stops at all — the exact patient whose journey
the floor most needs to see.

**G4 — nothing on the floor uses HealthRay-raised labs.** 264 of 264 lab cases in
the last 7 days were created in HealthRay, not through Gini Flow
(`scripts/report-lab-order-reconciliation.mjs`). Those have no order row and no
payment status here, so a derived step has nothing to derive from.

## 3. Decisions

### D1 — where the stop sits. **Immediately before `blood_sample`.**

The lab gate is the money, so the plan should show the money first. In the
test-bearing templates only (`FU_APPT_TESTS`, `NEW_APPT`, `NEW_WALK`), carrying
the same `condition_key = 'needs_tests'` the lab steps already carry, so a
journey without tests does not grow a billing stop nobody will work.

### D2 — reception and admin tick it; a settled order ticks it too. **Both, one way.**

Owner's call, 2026-09-09: the stop is **managed by Admin and Reception**. That is
also the only thing that can work today — every lab on the floor is raised in
HealthRay, where this side never sees the money (G4), so a purely derived step
would sit `pending` for ever.

Where the money IS here — a Gini order for today, settled — nobody should have to
record what the ledger already proves, so `syncLabBillingStep` ticks it. **One way
only:** it moves the step to `done`, never back. An unpaid order does not un-tick
what reception recorded, because the desk may have taken cash the order row does
not know about yet.

### D2b — who may tick it. **Reception or admin, not the coordinator.**

Every other step is editable by anyone holding `journeyEditGate`
(`GINIFLOW_STATION_RECEPTION` **or** `GINIFLOW_MANAGE_QUEUE`). This one records
money, so the route narrows it: the coordinator arranges the floor, they do not
work the counter.

Same "today only" rule as `GATING_ORDER_SQL`, so a fasting panel booked for the
next visit cannot park the patient at a counter they are not standing at.

### D3 — several orders. **All of today's, not the first.**

A patient billed for bloods and then sent for an X-Ray is not finished with the
counter. The step is done when nothing outstanding is left.

### D4 — tests ordered mid-visit. **`orderTests` grows the plan, in place.**

`addStep` appends at `MAX(step_order) + 1`, which would land the counter after
the pharmacy, so `insertLabStepsForOrder` puts the two stops **in front of the
first pending step** — where the patient is actually going next — and shifts the
rest down. Inside the caller's transaction, so an order that rolls back leaves no
stops behind. Only for `urgency = 'today'`, and never twice: a plan that already
carries the stop is left alone.

The visit's `planned_total_min` grows with them, so the estimate the patient was
given at check-in keeps up with the journey they are actually making.

### D5 — a HealthRay-registered lab. **Reception ticks it; nothing guesses.**

The patient paid at HealthRay's counter and this side never saw the money, so
there is nothing to derive from. An earlier draft had the step auto-`skipped`;
that was dropped, because "skipped" would say the counter did not happen when it
did. It stays `pending` until reception records it — which is the whole reason
D2 keeps a human tick.

### D5b — the existing `billing` step is untouched.

It stays "Billing" between `rx_explain` and `pharmacy`. Two counters, two stops,
neither renamed (owner's call, 2026-09-09).

### D6 — no new board column, no new station.

Payment-pending is already on the lab-track card ("💰 Payment pending at
reception") and in the Reception queue. A third place to look is how two of them
end up disagreeing.

## 4. The changes

### 4.1 Migration — `2026-09-09_lab_billing_step.sql`

The catalog row, then one `flow_step_templates` row per test-bearing type at
`blood_sample`'s position, with the rows after it shifted down one and
`condition_key = 'needs_tests'`. The existing `billing` row is not touched.

`flow_step_templates` has a **non-deferrable** `UNIQUE (visit_type_id,
step_order)` — unlike `giniflow_visit_steps`, whose own key was made deferrable
for exactly this. So `step_order + 1` collides with the row above it
mid-statement, and the shift runs in two passes: `+ 1001`, then `- 1000`.

### 4.2 `journey.js` — `syncLabBillingStep(client, visitId)`

One function, called where the money changes. Three plain UPDATEs against its own
table, the same shape and the same safety rule as `syncFromStatus`: a visit with
no plan matches no rows, and nothing it does can raise into the caller's
transaction.

### 4.3 Call sites

| where                           | when                                                 |
| ------------------------------- | ---------------------------------------------------- |
| `receptionStation.clearPayment` | after the settle commits                             |
| `moStation.orderTests`          | after the order is written (D4, then sync)           |
| `labStation` sample flow        | not needed — the gate is the payment, not the sample |

### 4.4 Client

Nothing new. The journey panel, the reception builder and `/visit/:token` all
render whatever steps the plan holds; a derived step arrives with `manual: false`
so no tick button is drawn for it.

## 5. Built, 2026-09-09

|                                   |                                        |
| --------------------------------- | -------------------------------------- |
| `2026-09-09_lab_billing_step.sql` | catalog row + 3 templates, applied     |
| `journey.syncLabBillingStep`      | one-way tick from settled today-orders |
| `receptionStation.clearPayment`   | calls it inside the settle transaction |
| `giniflowStations` PATCH step     | `lab_billing` needs reception or admin |
| `smoke:giniflow-journey`          | 12 new checks, all passing             |

The three test-bearing templates now read
`… mo_assessment → lab_billing → blood_sample → …`; `FU_APPT` and `FU_WALK` are
unchanged and still carry the medicines `billing` at the end.

## 6. Verification

Extend `smoke:giniflow-mo` and add to `smoke:giniflow-lab`:

- a `FU_APPT_TESTS` plan contains `lab_billing` immediately before `blood_sample`
- ordering today's tests on a plan without lab steps adds both, in order
- ordering for `next_visit` adds nothing
- an unsettled order puts the step `in_progress`; settling it makes it `done`
- a second unsettled order for the same visit puts it back to `in_progress`
- a visit whose only lab is a HealthRay case leaves the step `skipped`
- no plan on the visit → every call is a no-op, no error

## 7. Risks

- **The plan is not used on the floor yet.** No `giniflow_visit_steps` rows exist
  for today; plans are seeded lazily by `ensurePlan` when someone opens a
  journey. This work makes the journey correct for when the floor adopts it — it
  does not make the floor adopt it.
- **`planned_total_min` grows by 5 minutes** for test journeys, which moves the
  "done by ~" estimate in the check-in WhatsApp. Intended: the counter is real
  time the patient spends.
- **D5 is a judgement.** If the floor would rather see lab billing ticked when a
  HealthRay case appears, that is a one-line change — but it records a payment
  this system never witnessed.
