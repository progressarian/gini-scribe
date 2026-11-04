# Billing reports → Dashboard view — Plan

Status: draft, reviewed 2026-11-03. Decided: **separate page**, manual discounts are live, all four KPI groups, and Revenue by service is left as it is. No code changed. No production queries run.

## 1. What the page is today (`/billing/reports`)

- **Files:** `src/pages/billing/BillingReportsPage.jsx` (515 lines), `server/routes/billingReports.js`, `server/services/billing/reports.js` (11 reports), `reportsFilters.js`, `reportsExport.js` (Excel).
- **Access:** `BILLING_REPORTS`, held by admin and reception_admin.
- **Reports (tabs):** Revenue by service, Revenue by consultant, Revenue by category, Collections, Dues, Discounts, CGHS receivables, Coupon usage, Cancellations, Desk requests, Patient deposits.
- **Rules every tab shares:** only final bills count. Credit notes count as negative (`SIGN`). Revenue is dated by `bill_date`. Collections are dated by `payments.received_at` in IST. A range can be at most 366 days, and each section returns at most 2,000 rows.
- **Filters:** date range presets, from/to, category, sub-category, group, subgroup, consultant and user. Each tab allows only some of these.

### Problems found

| #   | Area                           | Finding                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Overview                       | There is no single view of the totals. Answering "how did billing do this month?" means opening 3–4 tabs and adding the numbers by hand. There are no KPI tiles and no charts.                                                                                                                                        |
| 2   | Day/week/month                 | Only **Revenue by service** has a "By" (period) filter, and it puts the period **above** group › subgroup › item. So a month by day becomes about 30 × every item, which hits the 2,000-row cap and truncates. Collections has a "By day" table only. Discounts, dues and cancellations have no time view at all.     |
| 3   | Comparison                     | There is no comparison with the previous period (this week vs last week, this month vs last month).                                                                                                                                                                                                                   |
| 4   | Discounts                      | No trend over time, and no headline "discount as % of gross". The sections disagree on credit notes: _By rule / method / category / consultant / user_ count invoices only, while _Discount % by group_ shows a net figure after credit notes. So two totals on the same tab can differ, with nothing explaining why. |
| 5   | Discounts                      | `method = 'manual'` (manual and "additional" bill discounts) arrives with `2026-11-05_manual_discounts.sql`. The plan relies on it, so I need to know whether that migration is live.                                                                                                                                 |
| 6   | Two clocks                     | Revenue is dated by bill date and collections by the day the money was taken. The page explains this only in a single subtitle line, so a dashboard that puts both side by side must label each one.                                                                                                                  |
| 7   | UX gaps (per CLAUDE.md §21–23) | Loading is plain "Loading…" text, not skeletons. An error has no Retry button. The empty state ("Nothing for these filters.") has no Clear filters action. Filters other than the tab are not in the URL, so a view can't be bookmarked or shared.                                                                    |
| 8   | Speed                          | Each tab runs a full rollup per request with no cache. `BILL_CONSULTANT` is a correlated subquery for each bill. This is fine for a month, but a dashboard with 6+ panels must not run 6 heavy queries on every filter click.                                                                                         |

## 2. Proposal

Add a new page, **`/billing/dashboard`** ("💹 Billing Dashboard" in the sidebar, next to Billing Reports). It is gated by the existing `BILLING_REPORTS` capability, so the same roles see it (admin and reception_admin) and no permission matrix change is needed.

- `src/config/routes.js`: add `"/billing/dashboard": CAP.BILLING_REPORTS`.
- `src/router.jsx`: add the route through `lazyWithRetry`.
- `src/components/AppLayout.jsx`: add the nav entry.

`/billing/reports` keeps its 11 table tabs. The dashboard links into them ("Open full report →") with the same filters, so they become the drill-down. This is not a redesign of the reports page.

### 2.1 Layout (desktop; on mobile everything stacks into a single column)

