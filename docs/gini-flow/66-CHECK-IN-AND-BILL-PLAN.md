# 66 — Check in and bill in one step

Status: built (2026-10-12). Tests: `e2e/billing/phase4/P4C-43-check-in-and-bill.spec.js`.

## Why

Today reception does arrival and money in separate places:

1. Arrivals → **✓ Arrived** → `CheckInPanel` → **✓ Check in** (`checkInWithJourney`, `journey.js:576`).
2. Then, if they bill, **Open bill →** → Bill tab → add/collect → finalise.
3. Test money is cleared again on the **Payments** tab (`clearPayment`, `receptionStation.js:439`).

The client wants one action at the desk: the patient arrives, reception sees what is owed (the
consultation fee and any tests ordered earlier) and either collects it or marks it as already paid,
in the same step. Tests the doctor orders later must show up on their own for billing.

## What exists today (read from code)

| Area                         | Today                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Check-in                     | `POST /giniflow/stations/reception/:visitId/checkin` → `checkInWithJourney` (one transaction: status, journey steps, orders from steps, bill charges, token, doctor) → after commit `draftAtCheckIn` (`journey.js:746`). |
| Consultation on the draft    | `draftAtCheckIn` / `consultationForDesk` add it only when `auto_add_consultation` is on **and** HealthRay already billed a consultation (`healthrayBilledConsultation`, `visitLines.js:247`). Plan 63 kept this gate.    |
| Test lines                   | Every order (`orderTests`, `moStation.js:716`; machine; journey) calls `linesForOrder` (`visitLines.js:386`) and lands on the open draft.                                                                                |
| Order raised after a final   | `openDraftIn` (`bills.js:596`) opens a second draft (unique index is drafts-only). `counterPatients` `tests_owed` / open draft put the patient back in **To bill**. D12: several bills per visit, never one item twice.  |
| "Pending bill"               | There is no separate tab. **To bill** is the first group in the Bill tab's patient list (`counterPatients.js:175`, `PatientList.jsx`).                                                                                   |
| Already-paid money           | Mode `healthray` ("Paid in HealthRay", `clearInHealthray`, not in the drawer) and `deposit`. Reception's Payments tab clears orders with no bill at all.                                                                 |
| Tests ordered for next visit | `TEST_URGENCY` = today / tomorrow / next_visit. **No reader carries an order to a later visit** — every screen filters on the order's own `visit_id` and `urgency='today'`. Next-visit tests are never seen again.       |
| Inconsistency                | `linesForOrder`, `tests_owed` and `testsToPrefill` ignore urgency, so a _next visit_ test is put on **today's** draft and counted as "N tests ordered", while the Payments tab hides it.                                 |
| Lab gate                     | `opensLabGate` = paid / claim approved. Paying a bill line settles its order (`settleTestOrders`, `payments.js:428`) and opens the gate. Settled rule — unchanged by this plan.                                          |

## Proposed flow

```text
Arrivals row
  [✓ Arrived]  → Check-in panel (as today: visit type, journey, consultant)
                 ── Bill at arrival ───────────────────────────────
                 Consultation — Dr Anil Bhansali        ₹1,000   (•) Collect now ( ) Already paid
                 HbA1c        — ordered 14 Sep (next visit) ₹350   (•) Collect now ( ) Already paid
                 Lipid panel  — ordered 14 Sep (next visit) ₹600   ( ) Collect now (•) Already paid
                 Not today: [ ] (untick a test to leave it for later)
                 ───────────────────────────────────────────────────
                 To collect now                    ₹1,350
                 Mode  (Cash) (Card) (UPI)   Ref [______]
                 Already paid: ₹600 · where: (HealthRay) (Earlier / online)

  [✓ Check in & collect ₹1,350]      [Check in only]
```

One press does, in order:

1. **Check in** exactly as today (`checkInWithJourney`). It also raises the orders the journey steps
   ask for (`raiseOrdersFromSteps`, `journey.js:444`), so those tests are part of the arrival bill.
