# Home collection — automatic 10% on Pathology (HMCOL10)

Status: **built 2026-10-28**, not yet live — needs the migration (§4.4) and the HMCOL10 rule limited to Pathology (§4.1). Build/import checks only; no e2e run.

## 1. Problem

HealthRay takes 10% off the Pathology tests of a home-collection patient. Scribe only does it when
reception types the code `HMCOL10`, and the code takes 10% off every line on the bill.

From production (read-only, last 30–60 days):

| Fact                                                | Number                                                     |
| --------------------------------------------------- | ---------------------------------------------------------- |
| Final Scribe bills for home-collection visits       | 29                                                         |
| …with `HMCOL10` typed                               | 7                                                          |
| Consultation lines that got 10% through `HMCOL10`   | 7 (HealthRay never discounts consultations)                |
| HealthRay home-collection bills with a discount     | 29 of 37                                                   |
| HealthRay home-collection lines discounted, by type | Pathology 183 of 261; consultation 0 of 26; machine 0 of 2 |
| HealthRay discount on those Pathology lines         | 10% (176 lines); 7 lines free                              |

## 2. Decisions (agreed 2026-10-28)

1. **Pathology only.** Consultation, machine tests, radiology and procedures pay full price.
2. **Automatic, but reception may remove it** from one bill; it then stays off that bill.
3. **Payments tab too** — floor test orders for Pathology are priced 10% lower on a home-collection visit.
4. **Old bills:** open drafts pick it up on their next reprice; final bills are not touched.

## 3. Definitions

- **Home-collection visit** — the floor's existing definition, `HOME_COLLECTION_SQL`
  (`server/services/giniflow/homeCollection.js`): the visit's lab site is `home`, or that day's
  appointment is marked home collection, or an approved home request in the last 7 days. One
  definition, so the bill, the Payments tab and the lab board never disagree.
- **Pathology test** — a service item in the `LAB` group (Pathology). For a floor order, the test's
  catalogue row → its active service item → subgroup → group `LAB`.
- **The discount** — the `HMCOL10` rule itself (value, active, valid dates). Turning the rule off or
  changing its % in Settings → Discounts changes the bill and the Payments tab together. Nothing is
  hard-coded except the code name, kept in `shared/billingVocab.js` as `HOME_COLLECTION_CODE`.

## 4. Changes

### 4.1 The rule (configuration, one row)

Restrict `HMCOL10` (discount_rules id 12) to the Pathology group: `group_ids = {7}`. Done through
Settings → Discounts (admin) so it is audited like any rule edit. After this, typing the code by hand
also only takes 10% off Pathology — the consultation leak stops even before the code below ships.

### 4.2 Scribe bill — `server/services/billing/`

- `priceBill` takes an optional `visitId` and `homeCodeRemoved`. When the visit is a home-collection
  visit and the code was not removed, `HOME_COLLECTION_CODE` is added to the codes being priced.
- Because a bill's codes live on its lines and every change reprices the whole bill (`bills.js
reprice`), this one entry point covers every way a bill changes: lines added at the counter, from
  the consultation, from floor orders, from the HealthRay bill or lab report, price catch-up,
  consultant change, arrival bill.
- If the bill has no Pathology line the code simply takes nothing; it is **not** shown as a refused
  code (it was never typed).
- `pricingInput` passes `bill.visit_id` and the bill's removal flag.
- **Removing it:** `removeCode` on the home code sets `bills.home_code_removed_at/by` (new columns) and
  writes `billing_audit`. Adding it back by hand (`addCode`) clears them.
- **Audit:** the first reprice that applies it automatically writes a `billing_audit` row
  ("Home collection discount applied automatically").
- Scheme-rate lines (CGHS etc.) stay excluded — the rule's `applies_on_scheme_rate` is false, unchanged.

### 4.3 Payments tab — floor test orders

- New `homeDiscountFor(visitId, db)` in `server/services/pricing.js`: returns the `HMCOL10` percentage
  when the rule is active and valid today and the visit is a home-collection visit, else 0.
- Applied wherever a visit's lab tests are priced: MO station orders (`moStation.js`), the journey
  (`journey.js`), the arrival quote (`arrivalQuote.js`). Machine orders are untouched.
- **Late flag:** when a visit becomes home collection after its tests were ordered (lab site set to
  `home` at collection), its **unpaid, uncleared** Pathology orders are repriced once. Paid or claimed
  orders are never repriced.
- Once HealthRay bills, orders already follow HealthRay's net amount (`priceOrdersFromBill`), which
  carries HealthRay's own 10% — unchanged.
- Removing the code from the bill does not reprice floor orders; paying the bill settles them from
  the bill's amounts, as today.

### 4.4 Database

`server/migrations/2026-10-28_bills_home_code_removed.sql`:

```sql
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS home_code_removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS home_code_removed_by integer REFERENCES doctors(id);
```

Read through `to_jsonb(b)->>'home_code_removed_at'` so local dev and the API keep working before the
migration is applied. No backfill.

### 4.5 Screen

- Bill tab: the code shows as `HMCOL10 · Home collection (auto)` with the existing remove ✕; removing
  asks "Remove the home-collection discount from this bill?" and names the amount.
- Payments tab: Pathology rows on a home-collection visit show `10% home collection` under the price.

## 5. Not changing

- Final bills, receipts and credit notes already issued.
- HealthRay itself.
- Visits Scribe does not know are home collection (80 HealthRay bills with 10% on lab tests are not
  flagged home in Scribe) — they get the discount once the home request or lab site is recorded.

## 6. Checks

- e2e (local test DB only): home visit bill gets 10% on Pathology only; consultation full price;
  remove → stays off after adding a line; re-add works; non-home visit gets nothing; Payments tab
  order price 10% lower; lab site set to home later reprices an unpaid order and leaves a paid one.
- Manual: one home-collection patient end to end — order tests, Payments tab amount, bill, pay.