```
Billing dashboard                       As of 10:42 [Refresh] [Download Excel]
[Dates ▾] [Today] [Yesterday] [From] [To]  [Category] [Consultant] [Clear]
View by:  ( Day | Week | Month )            ← auto-picked from range, user can change

┌ Net revenue ┐┌ Collected ┐┌ Discount ┐┌ Discount % ┐┌ Refunds ┐┌ Dues ┐┌ Bills / Avg bill ┐
│ ₹12,40,500  ││ ₹11,90,200││ ₹84,300  ││ 6.4%       ││ ₹12,100 ││₹40k  ││ 1,204 / ₹1,030   │
│ ▲ 8.2% vs   ││ ▲ 5.1%    ││ ▼ 1.3%   ││ ▼ 0.4 pt   ││ …       ││      ││                  │
│ prev period ││           ││          ││            ││         ││      ││                  │
└─────────────┘└───────────┘└──────────┘└────────────┘└─────────┘└──────┘└──────────────────┘

Revenue & collections by {day|week|month}          [Chart | Table]
  bars = net revenue (bill date), line = net collected (payment date)

Revenue mix                         Payment modes
  horizontal bars by group (top 8    horizontal bars: Cash / Card / UPI /
  + "Other"); toggle: Group |        Paid in HealthRay / Prepaid
  Category | Consultant (top 10)

─ Discounts ──────────────────────────────────────────────────────────
Discount trend by {day|week|month}: stacked bars Auto / Code / Manual
  + line = discount % of gross (right axis)
By rule/code (top 10)   │ By group: discount % of actual │ By user who applied
By consultant           │ Biggest discounted bills (top 20, links to bill)
```

Rules:

- Every KPI tile shows its value, its change against the **previous period of equal length** (with ▲/▼ and text, not colour alone), and a one-line definition in a tooltip.
- Every chart has a **Table** toggle that shows the same numbers, for accessibility and exact values, and a "Open full report →" link to the matching existing tab with the same filters.
- Clicking a bar or bucket narrows the date range to that day, week or month.
- Charts use **Recharts**, which is already a dependency (`src/components/crm/progress/ProgressTrend.jsx`). No new library.
- Money is formatted with `fromPaise` (₹, en-IN). Colours come from the existing tokens: one hue for revenue, one for collections, and a restrained scale for discount methods.
- Each panel has its own skeleton, error state with Retry, and empty state with "Clear filters". A slow panel never blanks the page.

### 2.2 Period (day / week / month)

- Buckets: **day** = IST date. **Week** = Monday-start (`date_trunc('week')`, as the existing report uses). **Month** = calendar month.
- Auto choice: a range of ≤ 31 days uses Day, ≤ 120 days uses Week, and anything longer uses Month. The user can override, but Day is limited to 92 buckets.
- Every bucket appears in the response, including zero ones (`generate_series`), so the charts have no gaps.
- Partial edge buckets, such as a week that starts before `from`, are labelled "partial".
- New presets: **This week**, **Last week**, **Last 7 days**, **Last 12 weeks**, **Last 12 months**. The existing presets stay.
- All filters go into the URL (`/billing/dashboard?from=…&to=…&period=week&category=…`).

### 2.3 Backend

New route file `server/routes/billingDashboard.js`, mounted under `/api`, with the `BILLING_REPORTS` capability and the existing `billingReportQuerySchema` plus `period`:

- `GET /api/billing/dashboard?from&to&period&category&sub_category&consultant&refresh=1`
- `GET /api/billing/dashboard/export`, which returns an Excel file.

The logic goes in the service `server/services/billing/dashboard.js`. The filters are validated with `cleanFilters` from `reportsFilters.js`, using a dashboard definition (filters: period, category, sub*category, consultant). It **reuses the SQL pieces from `reports.js`** (`SIGN`, `FINAL`, `LINE_AMOUNTS`, `LINE_COLUMNS`, `PAYMENT_COLUMNS`, `reportScope`, `DUE*\*`), and these get exported, so the numbers are the same definitions as the tabs.

Response (a few KB at any range):

```js
{
  filters, period, generated_at, buckets: ["2026-11-01", …],
  kpis: { net_revenue, gross, discount, discount_pct, tax, collected, refunds,
          dues_outstanding, bills, credit_notes, avg_bill,
          previous: { …same keys… }, previous_range: { from, to } },
  trend:    [{ bucket, gross, discount, net_revenue, collected, refunds, bills }],
  mix:      { groups: [...top 8 + other], categories: [...], consultants: [...top 10 + other] },
  modes:    [{ mode, label, net }],
  discounts: {
    trend:   [{ bucket, auto, code, manual, pct_of_gross }],
    rules:   [...top 10], groups: [...], users: [...], consultants: [...],
    top_bills: [{ bill_id, bill_no, bill_date, patient_name, file_no, gross, discount, pct, applied_by }]
  }
}
```

