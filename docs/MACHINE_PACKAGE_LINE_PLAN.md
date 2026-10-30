# Machine package as one bill line ("ABI,VPT,Fundus ₹800")

## Problem

HealthRay bills the machine package as **one line**:

```
4  ABI,VPT,Fundus   1.00   800.00   800.00
```

(P_182354, OPD/2627-17802, 30 Oct 2026.)

Scribe's draft for the same patient has **three lines plus an automatic discount**:

| Line | Rate | Discount | Pays |
|---|---|---|---|
| ABI (Ankle Brachial Index) | ₹500 | −₹192.31 | ₹307.69 |
| VPT (Vibration Perception Threshold) | ₹300 | −₹115.38 | ₹184.62 |
| Fundus Imaging | ₹500 | −₹192.31 | ₹307.69 |

The Bill Summary shows "Subtotal ₹2,250 · Discount ₹500", and a chip reads "ABI + VPT + Fundus package · ₹500".
The total is right, but reception and the patient see a bill that doesn't look like HealthRay's.
The printed bill shows three tests with odd paise discounts.

Why this happens today:

1. The sync reads HealthRay's "ABI,VPT,Fundus" line and raises **one floor order per machine**
   (`machineSync.js ordersFromBill`).
2. The counter fills the draft with **one line per floor order** (`visitLines.js linesForOrder`).
3. The HealthRay package line is then skipped as already covered (`healthrayBillLines.js coveredByBilledMachines`).
4. A package discount rule (`requires_all_items`) brings the three down to ₹800 (`priceBill.js`).

The billing master already has the package items: `MAC-PKG-ABI-VPT-FUNDUS` "ABI + VPT + Fundus" ₹800 and
`MAC-PKG-ABI-VPT` "ABI + VPT" ₹600. Nothing uses them.

## Change

**When every test of a package is on the same bill, the bill shows one package line at the package price.
No per-test lines and no automatic discount are shown.**

```
#  Service / Test     Category  Qty  Rate    Discount  Patient pays
1  ABI,VPT,Fundus     Machine   1    ₹800    —         ₹800
2  Microalbumin/...   Lab       1    ₹500    —         ₹500
...
Subtotal ₹1,750 · Discount ₹0 · Total ₹1,750
```

The printed bill, earlier-bills table, refund dialog and credit notes show the same single line.

### How it is stored (kept simple and safe)

The floor still needs each test separately. Each machine has its own payment clearance, queue, report and
cancellation, and each bill line links to exactly one floor order (`bill_lines.lab_order_id`). Payments
clear orders through that link (`payments.js orderShares / settleTestOrders`).

So the three part lines **stay in the database** but become **one package group**:

- New column `bill_lines.package_item_id int NULL REFERENCES service_items(id)`. It is set on each part line
  while the package is complete on the bill.
- New table `service_item_package_parts (package_item_id, part_item_id)` says which tests make each package.
  The migration seeds both existing packages:
  - `MAC-PKG-ABI-VPT-FUNDUS` = ABI + VPT + Fundus (₹800)
  - `MAC-PKG-ABI-VPT` = ABI + VPT (₹600)
- **Pricing** (`priceBill.js`, which already reprices the whole bill on every change): when all parts of a
  package are live on one bill, each part's rate becomes its share of the package price, split by base
  price (ABI ₹307.69, VPT ₹184.62, Fundus ₹307.69 = ₹800). Its discount is 0 and `package_item_id` is set.
  The bigger package wins: with all three tests present, the ₹800 package applies, not the ₹600 one.
  If a part is removed, the group breaks and the remaining tests are regrouped or priced normally on the
  same reprice.
- **Display and print** collapse the part lines with the same `package_item_id` into one row: the package
  item's name, qty 1, rate = sum of parts. Nothing is summed twice, because the money stays on the part
  lines.
- The `requires_all_items` discount rule for these items stops applying, because its parts are already at
  package price. Then the rule is switched off (decision 4).

Payments, order clearing, the sync, HealthRay comparisons (`correct-bills-to-healthray.mjs`) and the
existing ₹ totals all keep working unchanged, because they read the part lines as today.

### Counter actions on the package row

- **Remove (trash) on the package row:** removes the whole package (all part lines), with the usual reason
  prompt.
- **Expand arrow:** shows the package's tests underneath, each with its own trash. Removing one regroups the
  rest on the same reprice (decision 2).
- **Line discount:** one discount box on the package row. It is split across the parts by the same
  proportions.

### Refunds and floor cancellations

