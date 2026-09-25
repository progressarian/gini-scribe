# Billing — refunds and credit notes (Phase 4b) — plan

Decided 2026-09-25, answering plan Q14 (`52-BILLING-PLAN.md`). Phase 4b was on
hold until these three were settled; this plan replaces P4B-01's "on hold".

## Decisions

| #   | Decision                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Money goes back the way it came.** A refund defaults to the mode of the payment it reverses (card → card, UPI → UPI, cash → cash). An admin may choose another mode, with a written reason (e.g. a card refund can't be reversed, so the patient takes cash). |
| R2  | **The desk asks, an admin approves.** Reception raises a refund request with a reason; a reception_admin or admin approves or rejects it before any money leaves — the same pattern as "Ask admin to bill again".                                               |
| R3  | **A credit note covers the whole bill or chosen lines** (and part of a line's quantity). The original bill keeps its number and stays final; the credit note is its own document with its own `CN` number.                                                      |

Unchanged: **bills are never deleted** (D6). **Cancel stays for unpaid bills
only** — a paid bill is reversed with a credit note, not cancelled.

## What a credit note is

A `bills` row with `bill_type = 'credit_note'` and `original_bill_id` → the
invoice it credits (both columns already exist). It is **final on creation**,
takes the next number from the `CN` series (a new `bill_series` row per
financial year), and has lines that each point at the original line they
credit, with the quantity credited.

- **Amounts are positive** and mean "credited back". The same totals check
  holds: `actual − discount + tax + round_off = payable + claim + adjustment`.
- **Each line is credited in proportion** to the original line — its discount,
  tax, patient part and claim part — so a credit note never gives back more of
  any part than the original charged.
- **A line can't be credited past what is left:** the credited quantity across
  all credit notes on a line is at most the line's quantity.
- **A fully credited line is freed:** the original line stops counting for the
  never-twice rule, so the item can be billed again on that visit. A partly
  credited line stays live.
- **GST:** when GST is on, the credit note carries the tax reversal line by
  line, as a GST credit note must, and prints "Credit note against bill …".

## The flow

1. **Desk — request.** On a final bill, **Refund…** opens a line picker (whole
   bill, or chosen lines and quantities) and a reason. It shows what the patient
   would get back and in which mode. Sends a **refund request**
   (`billing_requests.kind = 'refund'`).
2. **Admin — decide** in the existing Desk requests inbox: approve (optionally
   changing the refund mode, with a reason — R1) or reject with a note.
3. **On approval** the credit note is created and numbered in one transaction,
   and the refund becomes **due to the patient**.
4. **Desk — pay out.** The desk hands the money back and records it: a
   `payments` row with `direction = 'out'` against the credit note, in the
   approved mode. **Cash out needs the desk's open shift** and comes out of its
   drawer; card and UPI need the reversal's reference.
5. **Print** the credit note and a refund receipt.

Why two steps (approve, then pay out): the admin approving is usually not at
the drawer, and money should leave only from a counted shift.

## Money rules

- **Nothing is refunded that wasn't paid.** The money back is at most the
  patient's share of the credited lines **and** at most what was actually paid
  on the bill, less earlier refunds. On a pay-later bill with a balance, a credit
  note **reduces the balance first**; only money actually paid comes back.
- **Claims:** crediting a line reduces its claim part on a claim that is still
  **pending**. A line whose claim has been **cleared** by the payer (Phase 5)
  can't be credited here — that money went to the payer, not the patient.
- **Split refunds:** a bill paid part card, part cash refunds in the same shares
  by default (R1), newest payment first; the admin may override.
- **The drawer:** a shift's expected cash becomes opening + cash in − **cash
  out** (the P4-22 review flagged exactly this).

## Tests and the lab gate

- **A test not yet done** (no sample taken) — crediting it puts the order's
  money back the way `releaseTestOrders` already does, so the lab gate closes
  and the test drops off the floor's queue.
- **A test already done** — can still be credited (a goodwill refund), but only
  with the admin's reason, and the order is **not** reverted: the test happened.

## Data changes (one migration)

- `payments.direction` allows `'out'`; an `out` row must belong to a credit
  note; card/UPI `out` rows need a reference.
- `bill_lines.credited_line_id` → the original line, and a check that credited
  quantity never exceeds the original quantity.
- `billing_requests.kind` adds `'refund'`, with the lines and quantities asked
  for, the requested mode, and the approved mode and its reason.
- A `CN` series row per financial year (entered like `MAIN` and `RCPT`).

## Reports (Phase 5)

Revenue and collections net off credit notes and refunds; the dues list shows
a balance after credits; the CGHS register reduces a pending claim by what was
credited.

## Tasks (Phase 4b)

| Task   | What                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------- |
| P4B-01 | Record the decisions (this plan) — Q14 answered                                                          |
| P4B-02 | Migration: `out` payments, credited lines, refund requests, `CN` series                                  |
| P4B-03 | Credit note service: proportional lines, totals, `CN` number, frees fully credited lines, pending claims |
| P4B-04 | Refund requests: desk creates, admin approves (mode override with reason) or rejects                     |
| P4B-05 | Pay out: `out` payments in the approved mode, cash from an open shift, never more than paid              |
| P4B-06 | Cash shift drawer includes cash out                                                                      |
| P4B-07 | Test orders: revert an undone test's money and gate; leave a done test alone                             |
| P4B-08 | Credit note PDF and refund receipt                                                                       |
| P4B-09 | Schemas and routes                                                                                       |
| P4B-10 | Counter: Refund… on a final bill, line picker, pay out                                                   |
| P4B-11 | Desk requests inbox: refund requests                                                                     |
| P4B-12 | Dues list and bill views show credits and refunds                                                        |
| P4B-13 | Smoke script, full suite, plan status                                                                    |