- **Queries:** about 5 set-based queries, run in parallel on the request pool:
  1. Line facts grouped by `(bucket)` plus `GROUPING SETS` for group, category and consultant, for the selected range **and** the previous range in one pass.
  2. Payments by bucket and mode.
  3. Discounts by bucket, method, rule, group, user and consultant.
  4. Dues total (open start, as the Dues tab does).
  5. Top 20 discounted bills.
- **Cache:** results are kept in memory for 3 minutes per (filters) key, and concurrent requests share one build. This is the same pattern as `routes/analytics.js` and the clinical reports speed plan. A range that ends before today is cached for 30 minutes. Writing a final bill or payment does not have to invalidate the cache: the dashboard shows "As of 10:42" with a Refresh button that bypasses the cache.
- **Indexes:** the existing `bills_day_idx (bill_date, status)`, `payments_received_idx` and `bill_line_discounts_line_idx` should be enough. Before deciding on any index, I will check `EXPLAIN` on the **e2e DB**. A prod index would be a separate question, with `CONCURRENTLY`, and only with your OK.
- **Excel export:** the dashboard workbook has a KPI sheet plus one sheet per series (trend, mix, discounts), through the existing `reportsExport.js` sections shape.
- **Patient data:** only the _Biggest discounted bills_ list shows names and UHID. It is behind the same capability, and only the top 20 are shown.

### 2.4 Fixes to existing tabs (small, only where the dashboard depends on them)

- **Discounts tab:** add a note that names the basis of each section ("invoices only" vs "net of credit notes"). This way the dashboard and the tab state the same thing, and no numbers change.
- **Revenue by service, "By" = day/week/month:** left as it is (decided). The dashboard trend covers day, week and month.
- **All tabs:** skeleton loading, Retry on error, Clear filters on empty, and filters in the URL. Filters in the URL are needed so the dashboard's "Open full report →" links can carry the filters across.

### 2.5 Frontend files

- `src/pages/billing/BillingDashboardPage.jsx`: the page, with its filter bar and filters kept in the URL.
- `src/pages/billing/BillingReportsPage.jsx`: reads and writes the filters in the URL so the drill-down links work. No other change.
- `src/queries/hooks/useBillingDashboard.js`: one query, keyed by filters. `placeholderData` keeps the previous charts on screen while the new filters load. Export goes through a mutation, as `useBillingReportExport` does.
- `src/components/billing/dashboard/`: `KpiTiles.jsx`, `TrendChart.jsx`, `MixBars.jsx`, `DiscountPanel.jsx`, `ChartOrTable.jsx` (the shared chart/table toggle) and `dashboard.css`. They use the existing `flow-card`, `fset__*` and `brep-*` classes.

## 3. Tests (e2e DB only, `e2e/billing/reports/`)

**`BR-01-dashboard-api.spec.js`:** seed final invoices, a credit note, a cancelled bill, a draft, payments in and out across 3 weeks and 2 months, and auto, code and manual discounts.

1. The KPI totals equal the sums of the existing tabs for the same filters: net revenue = _Revenue by category_ total actual; collected = _Collections_ net; discount = _Discounts_ total; dues = _Dues_ outstanding. Drafts and cancelled bills are excluded, and credit notes are negative.
2. Day, week and month buckets are complete, zero-filled and IST-correct, including a payment at 23:50 IST. A Monday-start week is checked.
3. The previous period has the same length and its numbers are correct.
4. The discount trend splits by method, and the % of gross is right. Top bills are sorted and capped at 20.
5. Filters (category, consultant) narrow every panel. A bad period, more than 92 day buckets, or a range over 366 days gets a 400. A role without `BILLING_REPORTS` gets a 403.
6. Cache: two identical calls make one build, and `refresh=1` rebuilds.
7. The Excel export opens and its KPI sheet matches the API.

**`BR-02-dashboard-page.spec.js`:**

1. `/billing/dashboard` opens for admin and reception_admin and is hidden or refused for reception. The tiles and charts render, and the Day/Week/Month toggle refetches with the right `period`.
2. Clicking a bar narrows the range. "Open full report" lands on the tab with the same filters in the URL.
3. The Table toggle shows the same numbers. A slow mocked panel shows a skeleton while the others render, and a failed one shows Retry.
4. At a 390 px width the tiles and charts stack, with no horizontal page scroll.

Then: `npm run format:check`, `npm run build`, the existing `P5-07` and `P5-12` report specs, and a manual check of the page by you.

## 4. Phases

1. **Backend:** dashboard route and service, period buckets, previous period, cache, and the API spec (BR-01).
2. **Dashboard page:** route, nav entry, KPI tiles, revenue/collection trend, mix and payment modes.
3. **Discount panel:** trend, breakdowns and top bills.
4. **Shared fixes:** filters in the URL, skeleton, Retry, empty state, Discounts tab basis note, Excel sheet. Then the page spec (BR-02).