- **Refund the package:** one row in the refund dialog. Selecting it refunds all parts: ₹800, one credit note.
- **One test of a package not done** (e.g. Fundus cancelled on the floor after the bill was final): the
  remaining tests are **repriced as the smaller package**, and the credit is the difference (decision 3):
  - Fundus not done → ABI + VPT = "ABI,VPT ₹600" → credit **₹200**.
  - ABI not done → VPT + Fundus is not a package → ₹300 + ₹500 = ₹800 → credit **₹0**.
  - VPT and Fundus not done → ABI alone ₹500 → credit **₹300**.
  The credit can never be more than what was paid for the package (₹800), and never below ₹0. The credit
  note names the cancelled test and shows the package before and after (e.g. "ABI,VPT,Fundus ₹800 →
  ABI,VPT ₹600").

### Not changed

- Final bills made before this ships keep their three discounted lines.
- Open drafts regroup on their next reprice, i.e. the next time the counter opens them.
- Floor orders, machine steps, payment clearance on the Payments tab.
- Packages for other tests. The same tables work for them later, but only these two are seeded.

## Server

- Migration `server/migrations/2026-12-21_bill_line_packages.sql`: `bill_lines.package_item_id`, table
  `service_item_package_parts`, seed both packages by item code. Rerunnable.
- `services/billing/packages.js` (new): `packagesForBill(client, lines)` returns the groups to apply
  (largest first, each part in at most one group).
- `priceBill.js`: applies the groups before the discount rules, setting the part rates and `package_item_id`.
  It skips `requires_all_items` rules whose items are all inside an applied group.
- `bills.js` bill view: adds `package_groups` (package item id, name, amount, part line ids) so the screen
  doesn't regroup by itself.
- `billPdf.js`, `receiptPdf.js`, credit note PDF: print a group as one line.
- `billingRequests.js` / refund lines: a package row expands to its part lines. A single cancelled part
  credits its share.
- `audit`: `billing_audit` rows for grouping and ungrouping (action `update`, `after.package_item_id`).

## UI

- `src/components/billing/counter/BillLinesTable.jsx`: render `package_groups` as one row (category
  "Machine", qty 1, package price). The trash and discount controls act on the whole group.
- `RefundDialog.jsx`: a package checkbox picks all its tests. Its tests are listed underneath for
  refunding one, and the preview shows the repriced amount.
- `TotalsAndPayment.jsx`: no package chip, because there is no package discount any more.

## Tests

New `e2e/billing/phase5/P5-17-machine-package-line.spec.js` (local test DB):

1. HealthRay bill with "ABI,VPT,Fundus ₹800" and the three machine orders raised → the desk draft shows
   **one** row "ABI,VPT,Fundus ₹800", Discount ₹0, no package chip, total ₹800.
2. The DB has three part lines, each with its `lab_order_id` and `package_item_id`, summing exactly ₹800.00.
3. Taking payment and finalising the bill clears all three machine orders, and their machine steps open.
4. Only ABI + VPT on the bill → one row "ABI,VPT ₹600". Only ABI → "ABI ₹500" as a normal line.
5. All three added by hand from Add Service/Test (no floor orders) → the same single ₹800 row.
6. Trash on the package row removes all three lines. The audit has the reason. Expanding the row and
   removing Fundus alone leaves one "ABI,VPT ₹600" row.
7. Line discount of 10% on the package row → ₹720, split across the parts.
8. The printed bill PDF has one line "ABI,VPT,Fundus 1.00 800.00 800.00" and no per-test lines.
9. Refund of the package row → one credit note of ₹800, and all three parts marked refunded.
10. Fundus cancelled on the floor after finalising → ABI + VPT repriced as "ABI,VPT ₹600", credit ₹200.
    ABI cancelled → VPT + Fundus at ₹800 normal, credit ₹0. VPT + Fundus cancelled → ABI ₹500, credit ₹300.
11. A final bill made before the change (three discounted lines) is unchanged when opened.
12. Existing suites still pass: `P5-16-healthray-machine-package-once`, the phase4 finalise/refund specs and
    `G110` (machine tests not on the HealthRay bill).

Manual check on local (3000) after the API restart: open P_182354's draft. The three machine lines become
one "ABI,VPT,Fundus ₹800" row and the total stays ₹1,750.

## Decisions (30 Oct 2026)

1. **Name on the bill:** "ABI,VPT,Fundus" and "ABI,VPT", as HealthRay prints them. The migration renames
   the two package items.
3. **One test of a final package not done:** reprice the rest as the smaller package. The credit is the
   difference (see Refunds).
4. **Old package discount rule:** switched off once this ships. Pricing already ignores it wherever the
   package line applies. The rule itself is switched off by hand in Settings → Discounts **after the new
   code is deployed**. Not in the migration: the migration runs on production before the deploy, and
   switching the rule off first would charge ₹1,300 for the three tests until the deploy.

2. **Removing one test at the counter:** the package row has an expand arrow that shows its tests, each
   with its own trash. Removing one regroups the rest (e.g. "ABI,VPT ₹600") or prices them normally. The
   trash on the package row itself removes the whole package.
