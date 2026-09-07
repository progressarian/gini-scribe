# 28 — Lab payment split: part cash, part insurance

Built 2026-09-07. Supersedes the open question in `07-LAB-STATION-PLAN.md` §5b.3
("is `insurance_claim` approved, or does the payment track need a submitted →
approved pair?"). The answer is the pair, plus the money behind it.

## Why

A lab order was all-or-nothing: one `amount_total`, one `payment_status`, and
the desk either took the whole amount in cash or claimed the whole amount from an
insurer. Real OPD policies have co-pay, deductibles and exclusions, so the
ordinary case at the counter is "insurer covers ₹900, patient pays ₹350 now".
Reception could not record that. Their only options were to claim the full
₹1,250 — the hospital's ₹350 never recorded and never collected — or to take
₹1,250 in cash and owe the patient a refund nobody tracked.

## The model

The money is the truth. `payment_status` is derived from it and kept in the
column, so every existing screen and SQL filter reads exactly what it read
before, and only `shared/labPayment.js` knows the derivation.

```
settled = amount_paid + (claim_state = 'approved' ? amount_claimed : 0)
settled >= amount_total   → claim_state = 'approved' ? claim_approved : paid
claim_state = 'submitted' → insurance_claim
amount_paid > 0           → part_paid
otherwise                 → pending
```

Two figures the desk needs, and they are not the same number:

- **outstanding** = total − settled — what the order still owes.
- **collectible** = total − cash − any _live_ claim — what can still be taken at
  the counter. With a ₹900 claim standing, ₹900 is outstanding but ₹0 is
  collectible: that money is with the insurer, and taking it in cash as well
  would collect the order twice. The `CHECK` on the table enforces exactly this.

**The gate is unchanged in meaning:** the lab collects only on `paid` or
`claim_approved`. A submitted claim is a promise, not money. A part-paid order
with a pending claim stays blocked (decided explicitly — the alternative, letting
the lab proceed on the patient's share, was rejected).

## Actions

| method            | what it means                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paid`            | cash; amount defaults to the whole collectible balance, so the common case stays one tap                                                                                                                                                                   |
| `insurance_claim` | claim submitted — insurer required, amount defaults to the balance                                                                                                                                                                                         |
| `split`           | cash **and** claim in one transaction, two ledger events                                                                                                                                                                                                   |
| `claim_approved`  | the insurer said yes; opens the gate; **maker-checker** — the submitter cannot approve their own claim                                                                                                                                                     |
| `claim_rejected`  | the insurer said no; the claimed money returns to outstanding, the order returns to reception's list, and the gate closes again if the sample is still uncollected. Allowed from `submitted` **or** `approved`, because an insurer can reverse an approval |

Every action writes its own `giniflow_lab_order_events` row with the caller's
real role, so the ledger reads as a sequence rather than as whatever the status
column says today.

## Two guards worth keeping

**Optimistic lock (`version`).** Once amounts are real, a status check cannot
catch a double-tap: two taps of "collect ₹350" on a ₹1,250 order are both legal
and the patient pays ₹700. Every write carries the version the card was rendered
from; a stale one is refused with 409 and changes nothing. The HTTP schema
_requires_ it for `paid` / `split` / `insurance_claim` — an optional lock is no
lock, because a retried request or a stale browser tab simply omits it.

**Self-healing drift.** If the money and the status column disagree — an order
written by an older build, or by hand — a settling action reconciles the column
to what the money says instead of dead-ending on "already settled". Without this
an unpriced order (`amount_total = 0`) sits in the payment queue forever while
the lab refuses it. An order carrying its price only on its test lines has
`amount_total` repaired once, in the same transaction, because the `CHECK`
measures against the column.

## Files

- `shared/labPayment.js` — the vocabulary: statuses, claim states, `opensLabGate`,
  the paise maths, `derivePaymentStatus`. Imported by both sides;
  `labStation.js` now takes `opensLabGate` from here rather than from the
  reception service.
- `server/migrations/2026-09-07_giniflow_payment_split.sql` — the columns, the
  backfill, the drift reconcile, the two `CHECK`s.
- `server/services/giniflow/receptionStation.js` — `clearPayment`, the queue.
- `server/services/giniflow/stationSummary.js` — the launcher tile counted a
  submitted claim as cleared; now both counters use gate semantics.
- `server/services/giniflow/labStation.js` — the blocked reason carries the
  amount outstanding.
- `server/services/giniflow/demo.js` — seeded orders now carry money matching
  their status, or the demo day renders paid orders as unpaid.
- `src/pages/giniflow/ReceptionStationPage.jsx`, `useGiniflowReception.js`,
  `giniflow-station.css` — the card, the split/claim/rejection forms.

## Deploying

⚠️ **Re-run the migration immediately before the build goes out.** Every
statement in it only touches rows that actually disagree, so it is safe to
repeat. This matters because the older build writes `payment_status` without the
money columns: any payment taken on the live floor between the migration and the
deploy would otherwise come back as unpaid once status is derived. This was not
hypothetical — it happened to a real order during testing on 2026-09-07 and the
reconcile statements exist because of it.

```
node migrations/_runOne.mjs migrations/2026-09-07_giniflow_payment_split.sql
```

## Review

`/code-review high` over the diff, 2026-09-07. Seven findings, all fixed:

1. The cash button was disabled when nothing was collectible, which made the
   reconcile path unreachable and could strand an unpriced order forever. It now
   stays live and reads "Nothing to collect — notify lab".
2. `total` fell back to the sum of the test lines while the money maths read the
   raw column — a card could show "Total ₹450" beside "✓ Settled". One helper
   now feeds both, and the column is repaired on write.
3. The `version` lock was optional in the schema, so the double-charge it exists
   to prevent was still reachable from a retried POST. Now required for the
   money-moving methods.
4. The reconcile write opened the lab gate without the `sample` event the normal
   path writes, leaving a task with no origin in the ledger. Added.
5. The toast said "nothing changed" on a reconcile that had just handed the order
   to the lab. It now says the lab was notified.
6. The gate-closing branch was unreachable, because rejection required a
   `submitted` claim and an open gate implies an approved one. Rejection now
   accepts an approved claim too — which is the real case it was written for, and
   is covered by a test.
7. `money()` duplicated `moneyOf()` in the same file. Removed.

Verified sound by the same pass: the paise maths and the `CHECK` invariant hold
on every reachable path, maker-checker still applies after a split, and no
importer of the removed `SETTLED_METHODS` export remains.

**Tests:** `smoke:giniflow-reception` (99 checks) covers the split, the
collectible rule, the lock, approval, rejection, reversal after approval, and a
reversal after the sample was taken. `lab` (30), `mo` (70) and `promote` (17)
pass unchanged.