## 5. Out of scope

Targets/budgets and forecasting, HealthRay-vs-Scribe reconciliation charts, scheduled email of the dashboard, and changing what any existing tab counts.

## 6. Match the existing MIS sheet (added 2026-11-03)

Reception keeps a Google Sheet, **"2026 Master Data w/o MO & CC"**, with three tabs: **Day wise Summary**, **Week wise Summary** and **Monthwise Summary**. The dashboard must produce the same table from Scribe bills, so that staff can stop building it by hand. The dashboard gets an **MIS table** below the KPI tiles, with a Day / Week / Month switch, the same columns in the same order, a Grand Total row, and an Excel download laid out like the sheet.

### 6.1 Columns in the sheet → Scribe source

| Sheet column                                                     | Scribe source                                                                    | Status                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| Appointment Date / Week / Month                                  | Day: `bill_date`. Week: week number 1–53. Month: 1–12                            | Need to confirm how weeks are numbered |
| Net Revenue                                                      | Σ actual − discount on final invoices, less credit notes                         | Same definition as the tabs            |
| Cash                                                             | payments `mode = cash` (in − out)                                                | OK                                     |
| Swipe                                                            | `mode = card`                                                                    | OK                                     |
| BharatPe (QR Code)                                               | `mode = upi`. Scribe does **not** record which UPI app was used                  | **Gap**                                |
| Paytm                                                            | `mode = upi`, as above                                                           | **Gap**                                |
| NEFT / CHEQUE                                                    | Scribe has no such mode                                                          | **Gap**                                |
| Pending Payment                                                  | Net Revenue − all money in; negative = earlier dues paid or extra paid (see 6.4) | Decided                                |
| Rev/Pt                                                           | Net revenue ÷ distinct patients billed that day                                  | OK                                     |
| Consultation charges                                             | Lines in the consultation group, before discount                                 | Map by service group                   |
| Addn Consultation Fee                                            | Subgroup or item for the additional consultation fee                             | Need to confirm which items            |
| Blood Tests Charges                                              | Lab group                                                                        | Map by service group                   |
| X-Ray Charges                                                    | Radiology / X-ray subgroup                                                       | Map                                    |
| ABI / VPT / Fundus / ECG Charges                                 | Machine-test items (one column each)                                             | Map by item                            |
| ECHO Charges                                                     | ECHO group                                                                       | Map                                    |
| Pharmacy Charges                                                 | Is pharmacy billed in Scribe?                                                    | **Need to confirm**                    |
| Miscellaneous Charges                                            | Every other line                                                                 | OK                                     |
| Discount given                                                   | Σ line discounts (negative)                                                      | OK                                     |
| Discount on Consultation charges                                 | Discounts on consultation-group lines                                            | OK                                     |
| Discount Tests                                                   | Discounts on test lines                                                          | OK                                     |
| (Month tab) Check — discount imbalance, Cash taken out           | Totals check, and cash taken out of the drawer from `cash_shifts`                | Need to confirm the meaning            |
| (Month tab) Consultation incl. discount … Total MIS test charges | Second block: charges by group, plus a total of test charges                     | Same data, regrouped                   |

- **Column mapping is admin-configurable:** a small settings table maps each MIS column to service groups, subgroups or items. Items will be added later, and a new item can then be placed without a code change. An "Unmapped" figure is shown, so totals always reconcile with Net Revenue.
- **Reconciliation check:** for every row, the charge columns minus the discounts equal Net Revenue, and Cash + Swipe + UPI + NEFT + Pending equals Net Revenue. A row that fails is flagged, which plays the same role as the sheet's "Check (Discount imbalance)" column.
- **History:** Scribe billing started in Oct 2026, so Jan–Sep 2026 exist only in the sheet. Whether to import that history is an open question.

### 6.2 Decisions (2026-11-03)

