# 59 — Manual discounts at the billing counter

Status: Part 1 in progress (2026-10-05). Part 2 waiting on decision M7.

This reverses decision **D10** of `52-BILLING-PLAN.md` ("Discounts come only from automatic
rules and codes. There is no manual discount anywhere"). The hospital asked for HealthRay-style
discounts typed at the counter: per service/test and on the whole bill, in ₹ or %.

## Decisions (hospital, 2026-10-05)

| #   | Decision |
| --- | -------- |
| M1  | Anyone who can bill (the billing desk capability) may give any manual discount. No limit, no approval. |
| M2  | A reason is optional. Who, when, the kind, the value and the amount taken are always stored and audited, so any question later can be traced. |
| M3  | Manual discounts come **on top** of automatic rules and discount codes: rules and codes first, then manual line discounts, then the manual bill discount. Nothing goes below ₹0. |
| M4  | Two places: a discount on a single line (₹ or %), and an additional discount on the whole bill (₹ or %). |
| M5  | Draft bills only. A final bill never changes (Part 2 covers final bills through a credit note). |
| M6  | Discounts on final bills: wanted ("Both"). |
| M7  | **Open.** A discount on a final bill is a credit note. Today every credit note is a refund request an admin approves (`52-BILLING-REFUNDS-PLAN.md` R2), and credit notes can only credit whole lines or quantities (R3). Does a post-final discount also need admin approval, or may the desk give it directly as M1 says? |

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

- Bill lines: a Discount action per line opens a small form — ₹ / % toggle, value, optional
  reason. The line shows "Manual discount 10% · ₹150 · by Name".
- Discounts card: an "Additional discount" row with the same ₹ / % control and its chip.
- Bill summary already shows the total discount.
- Saved-draft snapshot and "discard unsaved changes" include the manual discounts.

## Part 2 — final bills (after M7)

A discount on a final bill becomes an **amount** credit note: the chosen ₹ (or % of the bill)
spread across the bill's lines in proportion, written through `creditNoteIn` as a new
"discount" kind of note. An unpaid bill's due drops; money already paid comes back through the
existing pay-out step. Needs `creditPiece` to accept an amount instead of a quantity.