2. **Carry over earlier tests** (C4): undone `next_visit` / `tomorrow` orders from the patient's last
   visit that reception left ticked are moved onto today's visit (`visit_id` = today,
   `urgency = 'today'`, order event `carried_over` naming the old visit). Unticked ones stay where
   they are and are offered again next time.
3. **Draft**: the arrival bill is built on the visit's draft — consultation line (C1), the
   journey-raised tests and the carried tests — through the existing `openDraftIn` /
   `linesForOrder` path, so category rates, agreed rates and package rules apply as at the counter.
   `draftAtCheckIn` still runs at check-in; the arrival bill adds the consultation only when the
   visit has none yet, so it is never billed twice.
4. **Amount check**: the server totals the draft and compares it with the amount the desk saw. If
   they differ (a price changed, a journey test was added) nothing is billed or paid: the visit
   stays checked in, the panel shows the new total and a **Collect ₹X** button to confirm. Money is never taken for an
   amount reception did not see.
5. **Payments** on that draft:
   - _Collect now_ lines → one payment in the chosen mode (cash needs the desk's open shift, as at
     the counter; the panel says so before the button is pressed).
   - _Already paid_ lines → one payment in mode `healthray` or `prepaid` (C2), never in the drawer.
   - Paying settles the linked test orders through `settleTestOrders`, so the lab gate opens exactly
     as a counter payment does today. No new gate logic.
6. The draft is fully paid, so it is **finalised** (D11 pay-later stays off). If finalising is refused
   (for example a category still to choose) the paid draft is kept, counts as billed, and the reason
   is shown.

Checking in commits first (`POST .../checkin`, unchanged); billing runs right after through
`POST /giniflow/stations/reception/:visitId/arrival-bill` in its own transaction. A billing failure never
undoes the check-in — the patient is on the floor and the bill waits in Pending bill with the reason
shown on the panel.

"Check in only — bill later" keeps today's behaviour for the desk that bills later. A walk-in has no
visit until check-in, so its bill section appears right after check-in with a **Collect ₹X** button.

The preview (`GET .../arrival-bill?skip=…`) builds the real draft inside a transaction and rolls it
back, so its prices are exactly what the commit charges. Both the preview and the commit lock the
visit row first; without that, the preview refetched after check-in deadlocked the commit (found
by the screen test).

The bill section only shows for `BILLING_DESK`; a coordinator with only
`GINIFLOW_STATION_RECEPTION` still sees today's panel. Online (tele) visits get the consultation
line only — no tests are carried onto a visit that never reaches the floor.

## Earlier tests: what is already on an old bill

Because `linesForOrder` ignores urgency today, many next-visit tests are **already on the old
visit's bill**. Carry-over must look at that line first:

| The order's line on the old visit                     | At arrival                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| On a paid line (final or paid draft)                  | Shown as **Paid on bill BL-… (date)**, no amount, carried over already settled — lab gate open. |
| On an unpaid draft line                               | The line is removed from the old draft (reason "Carried to visit of <date>") and billed today.  |
| On a final bill with money still due                  | Not carried; shown as "Due on bill BL-…" so the desk settles it on Dues, never billed twice.    |
| Not on any bill                                       | Billed today.                                                                                   |
| Cleared on the Payments tab (`paid` / claim approved) | Shown as already paid; carried over settled.                                                    |

## Tests ordered later → Pending bill

Already mostly true; this plan closes the gaps:

1. **Only `today` orders go on today's bill.** `linesForOrder`, `tests_owed` and `testsToPrefill`
   filter `urgency = 'today'`; next-visit and tomorrow orders wait for their visit instead of
   inflating today's bill.
2. A doctor/MO/machine order raised after the arrival bill was finalised opens a **new draft**
   (existing D12 behaviour) and the patient moves back to **Pending bill** with "N tests ordered".
3. **Visible prompt**: the Bill tab badge counts patients with new unbilled tests (today it counts
   only consultant changes), so reception notices without searching.