- **Payment sub-modes:** the counter records the UPI app (BharatPe QR, Paytm or other UPI) and gains a new **NEFT / Cheque** mode, with its reference required. This needs:
  - a migration to add `payments.instrument` and extend `payments_mode_check` with `neft`;
  - Zod schema changes;
  - the counter payment form;
  - receipts, Collections report labels and cash-shift totals (NEFT is not drawer cash).

  Payments taken before this change show as "UPI (app not recorded)". This is its own phase, ahead of the dashboard, and it gets its own e2e spec.

  **Built (step 0, 2026-11-03):**
  - **NEFT is for incoming money only:** bill payments, the arrival bill, deposits and mode corrections. Refunds and deposit refunds are still chosen as cash, card or UPI. An "as paid" refund of a NEFT payment goes back by NEFT.
  - **UPI app is stored in `payments.upi_app`:** `bharatpe`, `paytm` or `other`. It is required on every incoming UPI payment, and on a HealthRay payment whose real mode is set to UPI.
  - **Migration:** `2026-12-26_payment_neft_upi_app.sql`.
  - **Spec:** `e2e/billing/phase4/P4C-57-neft-and-upi-app.spec.js`.

- **Weeks:** Monday-start ISO weeks (`date_trunc('week')`), labelled "Wk 45 · 3–9 Nov".
- **Pharmacy:** not billed in Scribe. The column is shown as "Not in Scribe", greyed out, and is left out of Net Revenue and the reconciliation check.
- **History:** Scribe data only. The page says "Billing data from <go-live date>". The sheet stays the record for Jan–Sep 2026.

### 6.3 Revised phases

0. **Payment sub-modes:** UPI app and NEFT/Cheque at the counter, plus the migration (e2e DB first; prod only with your OK).
1. **Backend:** dashboard endpoint, MIS rows (day/week/month), column mapping table plus defaults, reconciliation check, cache, and the API spec.
2. **Page:** KPI tiles, MIS table with Grand Total, trend charts and revenue mix.
3. **Discount panel.**
4. **Excel export in the sheet layout,** filters in the URL, loading/empty/error states, and the page spec.

### 6.4 More decisions (2026-11-03)

- **"w/o MO & CC"** is just the sheet's name, so every final bill is included.
- **Addn Consultation Fee:** there is no fixed rule. Admin picks the items for this column in the column-mapping settings, the same way as for every other column.
- **Cash Taken out:** the cash handed over from the drawer when a shift is closed, taken from `cash_shifts`. It appears on the Month view only, as in the sheet.
- **Pending Payment (decided):** one column, as in the sheet: **Pending = Net Revenue − (Cash + Swipe + BharatPe + Paytm + other UPI + NEFT/Cheque)** for the period. Bills are counted on their bill date, and money on the day it was taken. The money columns count everything taken in the period, whichever bill it was for.
  - **Positive:** part of the period's billing is still unpaid.
  - **Negative:** more money came in than was billed. There are two causes, and the tooltip shows each one so the figure is explained:
    1. **Earlier dues paid today:** payments taken in the period on bills dated before it. This is the most common cause: a patient settles a previous day's balance.
    2. **Extra paid by the patient:** money above the bill, kept as deposit (check-in `extraToDeposit`, and deposits taken at the desk).
  - Over a long enough range (a month or the year) these offset each other. The month and Grand Total Pending then shows what is truly still owed, so the Grand Total row also states it as "Still owed at end of range" from the Dues report, as a check.
  - **Tests:**
    - A ₹500 due on day 1 that is paid on day 2 shows +₹500 on day 1 and −₹500 on day 2 (tooltip: earlier dues ₹500).
    - A ₹1,625 overpayment at check-in shows −₹1,625 (tooltip: extra kept as deposit).
    - The week containing both days shows 0 for the dues case.

## 7. Step 1 built (2026-11-03)

- **`GET /api/billing/dashboard`** (`BILLING_REPORTS`). It takes `from`, `to`, `period` (day/week/month; picked automatically when left out), `category`, `sub_category` and `refresh=1`.
  - It returns MIS `rows` per bucket, a `total` row, `kpis` (current and previous period), `mix` (groups, categories, consultants), `dues` and `columns`.
  - Money is in paise.
  - The service is `server/services/billing/dashboard.js`. It reuses the SQL pieces from `reports.js`, so the totals equal the Revenue by category, Collections and Revenue by service tabs.
  - Its queries run in waves of at most three, and the result is cached for 3 minutes (30 minutes when the range is in the past).
- **MIS columns:** the `billing_mis_columns` table (`2026-12-27_billing_mis_columns.sql`), seeded with the sheet's columns.
  - A line goes to the most specific match: item first, then subgroup, then group, then item kind. Anything unmatched goes to Miscellaneous.
  - `GET /api/billing/dashboard/columns` (`BILLING_REPORTS`) lists the columns. `PUT /api/billing/dashboard/columns/:key` (`BILLING_MASTER`) changes one. A change is validated, refused when something it claims is already mapped to another column, audited, and clears the cache.
