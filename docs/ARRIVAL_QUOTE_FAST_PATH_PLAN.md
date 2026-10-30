# Arrival bill: fast quote for visits that already have something

Status: plan, 2026-10-30. Not built.

## 1. Where things stand

Clicking **✓ Arrived** opens the check-in panel, which asks the server for the
"Bill at arrival" (`POST /giniflow/stations/reception/:visitId/arrival-bill/preview`,
and `GET …/arrival-bill` once the patient is in). It is asked again on every change
to the visit type, the steps, or a desk add/remove, and the check-in buttons stay
locked until it answers.

The server answers in one of two ways (`arrivalBillPreview` in
`server/services/billing/arrivalBill.js`):

| Path | What it does | Queries (test DB) | Writes / locks |
|---|---|---|---|
| **Quote** (`arrivalQuote.js`) | Reads the visit, the journey and the stored HealthRay bill, prices an unsaved line list with Scribe's pricing | ~30 | none |
| **Rehearsal** (`rehearseArrivalBill`) | Inside a transaction: checks the patient in, carries orders over, adds the consultation, the test lines and the HealthRay lines to a draft, reprices after each line, writes audit rows — then rolls everything back | ~187 for one lab-only visit, more with more lines | row lock on the visit for the whole run |

From a laptop each query to the production database costs ~0.25 s, so the
rehearsal took ~48 s for Avtar Singh (P_38060). On the live server it is a few
seconds, still the heaviest call on the reception screen.

The change made on 2026-10-30 (uncommitted) lets the quote handle the stored
HealthRay bill, so a visit with a HealthRay bill no longer forces the rehearsal.

The quote still refuses — and the rehearsal runs — whenever the visit is not a
clean slate (`cleanSlate` in `arrivalQuote.js`). That is the subject of this plan.

## 2. When the quote refuses today

| # | Reason | Where it comes from |
|---|---|---|
| R1 | Visit already arrived (`GET …/arrival-bill`, "Check in only — bill later" reopened) | status not booked / no-show / cancelled |
| R2 | Visit already has lab orders | floor orders, **machine orders raised by the HealthRay bill scan** (`machineSync.ordersFromBill`) before the patient reaches the desk |
| R3 | Visit already has journey steps | lab steps seeded by the bill scan, an earlier plan |
| R4 | A HealthRay lab case exists for the day | home collection / lab-only patients whose sample is already in HealthRay's lab |
| R5 | A bill (draft or final) exists for the visit | draft opened by the background HealthRay/lab-case line sync, or by the desk |
| R6 | Orders waiting from an earlier visit (carry-over) | `carryOverChoices` |
| R7 | Inside the quote: consultation removed by the desk, an inactive item, a desk-added consultation, a non-test line with no price | `arrivalQuote` returns `null` |

R2–R5 are likely to be common for exactly the patients who are slow (tests on
the HealthRay bill), because the background bill scan and lab-case sync create
orders, steps and drafts before reception clicks Arrived. If so, the 2026-10-30
change helps fewer patients than it looks. **Step 0 measures this before
anything is built.**

## 3. Step 0 — measure (no behaviour change)

1. Log one line per preview on the API: path (`quote` / `rehearsal`), the refusal
   reason (R1–R7), duration in ms, query count. No patient data beyond the visit id.
2. Leave it on the live server for one working day, then count by reason.
3. Optional, with your OK: one read-only production query for today's arrivals
   (`BEGIN READ ONLY`) — how many visits had orders / steps / lab case / draft /
   carry-over at the moment they were checked in.

The counts decide which of the cases below are built and in what order.

## 4. Design — quote from the visit's current state

Today the quote starts from an empty bill. The fast path instead starts from what
the visit already has and adds only what the rehearsal would add, all read-only:

| Rehearsal step (`buildIn`) | Quote equivalent (read-only) |
|---|---|
| Existing draft | Read its live lines as stored: item, quantity, doctor, `agreed_rate`, manual discounts, the bill's category and discount codes |
| `carryOverIn` (orders the desk ticked) | For each ticked order not already paid: its test items (same matching as `linesForOrder`) |
| `checkInIn` journey (booked visits) | Journey tests minus tests already on an order for this visit |
| `arrivalConsultationIn` | `consultationItem` + the existing "consultation already on the visit / settled" checks |
| `testsForDesk` | Its `testsToPrefill` query is already read-only — reuse it as is |
| `healthrayLinesAtArrivalIn` | `healthrayQuoteLines` (built 2026-10-30), excluding items already in the list |
| Lab-case lines | Read-only version of the lab-case "due" query in `labCaseLines.js` |
| `applyDeskChanges` | Same remove/add on the list |
| Reprice + `moneyOn` | Price the whole list with the draft's own category, codes and manual discounts (a `priceDraftWith(billId, extraLines)` beside `priceUnsavedDraft`), then subtract payments already on the draft |

Anything the quote can't reproduce returns `null` and the rehearsal runs, as today.
Kept on the rehearsal on purpose:
- a **final** bill on the visit plus new items (new draft beside a final bill),
- orders with their own insurance claim at reception (`CLAIM_AT_RECEPTION`),
- anything Step 0 shows to be rare.

### Build order (adjusted after Step 0)

1. **A — orders and steps, no bill yet** (R2, R3). Expected to be the biggest group.
2. **B — lab case** (R4), usually together with a draft of lab-case lines.
3. **C — existing draft** (R5): read lines, codes and manual discounts; price together.
4. **D — carry-over** (R6).
5. **E — already arrived** (R1, `GET` route): same code as C once C exists.

Each lands on its own, with its tests, and can ship separately.

## 5. Safety

- **Same answer as the rehearsal.** Every case gets a P4C-51-style test that builds
  the state, runs the quote and the rehearsal, and requires identical lines,
  amounts, "from HealthRay" flags, unmatched lines, journey note and outstanding.
  The query budget is asserted (< 40).
- **Shadow week on live (recommended).** Before a case is switched on, run the
  quote beside the rehearsal on live, keep returning the rehearsal, and log any
  difference (visit id + which field differed). Switch the case on only after a
  clean week. The quote is read-only, so the extra load is small.
- **Check-in itself is unchanged.** `commitArrivalBill` still builds the real bill
  and refuses with "The amount changed" if the preview was wrong, so a wrong
  preview can never charge a wrong amount — at worst reception sees the refusal
  and the panel re-asks.
- Nothing is precomputed at sync time: the bill depends on the visit type, steps,
  desk changes and category chosen in the panel.

## 6. Tests

- `e2e/billing/phase4/P4C-51-fast-arrival-quote.spec.js` — one test per case A–E,
  each compared with the rehearsal, plus "the quote writes nothing" for each.
- Re-run P4C-43, P4C-50, P4C-25, G124 (check-in and HealthRay lines).
- A UI check that the buttons unlock without waiting on a rehearsal for a visit
  with pre-raised machine orders.

## 7. Open questions

1. Run Step 0 logging on live for a day? Run the one read-only production query?
2. Shadow week before switching each case on, or switch on after tests pass?
3. Is a final bill plus new items at arrival common enough to cover (it stays on
   the rehearsal in this plan)?
