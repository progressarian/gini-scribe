# 98 — Editing a final bill in place

Status: **built 27 Nov 2026**. Supersedes the credit-and-re-issue design in
`70-BILL-CORRECTION-PLAN.md` for everyday counter corrections (the hospital chose to keep the
same bill number).

## What reception can do

A final, printed bill can be opened with **Edit bill** (capability `BILLING_EDIT_FINAL`,
granted to reception, reception_admin and admin). While the edit is open the counter's normal
line, quantity, price, code and discount controls work on the final bill. **Save changes…**
asks for a reason, shows what changed (added / removed / changed lines, total before and after,
already collected, due after saving), saves and reprints. **Discard changes** puts the bill back
exactly as it was.

## Rules

| Rule                                                                                                                                                                                        | Where                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Same `bill_no`, `status = 'final'`, `finalised_*` kept; `revision_no` goes up by one per saved edit                                                                                         | `billEdit.js` `saveEdit`                                        |
| Every final bill can be edited — including bills with a credit note, an open request, a settled payer claim or a replacement bill. Only cancelled bills (and credit notes themselves) can't | `billEdit.js` `editRefusal`                                     |
| Lines refunded on a credit note stay in the bill's totals; a partly refunded line can't be removed or cut below the refunded quantity                                                       | `bills.js` `creditedLineTotals`, `creditedOf`                   |
| Claim status follows the claim amount (pending ↔ none); a bill whose payer already paid must keep a claimed line                                                                            | `bills.js` `saveTotals`                                         |
| Refund, final-bill discount and cancel are refused while an edit is open                                                                                                                    | `editLock.js` `assertNotEditing`                                |
| Lines already on the bill keep the rate they were billed at; only new lines take today's price                                                                                              | `bills.js` `frozenRates` → `priceLine.js` fixed rate (`frozen`) |
| The total can never drop below what was collected — use Refund for that part                                                                                                                | `bills.js` `saveTotals`                                         |
| A higher total shows as due (Dues list) and is collected normally                                                                                                                           | `dues.js` `DUE_BILLS`                                           |
| Every save writes an append-only `bill_revisions` row (full before/after snapshot + reason) and a `billing_audit` entry                                                                     | migration `2027-02-01_bill_edit_in_place.sql`                   |
| Printed bill shows "Revised bill — revision N on …", or "BEING EDITED — NOT FINAL" while an edit is open                                                                                    | `billPdf.js` `revisionBannerHtml`                               |
| Test orders, lab steps and membership card uses are re-synced on save                                                                                                                       | `billEdit.js` `saveEdit`                                        |

## Compliance note

Changing a GST tax invoice under the same number departs from credit-note practice. The
immutable revision log, mandatory reason, audit trail and "Revised" print banner are there so
every printed copy can be traced. The accountant should confirm this is acceptable for GST filing.

## Tests

`e2e/billing/edit/E1-edit-final-bill.spec.js`, `E3-edit-and-membership-screens.spec.js` (test 1).

## A bigger discount on a bill that is already paid

A bill's own total can't drop below what was collected. When an edit's discount would do that,
the counter explains how much has to go back and offers **Give it as a credit note…**: the edit is
closed and **Discount on this final bill** opens with the same discount filled in.

- A % there is the bill's total discount as a share of the full amount: 20% on a ₹3,400 bill that
  already had 10% gives ₹340 more (`creditNotes.js` `wholeBillDiscount`). Asking for a % already
  reached is refused.
- The money goes back one of three ways, chosen on the confirm screen (`bills.payback_mode`,
  migration `2027-02-05_credit_note_payback_mode.sql`):
  - **Refund in cash now** (default): a cash pay-out from the user's open shift, even if the
    patient paid by UPI or in HealthRay. The original payment is not changed.
  - **Keep in the patient's deposit.**
  - **Pay back the way they paid**, later, from Refunds.
- Bill summary: Total ₹3,060 · Credited ₹340 · Refunded ₹340 · Net charged ₹2,720.