- **Row check:** charges − discount + tax + round-off − claim − adjustment must equal Net Revenue, which is the patient share on the bill headers.
- **Money columns:** Cash, Swipe, BharatPe, Paytm, Other UPI, UPI (app not recorded), NEFT/CHEQUE, Paid in HealthRay (mode not recorded), Paid earlier / online.
  - A HealthRay payment counts under its real mode and app.
  - Pending is split into its parts: `earlier_dues`, `to_deposit` and `unbilled`.
  - Deposits are left out when a category filter is set.
- **Cash taken out:** the counted cash of shifts closed in the bucket. It is null when a category filter is set.
- **Consultant filter:** `consultant=<id>` keeps whole bills, chosen by the bill's consultant (`BILL_CONSULTANT`, the same rule the reports use for a bill). It applies to the payments on those bills too, so every row still reconciles. Deposits and Cash taken out are left out when any filter is set.
- **Pending parts:** `earlier_dues`, `to_deposit`, `unbilled` (money taken on a bill that isn't final yet), and `from_deposit`. A bill paid from an earlier deposit is revenue with no new money, so it shows as positive pending.
- **Tests:** `e2e/billing/dashboard/BD-01-dashboard-api.spec.js`. 13 tests, all passing on the local test DB. They cover a credit note and payout, a bill paid from a deposit, and the consultant filter.

## 8. Step 2 built (2026-11-03)

- **`/billing/dashboard`** (`BILLING_REPORTS`; sidebar "📈 Billing Dashboard"). The page is `src/pages/billing/BillingDashboardPage.jsx` and its parts are in `src/components/billing/dashboard/`.
  - **Filters** are kept in the URL: dates (adds This/Last week, Last 12 weeks, Last 12 months), View by (Auto/Day/Week/Month; Day is disabled past 92 days), category, sub-category and consultant.
  - **Header:** Refresh (bypasses the cache), MIS columns and Detailed reports.
  - **Tiles:** net revenue, collected, pending, discount (and % of charges), bills, average bill, revenue per patient and dues still owed. Each tile compares with the previous period of equal length, using arrows and words rather than colour.
  - **Revenue and collections chart:** grouped bars on one axis, using palette slots 1 and 2 (they pass the palette validator). It has a tooltip and a table view. Clicking a week or month bar opens that period day by day.
  - **MIS table** in the sheet layout, with column groups Collection / Charges / Discounts / Checks:
    - The sheet's payment columns always show; the others show only when non-zero.
    - Pending shows its parts in a tooltip, which screen readers also announce.
    - Pharmacy shows as "Not in Scribe".
    - Cash taken out shows in the Month view.
    - There's a Grand Total row, a check that each row's lines add up to its bills, and a sticky first column. Week and month rows open day by day.
  - **Revenue split** by service group, category or consultant, and **collected by payment mode**. Both are horizontal bars with a table view.
- **`/billing/dashboard/columns`** (`BILLING_MASTER`, page `MisColumnsPage.jsx`): one editor per MIS column. It can rename the column, add or remove groups, subgroups, items (by search) and item kinds, and save. The server's refusals are shown inline.
- **Shared pieces** moved out of the reports page, with no change to it: `reportRanges.js` (date presets) and `ReportFields.jsx` (select and date fields).
- **Tests:** `e2e/billing/dashboard/BD-02-dashboard-page.spec.js`, 7 tests, all passing. They cover the tiles and table values, view by week and drill to days, the chart's table view, the day-range limit, a role without access being redirected, renaming a column, and a 390px phone with no sideways page scroll.

## 9. Step 3 built (2026-11-03)

- **API:** `discounts` added to `GET /api/billing/dashboard` (`server/services/billing/dashboardDiscounts.js`). It runs as its own wave of three queries.
  - **`rows`**, one per period bucket: `auto`, `code`, `manual`, `given`, `charges` (invoiced) and `pct`.
  - **`total`**, which also has `credited` (discount credited back on credit notes).
  - **Breakdowns:** `rules` (top 10 + other), `groups` (with charges and %), `users` (who applied it) and `consultants`.
  - **`top_bills`:** the 20 bills with the biggest discount, with patient name, UHID and Health ID.
  - **Basis:** the amounts come from `bill_line_discounts` on final invoices, the same basis as the Discounts report tab, and the test checks the totals are equal. The Discount tile stays the net figure (after credit notes), and the section says so whenever something was credited back.
- **Shared filter columns** moved to `dashboardSql.js`, so `dashboard.js` and `dashboardDiscounts.js` don't import each other.
- **Page:** the Discounts section (`DiscountPanel.jsx`).
  - Method totals.
  - A stacked bar chart by period, using palette slots 1–3. The validator passes them; Aqua is below 3:1 contrast, so the table view provides the relief the skill requires. Segments have a 2px white gap.
  - A tooltip with % of charges, and a table view.
  - Four breakdown tables.
  - The 20 bills with the biggest discount, each linked to the counter.
- **Manual discounts:** line-level manual discounts and the bill-level "Additional discount" are stored the same way (method `manual`, `taken_from = 'bill'`, no rule). The stored records can't tell them apart, so the rule table shows one row, "Manual discounts (line and bill)". To split them, Scribe would need to record which one each discount step came from.
- **No second axis:** discount % of charges is in the tooltip and the table, not drawn as a line on a second axis.
- **Tests:** BD-01 tests 9c and 9d cover automatic, code and manual discounts. They check that the totals equal the Discounts report, and that the Discount tile equals the discount given when nothing was refunded (15 tests). BD-02 test 6b covers the page (8 tests). All pass.

## 10. Step 4 built (2026-11-03)

- **Excel download:** `GET /api/billing/dashboard/export` (`BILLING_REPORTS`; `server/services/billing/dashboardExport.js`), with a **Download Excel** button on the dashboard as its primary action. The file is `billing-mis-<day|week|month>-wise-<from>-to-<to>.xlsx`. Sheets:
  - **`Day/Week/Month wise Summary`:** the sheet layout, with a merged Collection / Charges / Discounts / Checks / Pending explained group row, then the column headers. The first column and the header rows are frozen. Day rows are real Excel dates (`d-mmm-yyyy`). There's a Grand Total row and a Lines = bill check, plus a note on what Net Revenue and Pending mean.
  - **`Headline`:** this period vs the previous one, with the change.
  - **`Discounts`:** by period and method, by rule, by group, by staff, by consultant, and the top bills with UHID.
  - **`Revenue split`:** by group, category, consultant and payment mode.
  - **`Filters`.**
- **Shared with the page:** the column rules, period labels and filename live in `shared/billingDashboardText.js`, so the page and the Excel file can't drift apart. The filename is shared because `cors()` doesn't expose `Content-Disposition` when the app and the API are on different origins; the client's fallback name then still matches the server's.
- **Billing reports page:**
  - Every filter now lives in the URL (`range`, `from`, `to`, category, …), so a view survives a reload and can be shared.
  - Clear filters keeps only the chosen report.
  - Loading shows skeletons, an error has Try again, and an empty section has Clear filters.
  - Date presets and the select/date fields are shared with the dashboard (`reportRanges.js`, `ReportFields.jsx`).
- **Tests:** BD-01 test 9e (workbook structure, a real date cell, Grand Total = API, HTTP download, 403), 16 tests. BD-02 tests 6c (Download Excel) and 6d (reports filters in the URL, reload, Clear filters, empty state), 10 tests. The existing report specs P5-07, P5-08, P5-09, P5-11, P5-12 and P5-13 pass.
- **Review fixes (2026-11-03):**
  - **Discounts report tab:** every "given" section now has a note that it counts discount as billed, not taken back by refunds. The % by group section's note explains its Net columns (plan 2.4).
  - **"Open … report →" links:** every dashboard panel links to its report tab with the same dates, category, sub-category and consultant (plan 2.1): Collections, Revenue by service, Revenue by category or consultant (following the split), and Discounts. The header's "Detailed reports" link carries the filters too.
  - **Excel:** the top-bills heading no longer reads "top 0 bills" when there are no discounts.
  - **Test:** BD-02 test 6e (11 tests in all).
- **Already failing, not caused by this work:** P5-06 test 2 expects every section to be empty on the day after its data. The deposits report's "Patients holding a deposit now" section is a today snapshot that ignores dates by design (added in commit `a325d794`, 29 Oct), so the test fails whenever any deposit exists. It needs that test to skip the snapshot section; I left it as is.

## 11. Review on production data (2026-11-04)

Checked against October on the local app, which reads the production database:

- **Totals reconcile:** Collected equals the Collections report, the bill lines balance on every day, and the discount figures reconcile.

Fixed:

- **Paid drafts count as revenue (decided):** a bill counts if it's final, or a draft paid in full (`PAID_DRAFT_SQL`, the counter's "Paid · not final" rule). October had ₹2,63,605 on 135 such bills. The Net revenue tile says how much, and the MIS table and Excel file have a "Paid, not finalised" column. The page says the Billing Reports tabs count final bills only.
- **Previous period:** whole calendar months compare with the previous calendar month(s); other ranges compare with the same number of days before.
- **No silly percentages:** when the earlier figure is zero or the change is 1000% or more, the tile says "Up/Down from ₹X in …" instead.
- **Axis labels:** lakh and crore keep 2 decimals (₹1.05L, not ₹1.1L).
- **Pending explained in full:** the parts are now money for bills dated on other days (both directions), extra kept as deposit, part-paid drafts, bills paid from deposit, refunds kept as deposit, and "Not settled in this period". The page tooltip and the Excel columns show each part's signed effect, and they add up exactly to Pending.

