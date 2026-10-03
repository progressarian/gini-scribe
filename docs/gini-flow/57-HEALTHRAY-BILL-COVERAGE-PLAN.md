# 57 — Every HealthRay bill line reaches the Scribe bill

Status: **built** (2026-10-03). Follows 56-PER-PATIENT-PRICE-PLAN.md.

## 1. Problem

The counter opens a patient's draft and adds what it can: the consultation, floor orders, lab-report
tests and — since 2026-10-01 — HealthRay bill lines that match a priced Scribe service. Everything
else waited in the "On today's HealthRay bill" card for someone to notice it:

- a line that matches a Scribe service with **no price** or **priced per patient**;
- a line that matches **no Scribe service at all** (a test or procedure never set up in Scribe).

Those were the lines that got missed. The ask: nothing on HealthRay's bill may be missed on the
Scribe bill, and when Scribe lacks the service or its price, Scribe adds it using HealthRay's amount.

## 2. Decisions

1. **Matched, fixed price** → added at Scribe's price (unchanged).
2. **Matched, priced per patient or no price** → added with HealthRay's amount as the price for this
   patient (`agreed_rate`). The service's own price is not touched.
3. **Not in Scribe** → Scribe creates the service automatically, then adds it at HealthRay's amount.
   - Created **priced per patient** (`price_per_patient = true`, base ₹0). Each bill carries that
     bill's own HealthRay amount, so one bill never sets a price for every patient (HealthRay's
     amounts vary with category rates and discounts — the same follow-up shows ₹1,500/₹1,100/₹700).
   - Placed in group **"From HealthRay — needs review"** (code `HRREVIEW`), sub-group `HR-REVIEW`.
   - Code `HR-<NAME-SLUG>`, name exactly as HealthRay prints it.
   - If the name resolves to a free lab-catalogue test, it is created as that **test** (kind `test`,
     linked), so paid-at-reception, floor-order and lab-report rules keep working. Otherwise kind
     `other`.
   - The next HealthRay line with the same name matches this service by name — never a duplicate.
4. **Never added**: ₹0 lines, the consultation line (own rules), cancelled/removed/refunded lines,
   tests paid at reception (matched by catalogue, and for unmatched names by the floor order's test
   name), and anything the cashier removed from this visit's bill.
5. **Review**: Settings → Services → Not priced gains **"Added from HealthRay bills"** — each
   auto-created service with times billed and HealthRay's usual amount. An admin edits it (fixed
   price, real group, kind) or, for a test, links the name to the existing service and switches the
   placeholder off.

## 3. Changes

| Where                                                     | What                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/services/billing/bills.js` `addLineIn`            | A price for this patient is also allowed on a service with **no fixed price** (base ₹0), not only on per-patient services.                                                                                                              |
| `server/services/billing/healthrayBillLines.js`           | `candidatesFor` returns the unmatched lines with their amounts; `healthrayLinesForDesk` adds per-patient/unpriced matches at HealthRay's amount and creates + adds the missing services; `ensureReviewService` creates the placeholder. |
| `server/services/billing/serviceItems.js` `notPricedList` | New `fromHealthray` list.                                                                                                                                                                                                               |
| `src/components/billing/NotPricedPanel.jsx`               | New list with Edit / Link actions.                                                                                                                                                                                                      |
| `src/components/billing/counter/BillLinesTable.jsx`       | Price note reads "Price from HealthRay bill" for these lines.                                                                                                                                                                           |

## 4. Tests

`e2e/billing/phase4/P4C-25-healthray-lines-on-the-bill.spec.js` (extended):
per-patient and unpriced matches use HealthRay's amount; an unknown name creates one review service
and is billed at HealthRay's amount; a second patient reuses it; ₹0 and paid-at-reception names are
skipped; removed lines stay removed.
