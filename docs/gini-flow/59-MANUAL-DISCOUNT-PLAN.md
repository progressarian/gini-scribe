# 59 — Manual discounts at the billing counter

Status: Part 1 and Part 2 built (2026-10-05).

This reverses decision **D10** of `52-BILLING-PLAN.md` ("Discounts come only from automatic
rules and codes. There is no manual discount anywhere"). The hospital asked for HealthRay-style
discounts typed at the counter: per service/test and on the whole bill, in ₹ or %.

## Decisions (hospital, 2026-10-05)

| #   | Decision                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | Anyone who can bill (the billing desk capability) may give any manual discount. No limit, no approval.                                                                                           |
| M2  | A reason is optional. Who, when, the kind, the value and the amount taken are always stored and audited, so any question later can be traced.                                                    |
| M3  | Manual discounts come **on top** of automatic rules and discount codes: rules and codes first, then manual line discounts, then the manual bill discount. Nothing goes below ₹0.                 |
| M4  | Two places: a discount on a single line (₹ or %), and an additional discount on the whole bill (₹ or %).                                                                                         |
| M5  | Draft bills only. A final bill never changes (Part 2 covers final bills through a credit note).                                                                                                  |
| M6  | Discounts on final bills: wanted ("Both").                                                                                                                                                       |
| M7  | A discount on a final bill is given **directly by the desk**, like M1 — no admin approval. It is a discount credit note; money already paid goes back as paid through the existing pay-out step. |

## Part 1 — draft bills

### Money

A manual discount is a **bill-discount step** in `priceBill` — the same mechanism bill-level
rules already use. It comes off the line's patient payable after tax and payment rules, so tax,
claims and adjustments are unchanged and every existing line invariant (`lineInvariant.js`)
still holds.

- Line discount: one step scoped to that line. `percent` takes `value`% of what the line still
  costs the patient after rules and codes; `flat` takes `value` ₹, capped at that amount.
- Bill discount: one step over every line, computed on what is left after the line discounts,
  shared across lines in proportion with the existing `allocate()` (whole paise, remainder by
  largest fraction).
- Stored in `bill_line_discounts` with `method = 'manual'`, `taken_from = 'bill'`, `rule_id`
  null, so the summary, the printed bill and every report that already sums bill discounts
  include it without change.

### Data (migration `2026-10-xx_manual_discounts.sql`)

- `bill_line_discounts.method` check gains `'manual'`.
- `bill_lines`: `manual_discount_kind` (`percent`|`flat`), `manual_discount_value`,
  `manual_discount_reason`, `manual_discount_by`, `manual_discount_at`.
- `bills`: the same five columns for the whole-bill discount.

The inputs are stored (not only the result) so every reprice reproduces the discount.

### API (billing desk capability)

- `POST /billing/bills/:billId/lines/:lineId/discount` `{ kind, value, reason? }`
- `POST /billing/bills/:billId/discount` `{ kind, value, reason? }`
- `value` 0 or empty removes the discount. Draft only; reprices; audited with before → after.

### Counter

- Bill lines: the Discount column on a draft is inline — a % / ₹ select and an amount box,
  saved on Enter or blur; empty or 0 clears it. No reason field inline. The line shows
  "Discount ₹150 off · by Name" and the amount taken under the box.
- Discounts card (under Bill Summary): an "Additional discount on the bill" form with ₹ / %, an
  optional reason, Change and Remove.
- Bill summary already shows the total discount.
- Saved-draft snapshot and "discard unsaved changes" include the manual discounts.

## Part 2 — final bills (built)

- Migration `2026-11-06_discount_credit_notes.sql`: `bills.credit_kind` (`refund` | `discount`,
  discount only on credit notes); credit-note lines may have quantity 0 (amount-only lines).
- `creditNotes.discountFinalBill` / `previewFinalDiscount`, routes
  `POST /billing/bills/:billId/final-discount[/preview]` `{ kind, value, reason?, line_id? }`.
- The discount (₹ or % of what is still credited-free) is spread over the chosen line or all
  lines in proportion. Each note line credits only patient payable, quantity 0, so it never uses
  up refundable quantity and a later refund credits only what is left.
- The note carries the kind, value, reason and who gave it (`manual_discount_*` on the note);
  audited on the note and the bill.
- No refund request row: `payments.refundOf` treats a discount note as approved "as paid", so
  pay-out, refund plans and the bill's Refunds section work unchanged.
- Refunds board: discount notes are listed beside refund requests (`refundBoard.js`
  `DISCOUNT_SQL`, `kind: "discount"`, keyed by the credit note) when money is involved — to pay
  back, or paid back in the date range. A discount that only lowered what was owed is not listed.
- Credit-note PDF banner: "Discount after the bill was final: 10% — reason"; amount-only lines
  print "—" for quantity and rate.
- Counter: "+ Discount on this final bill" in the Discounts card → whole bill or one line, ₹/%,
  optional reason → review (patient, bill, amount, off balance vs to pay back) → confirm.