Data issues (need the counter, not code):

- **Card and UPI:** none were recorded in October; every counter payment was entered as Cash.
- **HealthRay payments:** ₹4.59 lakh was "Paid in HealthRay" with no mode set; reception can use "Update mode" to record it.

Tests: BD-01 tests 9f (paid and part-paid drafts) and 9g (refund kept as deposit), plus the calendar-month cases. 29 dashboard tests in all, all passing.

## 12. Charges by service group, with drill-down (2026-11-04, decided)

The MIS columns mapping is replaced by the service master's own groups:

- **MIS table:** its Charges columns are the service groups that have charges in the chosen dates, in service-master order. Lines with no group go to "No group".
- **Drill-down:** clicking a group header opens "Charges detail" below the table:
  - the group's subgroups for each period, with a Grand Total;
  - clicking a subgroup lists its items for the whole range (quantity, charges, discount, after discount).
  - The open group and subgroup are kept in the URL (`group=`, `subgroup=`), and a breadcrumb and Close button go back.
- **API:** `GET /api/billing/dashboard/charges?group=&subgroup=` (`BILLING_REPORTS`), in `server/services/billing/dashboardCharges.js`.
- **Excel:** the main sheet has group columns, and a new "Charges detail" sheet lists group › subgroup › item totals.
- **Discount on Consultation / on Tests:** now based on the item's kind (`consultation`; `test` or a lab order).
- **Removed:**
  - the MIS columns screen, its route and capability entry;
  - `misColumns.js` and its `GET/PUT /api/billing/dashboard/columns` endpoints, which now return 404;
  - the client hooks and the one-off fix script.

  The `billing_mis_columns` table stays on production, unused; dropping it needs its own migration.

