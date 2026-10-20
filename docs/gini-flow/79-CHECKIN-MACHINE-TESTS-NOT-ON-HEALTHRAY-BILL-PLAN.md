# 79 — Check-in machine tests paid on the Scribe bill but never billed in HealthRay

Status: **plan, waiting for review (20 Oct 2026)**. Nothing built.

## 1. The case

Sunita Handa (P_182248), new patient of Dr. Anil Bhansali, 20 Oct 2026.

| When (IST) | What happened                                                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10:19:47   | Reception 2 checks her in as **NEW_APPT**. The template has `abi`, `vpt`, `fundus` with `is_default = true`; `raiseOrdersFromSteps` (`journey.js`) raises three machine orders, each adds a `lab_order` line to the Scribe draft |
| 10:20:00   | Reception 2 finalises **GH26-000312**: ABI ₹500, VPT ₹300, Fundus ₹500, consult ₹1,500, ₹500 discount spread over the tests → **₹2,300 cash** (RC26-000452). The payment settles the three orders (`paid`)                       |
| 10:21:55   | Bill sync reads the HealthRay bill **OPD/2627-17082: "New Appointment" ₹1,500 only**. `reconcileTestSteps` skips `blood_sample` and `lab_processing_2` but **keeps the three paid machine orders and their steps**               |

Reception confirms only ₹1,500 was collected. Scribe shows ₹800 of tests that HealthRay never
billed and the patient never paid for. The ABI, VPT and Fundus cards are still waiting at the
machines.

## 2. Why the reconcile kept them

`reconcileTestSteps` (`server/services/giniflow/patientBill.js`) removes a check-in order that is
not on the HealthRay bill only if it is:

- `unpaid`: nothing taken, or
- `paidBeforeBill`: paid on the **Payments tab** with `meta.notOnBill = true` (G67).

These three were paid through the **Scribe counter bill**: their payment events carry
`meta.bill_id`, not `notOnBill`. So they count as real paid orders, are kept, and keep their
steps (`kept`).

## 3. The change

Add a third removable case, **paid on the Scribe bill**, under the same conditions as
`paidBeforeBill`:

- `kind = 'machine'`
- `from_checkin` (created with the check-in steps; doctor, MO and bill-sync orders are never
  touched, as 51 §89 requires)
- not started (`started` false), no output, `claim_state = 'none'`
- `payment_status = 'paid'` and the paid event has `meta.bill_id`
- no HealthRay line for that machine, dead lines included (`billed` already uses
  `includeDead: true`)

It goes through the existing `cancelTestIn(..., source: 'healthray', reason: NOT_ON_BILL_REASON)`.
For a line on a final Scribe bill, that already calls `refundFinalLines` and puts a refund
request for the line on the **Refunds board**. An admin approves it and chooses the mode. No
money moves on its own, and the bill is never edited or cancelled (70 §2 still holds).

Code: one predicate in `reconcileTestSteps` plus one column in its order query
(`settled_on_scribe_bill`: a paid event whose meta has `bill_id`). `SCRIBE_BILL_AUTO_CANCEL=dry`
shows what it would cancel before it is turned on.

### Risk: HealthRay billed in two invoices

The desk sometimes bills the consult first and the tests later on a second HealthRay invoice.
With only the first invoice read, the new rule would cancel a test the patient is about to pay
for in HealthRay. Guard:

- act only once the HealthRay bill was **read at least `SCRIBE_PAID_NOT_ON_BILL_GRACE_MIN` (default 30) minutes after the Scribe payment**, and
- never once the machine has started.

If HealthRay bills the test later, `machineSync` raises it again from the bill line.

## 4. Fixing GH26-000312 (this patient)

Two ways. Both end with the same records:

1. **Now, in the app (recommended, the floor won't wait for a deploy):** reception cancels ABI,
   VPT and Fundus at their machine stations, reason **Not on bill**. Each cancel raises a refund
   request on GH26-000312. An admin approves the three (₹307.69 + ₹184.62 + ₹307.69 = **₹800**).
2. **After §3 ships:** the next bill sync for her visit does the same as system.

Refund mode: the ₹800 was never collected, so no cash should leave the drawer. Per 70 §4
("no delete receipt"), approve it as **kept as deposit**, then write the deposit off at the
shift close with the note "RC26-000452 overstated ₹800; HealthRay OPD/2627-17082 ₹1,500". Her
shift `bd8707d5…` has been open since 1 Oct.

I write nothing to production for this; it is the desk's and the admin's maker–checker action.

## 5. Tests (`e2e/giniflow/G67-paid-before-bill-not-on-bill.spec.js`)

1. Check-in machine order paid on a final Scribe bill, HealthRay bill has only the consult,
   grace passed → order and step cancelled, one refund request for the line on the Refunds
   board, Scribe bill unchanged.
2. Same, inside the grace window → left alone.
3. Same, machine started → left alone.
4. Same, HealthRay bill has the machine → left alone.
5. Doctor- or MO-ordered machine test paid on the Scribe bill → left alone.
6. `SCRIBE_BILL_AUTO_CANCEL=dry` → reported in `wouldCancel`, nothing written.

## 6. Not in scope

- Changing the NEW_APPT template defaults (`is_default` on `abi`/`vpt`/`fundus`). That is a
  floor decision under Settings → Flow, not code.
- Holding check-in machine lines off the Scribe draft until HealthRay bills them. That is
  bigger and changes the arrival bill (72, 73).