4. The **To bill** group is renamed **Pending bill** (C3); only the label changes, the API group key
   `toBill` stays.

## Consultation fee at arrival

The consultation line today is added only after HealthRay bills it (plan 63 gate). Billing at
arrival needs the fee **before** HealthRay: the line is priced from the visit's consultant and visit
type through the normal `consultationForDesk` pricing, with the HealthRay gate skipped for the
arrival bill only (C1). Hospital Admin / samples-only visits get no consultation line (plan 63).

- If HealthRay later bills its own consultation, the counter's HealthRay prefill
  (`healthrayLinesForDesk`) must not add a second consultation line to the visit: a visit that
  already has a live consultation line takes none from HealthRay.
- If the consultant is changed later, plan 62 (`consultantChangedIn`) already raises the
  difference to collect or refund.
- Discounts are not taken in the panel. A patient who needs one is checked in with **Check in only**
  and billed at the counter, where discounts already work (plan 63: discounts are given in Scribe).

## Safety and audit

- The panel shows patient name, Health ID and visit before the button, and the button carries the
  amount ("Check in & collect ₹1,350").
- Double-press safe: check-in on a visit already checked in plans nothing new (`alreadyHere` in
  `checkInWithJourney`); the bill step takes the visit's draft under a row lock and pays only what is
  still due on it, so a second press finds nothing left to collect.
- Every carry-over, removed line and payment is written to `billing_audit` / order events as today.
- Money taken at arrival is reversed only through the existing cancel bill / refund flow. A
  checked-in patient cannot be "un-arrived" today (`undoArrival` only reverses no-show and cancel),
  so no new rule is needed there.
- The Payments tab keeps clearing tests ordered after check-in; a test paid on the arrival bill shows
  there as cleared (it is settled through `settleTestOrders`, which the tab already reads).

## Tasks (each tested before the next)

1. **Urgency fix**: `linesForOrder`, `tests_owed`, `testsToPrefill` take only `today` orders.
   Tests: a next-visit order is not on today's draft nor counted in Pending bill.
2. **`prepaid` payment mode** (C2): migration widening `payments_mode_check`, no reference and no
   shift (as `healthray`); `shared/billingVocab.js`, schema, receipt, shift panel and reports list it
   as "Paid earlier / online". Tests: recorded, not in the drawer, shown apart from HealthRay.
3. **Carry-over service** (`server/services/giniflow/carryOver.js`): list the last visit's undone
   orders with their old-bill state (table above); move chosen ones. Tests: each row of the table,
   moved once, events written, another patient's order refused.
4. **Arrival bill service** (`server/services/billing/arrivalBill.js`): preview
   (`GET /giniflow/stations/reception/:visitId/arrival-bill`) and commit after check-in
   (`POST` on the same path, gated by reception + `BILLING_DESK`). Tests: collect, already paid
   (both sources), mixed, untick leaves Pending bill, amount changed → nothing paid, cash without a
   shift refused, lab gate opens for paid tests, no second consultation from HealthRay.
5. **Check-in panel UI**: bill section, per-line Collect / Already paid, source, mode, reference,
   amount on the button, "Check in only". Screen test.
6. **Later orders**: Bill tab badge for new unbilled tests + "Pending bill" label. Test: doctor
   orders after a finalised arrival bill → new draft, patient in Pending bill, badge counts it.

## Decisions (2026-10-12)

| #   | Decision                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | The consultation fee is billed at arrival from the visit's consultant; the HealthRay gate is skipped for the arrival bill only.                                                          |
| C2  | "Already paid" has two sources: **Paid in HealthRay** (existing `healthray` mode) and **Paid earlier / online** (new mode `prepaid`). Neither is in the drawer; reports show them apart. |
| C3  | **To bill** is renamed **Pending bill**; the Bill tab badge also counts patients with new unbilled tests.                                                                                |
| C4  | Earlier tests offered at arrival: undone `next_visit` / `tomorrow` orders from the patient's **last** visit only.                                                                        |