- **Fixed:** the MIS table's first column (dates, Grand Total) now stays pinned when the table scrolls sideways; the table's `overflow: hidden` had been stopping it.
- **Tests:** BD-01 test 7 (group columns, subgroup and item detail), test 9 (charges route 200/403/400, removed route 404) and 9e (Charges detail sheet). BD-02 test 6 (click a group → subgroup → items → reload → back → close) and test 7 (pinned column). 29 tests in all, all passing.

## 13. Category rates and write-offs count as discount (2026-11-04, decided)

- **Discount** = discount rules (automatic, code, manual) + **category rate reduction** (`GREATEST(quantity × base_rate − actual, 0)`; CGHS and other price lists below the base price) + **written off** (the `adjustment` share neither the patient nor a claim pays). The CGHS **claim** is not a discount; it's still owed.
- **Charges are now gross at base price** (`actual + category reduction`), so charges − discount + tax + round-off − claim = net revenue still balances on every row.
- **Discount tile:** shows the split as Rules · Category rates · Written off. The MIS table and Excel get "of which category rates" and "of which written off" columns when non-zero; "Adjusted" moved out of Checks.
- **Discount section:** "Category rate" and "Written off" are added as methods (5-slot palette validated; the table view gives the contrast relief). The rule table gets "<category> rates" and "<category> — written off" rows. Groups and consultants include all of it, the top bills list ranks by the full concession and shows the category, and the staff table is discount rules only.
- **Not the same as the Discounts report:** that tab counts discount rules only, and the page says so.
- **October on production data:** Discount is ₹44,228.76 — rules ₹37,389.76, category rates ₹6,839 (Senior Citizen ₹4,000, CGHS Paid ₹2,580, CGHS Pensioner ₹309), written off ₹0. The claim of ₹741 is not in it.
- **Test:** BD-01 test 9h (category rate ₹600 against an ₹800 base, patient pays 50% and the rest is written off: discount ₹500, net revenue ₹300).
