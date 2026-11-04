# Reception staff dashboard — plan

Status: **draft for review** (2026-11-04). No code yet.

## 1. The ask

A dashboard for the people who work the billing counter. For every staff member it should show:

- how much they collected, and by which mode;
- how many patients and bills they handled;
- each of their shifts.

When a shift closes, the cash handover should be fully explained. That means opening cash, cash taken, cash paid back, what should be in the drawer, what was counted, and the difference, with the detail behind every number.

## 2. What already exists (from the code, not from production data)

| Area               | Where                                                                 | What it gives us                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cash shifts        | `cash_shifts`, `server/services/billing/cashShifts.js`                | One open shift per user. Each shift stores `opening_cash`, `expected_cash`, `counted_cash`, `difference`, `note`, `opened_at` and `closed_at`, and who closed it (`updated_by`). The shift's money is totalled by mode, in and out, with counts of payments, bills, refunds and deposits.                              |
| Shift screen       | Reception › **Shift** tab (`ShiftPanel.jsx`)                          | Each staff member can open their shift, see their own drawer, enter counted cash, close the shift, and see their earlier shifts.                                                                                                                                                                                       |
| All shifts         | `GET /billing/master/shifts`, `POST /billing/master/shifts/:id/close` | An admin can list and close anyone's shift. **This has no screen yet.**                                                                                                                                                                                                                                                |
| Payments           | `payments`                                                            | Each payment has a mode (`cash`, `card`, `upi` with `upi_app`, `neft`, `healthray`, `prepaid`, `deposit`), a direction (in = taken, out = paid back), amount, `reference`, `receipt_no`, `received_by`, `received_at`, `shift_id`, and `voided_at`/`voided_by`. It is linked to a bill, or to a patient for a deposit. |
| Bills              | `bills`                                                               | `created_by`, `finalised_by` and `cancelled_by`, plus status and bill date.                                                                                                                                                                                                                                            |
| Manual discounts   | `manual_discount_by` on bills and lines                               | Who gave each manual discount.                                                                                                                                                                                                                                                                                         |
| Check-in           | `giniflow_visits.checked_in_by`                                       | Who checked the patient in.                                                                                                                                                                                                                                                                                            |
| Audit              | `billing_audit` (append-only)                                         | Every bill, line and payment change, with who made it.                                                                                                                                                                                                                                                                 |
| Collections report | `/billing/reports` › Collections                                      | Totals by day, mode, `received_by` and shift. These are tables only, with no per-person view.                                                                                                                                                                                                                          |

Since nearly every number needed is already stored, this dashboard is mostly a new **read** screen. The only new storage is for the handover (§5), and only if you want it.

## 3. Who sees what

| Role                                           | Sees                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `admin`, `reception_admin` (`BILLING_REPORTS`) | Every staff member, every shift, and the exceptions. They can close a shift someone left open. |
| `reception` (`BILLING_DESK`)                   | Their own shifts and figures only, on the existing Shift tab. Nobody else's.                   |

All of this is enforced on the server. The list of staff comes from the payments and shifts themselves, so it only shows people who actually worked the counter.

## 4. The page — `/billing/staff` (Billing › Staff & shifts)

It uses the same filter bar as `/billing/dashboard`: date range (Today / Yesterday / This week / This month / Custom) and a staff picker. Filters are kept in the URL.

### 4.1 Headline tiles (for the whole team, or one person)

- **Collected** (money taken minus refunds paid back), compared with the previous period.
- **Cash to hand over:** cash in drawers across closed shifts, and how much is still in open shifts.
- **Cash difference:** short and excess shown separately, never netted against each other. For example, "−₹200 short on 2 shifts, +₹50 over on 1".
- **Patients served:** distinct patients with a payment by the person.
- **Bills finalised.**
- **Refunds paid back:** count and amount.

### 4.2 Staff table (one row per person) — the main view

| Staff | Shifts | Patients | Bills finalised | Cash | Card | UPI | NEFT | Paid in HealthRay | Refunds out | Net collected | Cash difference | Manual discounts |
| ----- | ------ | -------- | --------------- | ---- | ---- | --- | ---- | ----------------- | ----------- | ------------- | --------------- | ---------------- |

- **UPI** can be expanded into BharatPe / Paytm / Other / app not recorded, matching the dashboard's money columns (`MONEY_COLUMNS`).
- **Totals row** at the bottom.
- **Clicking a row** opens that person's detail (§4.4).
- **Columns that are zero across the whole range are hidden,** as on the main dashboard.

### 4.3 Shifts table (the handover record)

One row per shift, newest first:

- staff, opened and closed time, length;
- opening cash, cash in, cash out;
- **expected in drawer**, **counted**, **difference** (a Short / Over / Matches badge with the amount, not colour alone);
- card + UPI total, status (Open / Closed / Closed by admin), note.

Open shifts sit at the top with how long they have been open. A shift still open from an earlier day is flagged "Left open since 3 Nov, 6:12 pm".

### 4.4 One shift (or one person) — detail drawer

**Cash handover summary**, the same block the print slip uses:

```
Opening cash                    ₹2,000.00
+ Cash taken (42 payments)     ₹38,450.00
− Cash paid back (2 refunds)     ₹600.00
= Expected in drawer           ₹39,850.00
Counted                        ₹39,650.00
Difference                      −₹200.00  Short
```

**Other money** (not in the drawer):

- card, UPI by app, NEFT, each with its count and the reference numbers;
- marked "Paid in HealthRay" and "paid earlier / online";
- deposits taken and returned.

**Payments list:**

- time, receipt no., patient (name + UHID), bill no., mode, reference, amount;
- refunds shown as minus;
- voided payments struck through, with who voided them.

**Activity:**

- bills created, finalised and cancelled;
- manual discounts given (bill, amount, reason);
- payment-mode corrections;
- check-ins.

**Hour by hour:** a small bar chart of payments per hour, useful for counter staffing.

### 4.5 Exceptions panel (`reception_admin`/`admin`)

These are things to act on, each linking to the bill or shift:

- shifts left open past the day;
- cash differences;
- voided or corrected payments;
- refunds paid in cash;
- manual discounts above a set limit;
- bills paid but not finalised, by who took the money (reuses the dashboard's not-finalised list).

### 4.6 Charts (kept few)

- **Collected per staff:** a horizontal stacked bar by mode.
- **Collections by hour of day** for the range.
- The rest stays as tables, since this is an operational screen.

### 4.7 Print and Excel

- **Shift handover slip (PDF):** the §4.4 summary plus the mode totals and the payment list. It ends with "Handed over by ____ / Received by ____ / Time", printed from the shift drawer and from the Shift tab when closing.
- **Excel export:** sheets for Staff, Shifts and Payments for the range.

## 5. Handover = a frozen record of the close (decided 2026-11-04)

"Handover" means **recording what the person hands over at close**. Nobody receives or confirms it. At close, the shift stores a snapshot:

- cash: opening, taken, paid back, expected, counted, difference;
- card, UPI by app and NEFT, with counts;
- "Paid in HealthRay", "paid earlier / online", and deposits taken and returned;
- payment count, patients and bills finalised;
- the note, and **optionally a note count** (₹500 × n, ₹200 × n, ₹100 × n, ₹50 × n, ₹20 × n, ₹10 × n, coins). If filled, the note count must add up to the counted cash.

This needs new columns on `cash_shifts`: `handover JSONB` (the snapshot) and `denominations JSONB` (optional).

- **The snapshot is the handover record.** The slip and the dashboard show it as it was at close.
- **Later changes stay visible.** If a payment in that shift is corrected later, the existing `refreshClosedDrawer` keeps updating `expected_cash`, and the dashboard shows "changed after close" next to the snapshot rather than silently overwriting it.

Every close is written to `billing_audit`.

## 6. API (read-only except the handover)

- `GET /api/billing/staff-dashboard?from&to&user` returns tiles, a staff row per person, shifts and exceptions. It needs `BILLING_REPORTS`.
- `GET /api/billing/staff-dashboard/shifts/:id` returns the shift summary, the payments list and activity.
- `GET /api/billing/shifts/:id/handover.pdf` returns the slip. The owner can get their own; `BILLING_REPORTS` can get anyone's.
- `GET /api/billing/staff-dashboard/export` returns the Excel file.
- Handover writes (only if §5 option 1 or 2): an extended `POST /billing/shifts/close` body, plus `POST /billing/shifts/:id/receive`.

All of this goes in a new `server/services/billing/staffDashboard.js`. It reuses `cashShifts.js` (`SHIFT_SQL`, `shape`), the dashboard's `MONEY_COLUMNS` and period helpers, and the collections report's query pattern. Queries run in batches of 3, as on the dashboard, with a short cache.

## 7. Numbers must reconcile

**What "Net collected" means.** It uses the same definition as the main dashboard's **Collected** (`dashboard.js` `moneyFacts`):

- every payment that isn't voided, taken minus paid back;
- this includes cash deposits taken (bill-less payments) and "Paid in HealthRay" marks;
- it excludes `deposit`-mode moves, because spending a deposit is not new money.

**What must match:**

- The sum of "Net collected" over all staff rows equals the dashboard's Collected for the same range. This holds only with no category or consultant filter, because those filters are bill-level; the staff page doesn't offer them.
- A shift's expected cash equals `cashShifts.js` exactly, using the same SQL.
- Each shift's payment list adds up to its mode totals.
- Payments-tab clearances (§12.1) are shown beside these totals and never added into them.

There will be an e2e test for each of these.

## 8. What production shows (read-only checks, 2026-11-04)

**Payments since 28 Sep 2026:**

| Mode              | Taken         | Paid back   | In a shift       | Staff recorded |
| ----------------- | ------------- | ----------- | ---------------- | -------------- |
| Cash              | 900 (₹14.15L) | 39 (₹28.7k) | all              | all            |
| Paid in HealthRay | 294 (₹5.19L)  | —           | none (by design) | all            |
| UPI               | 3 (₹4.6k)     | 1           | all              | all            |
| Deposit           | 5             | 5           | none             | all            |
| Card / NEFT       | 0             | 0           | —                | —              |

**Shifts:**

- 4 staff have each opened **one shift and never closed it**. Every shift has been open 19–37 days, and nobody has ever closed a shift, so **no handover has ever been recorded**.
- Each open shift's "expected in drawer" is a whole month of cash.

**Payment staff and modes:**

- 2 reception accounts take most of the cash (454 and 314 payments). 2 admin accounts also take payments; one of them mostly marks bills "Paid in HealthRay" (276).
- **Why everything is Cash:** the counter's payment row starts on **Cash** (`counterForm.js` `emptyPaymentRow`), and only 3 UPI payments and no card payments were ever recorded in 5 weeks. Staff almost certainly leave the default in place for UPI and card. So today the mode split per person can't be trusted for anything except cash.

**What this means for the design:**

- The dashboard counts money **by person and by day from the payments themselves** (`received_by`, `received_at`), so it is correct even when shifts aren't closed.
- Shifts become the handover record **once staff close one every day**.
- The "left open" exception is the first thing the page shows.

## 9. Tests (e2e, local test DB)

- **Totals:** staff totals, shift handover maths and reconciliation with the dashboard.
- **Access:** reception sees only their own shifts; other staff are refused (403).
- **Exceptions:** a shift left open, and a cash short.
- **Output:** the slip PDF renders and the Excel sheets match.
- **Handover:** the steps of the chosen §5 option.
- **Phone width.**

## 10. Build steps

1. Service + API + reconciliation tests.
2. Page: tiles, staff table, shifts table.
3. Shift drawer + payments list + slip PDF.
4. Exceptions + Excel.
5. Handover storage and screens (§5), once decided.

## 11. Decisions (2026-11-04)

1. **Handover is a record only.** At close, the shift stores a snapshot of what was handed over, by mode (§5). Nobody receives or confirms it.
2. **Note count at close is optional.** If filled, it must add up to the counted cash.
3. **Reception staff see only their own figures,** on the Shift tab. Admin and reception admin see everyone.
4. **Close per day.** The dashboard and slip are per person per day, built from payments.
   - The Shift tab reminds staff to close at the end of the day.
   - A shift still open after midnight is flagged "Left open since …". Admin can close it from the dashboard: the day's figures are frozen as the handover, with counted cash entered by the admin, or "not counted".
   - The four month-long shifts open today are shown as left open, and admin closes them once the page is live. Nothing is closed automatically.
5. **No default payment mode at the counter.** The payment row starts empty, and staff must choose Cash / Card / UPI / NEFT before the payment can be taken. This change is built first, so mode figures are trustworthy from the day it goes live.
6. **Placement:** a new page, **Billing › Staff & shifts** (`/billing/staff`), with capability `BILLING_REPORTS`.

### Build order (replaces §10)

1. **Counter:** no default payment mode, plus updates to the existing e2e tests that assume Cash.
2. **Service + API** for per-person, per-day totals and the shift list, with the reconciliation tests (§7).
3. **Page:** tiles, staff table, shifts table, "left open" exceptions.
4. **Handover snapshot:** migration (`handover`, `denominations`), close flow with the optional note count, admin close of a left-open shift, and the slip PDF.
5. **Shift drawer** with the payments list and activity, plus the Excel export.

## 12. Review — gaps found and how the plan handles them (2026-11-04)

### 12.1 Money taken outside `payments` (biggest gap)

The plan assumed all money is in `payments`. Two other places take money at reception:

1. **The Payments tab, clearing test orders** (`receptionStation.js` `clearPayment`). It writes `giniflow_lab_orders.amount_paid` plus a `giniflow_lab_order_events` row with the actor. It has **no mode and no shift**, so cash taken there is in nobody's expected drawer, and a closed shift would show it as "Over".
2. **Fees settled from the Bill tab's "fee to settle" banner** (`clearCharge` on `giniflow_bill_charges`). It records `paid_by` and `paid_at`, and again no mode and no shift.

**Plan:**

- Show both as their own column, **"Cleared on Payments tab (taken in HealthRay)"**, per person and per day, from those tables. They are never added into the drawer (see the answer below).
- On the slip it appears as an information line beside "Paid in HealthRay". It is not something to hand over from the drawer.

**Production, 28 Sep – 4 Nov (read-only check):**

| Source                    | Clearances                               | Amount |
| ------------------------- | ---------------------------------------- | ------ |
| Payments tab, test orders | 687 (5 accounts, incl. 1 admin with 250) | ₹6.56L |
| "Fee to settle"           | 33                                       | ₹47.5k |

For comparison, cash at the counter over the same period was ₹14.15L, so this is a large part of reception's money that the shift drawer never sees.

**Answer (2026-11-04):** the Payments tab is temporary and will be removed later. Its clearances are treated **like "Paid in HealthRay"**: money taken through HealthRay, not Scribe drawer cash. The dashboard therefore:

- shows it under **"Cleared on Payments tab (taken in HealthRay)"**, per person ("cleared by");
- keeps it out of the drawer, "Cash to hand over" and the cash difference;
- lists it on the slip as information, beside "Paid in HealthRay".

When the tab is removed, this column simply drops out, as columns that are zero for a range already do.

**Decisions (2026-11-04):**

- Show it separately, as HealthRay money, per person and on the slip. It is not drawer cash.
- No change to the Payments tab, because it is being retired.
- A shift opened on an earlier day gets a **banner, without blocking**.

### 12.2 "Paid in HealthRay" is not money handed over at Scribe

These 294 marks (₹5.19L) were taken in HealthRay, not at the Scribe drawer. `received_by` is only the person who clicked "Paid in HealthRay".

- On the staff table they are their own column and not in "Cash to hand over".
- Where `paid_via` is recorded (via "Update mode"), the real mode is shown under it.
- The person who **marked** the payment is labelled "marked by", not "collected by".

### 12.3 Shifts that span days and the daily close

- A shift row covers opened → closed. The **dashboard counts per day by payment time (IST)**, and the **slip is per shift**. A shift that crosses midnight is listed under the day it opened, with a "Crosses midnight" badge.
- Today a staff member can keep one shift open forever, because one open shift per user is allowed and cash keeps attaching to it. Daily close only works if the counter does something about a shift opened on an earlier day. Recommended: a banner "Your shift has been open since 3 Nov — close it and start today's", with no blocking (see the questions at the end).
- **Closing as "not counted".** `closeShift` today requires `counted_cash`. Admin closing a left-open shift (including the 4 month-long ones) needs a "not counted" option: `counted_cash` and `difference` stay NULL, and the snapshot is marked `not_counted`. The dashboard shows "Not counted" rather than a false Short or Over.
- **After a close,** the first cash payment needs a new shift. The counter already blocks cash and offers "Open shift", so the opening cash is entered then. No carry-over from yesterday's count, because the cash is handed over.

### 12.4 Changes after close

- **Mode corrections:** only an admin can correct a payment once its shift is closed (`paymentCorrection.js` `mayCorrect`). The correction updates `expected_cash` and `difference` live (`refreshClosedDrawer`), but the handover snapshot keeps the figures at close. The shift row shows **"Changed after close"**, with the audit entry (who, when, before → after).
- **Voided payments** (`voided_at`, `voided_by`) are left out of every total. They are listed struck through in the shift's payments list.

### 12.5 People and roles

- Any account that took a payment is included, whatever its role. Today 2 admin accounts take payments.
- If two people share one login, their money shows as one person. Software can't split it, so the page footer says figures are per login.
- **Refunds involve two people:** whoever approved the refund and whoever paid it out (`received_by` on the `out` payment). The staff table counts the payer; the approver appears in the shift's activity.
- **"Patients served"** is the distinct patients the person took money from, by `bills.patient_id` or `deposit_patient_id`. **"Check-ins"** (`checked_in_by`) is a separate column, so front-desk work shows even with no money.

### 12.6 The "no default payment mode" change touches more than the Bill tab

Every place that takes money must start with no mode chosen:

- the counter payment rows (`counterForm.js`);
- check-in & collect (P4C-43);
- dues;
- the deposit panel;
- refund payout (keep its existing "As paid" choice; it must be picked).

The Payments tab has no mode at all (§12.1).

Existing e2e tests that pick nothing and rely on Cash need a line adding the mode: P4-32, P4C-43, P4C-42, BC-01, the phase 4b refunds and the deposits specs. They get updated in build step 1.

### 12.7 Smaller fixes to the plan

- **Exceptions "manual discount above a limit":** no limit exists yet. Use a fixed default of ₹500 or 20% of the line, shown in the panel heading; making it a setting is left for later.
- **Note count:** whole rupees by note and coin. The counted cash is the note-count total when the count is filled in, and typed otherwise. Saved in `denominations` with the rupee value of each note.
- **The slip PDF** reuses `receiptPdf.js` (Puppeteer). If Chrome is missing on the server, the slip fails like the receipt does; the page then offers the on-screen print view.
- **Privacy:** the Excel and payments lists show name + UHID only, with no phone numbers. The Excel needs `BILLING_REPORTS`.
- **Audit:** closing already writes `billing_audit`. The snapshot and note count go into the same audit row, and so does an admin "not counted" close.
- **Size:** about 1,200 payments since September, so the page reads live without a cache beyond the dashboard's 3-minute one. The queries take a date range and use `payments_received_idx`.

## 13. Built (2026-11-04)

**Server**

- `server/services/billing/staffDashboard.js`:
  - `staffDashboard` builds the per-person totals by mode (`money` net and `taken` gross), the cleared-in-HealthRay totals (from `clearedMoney.js`), the work counts (finalised, cancelled, check-ins, manual discounts), the shifts, payments by hour and the exceptions.
  - `staffShiftDetail` returns one shift's payments, clearances, activity and changes after close. Activity groups manual discounts per bill.
  - `shiftHandover` lets the shift's owner, or anyone with `BILLING_REPORTS`, read a slip.
- **Routes:**
  - `GET /api/billing/staff`, `/staff/shifts/:id` and `/staff/export` need `BILLING_REPORTS`.
  - `GET /api/billing/shifts/:id/handover` needs `BILLING_DESK` plus the ownership check.
  - `POST /api/billing/master/shifts/:id/close` now takes `not_counted` and `denominations`.
- **Migration** `2026-12-28_cash_shift_handover.sql` adds `handover`, `denominations` and `not_counted` to `cash_shifts`, with the checks updated. **Applied to production 2026-11-04.**
- **`cashShifts.closeShift`** stores the frozen handover snapshot and the optional note count, and checks that the note count matches the counted cash. Only an admin can close as not counted.
- **`refreshClosedDrawer`** keeps the difference empty for a not-counted shift.

**Counter (step 1)**

- **No default payment mode** on the payment rows, check-in & collect (single and split) or the deposit form.
- **Refund requests keep their mode choice,** because a second person approves the mode.
- **Shift tab:**
  - optional note count;
  - "open since an earlier day" banner, also shown on the Bill tab;
  - end-of-day reminder after 6 pm;
  - counted cash checked (digits only, length cap, far-off warning);
  - a slip link after closing and for each earlier shift.

**Pages**

- **`/billing/staff` (Billing › Staff & shifts):**
  - date presets as buttons, Custom showing From/To, staff picker, and a "Showing …" line;
  - 4 headline tiles;
  - the staff table: at most 10 columns, empty columns hidden, sticky names, Collected highlighted;
  - the shifts table;
  - Needs attention: non-empty blocks only, 5 rows each with "Show all";
  - payments by hour;
  - Excel download with Staff, Shifts and Payments sheets.
- **`/billing/staff/shifts/:id` replaces the drawer.**
  - **Content:** summary cards, admin close (checked), changes after close, and tabs for Payments, Cleared in HealthRay and Bills and discounts, each with search, a filter and 25 per page. Tab, search and page are kept in the URL.
  - **Old links:** `?shift=` links redirect here.
  - **Print handover slip:** opens a dialog on the same page. Printing shows only the slip, full width; this was checked by rendering an A4 PDF.
- **`/billing/shift-slip/:id`:** standalone slip page, sharing the same `HandoverSlip` component; used from the counter.

**Differences from the plan**

- **The slip** is an on-screen print view (browser print), not a Puppeteer PDF.
- **The shift detail** is a page, not a drawer: the drawer could not hold a month-long shift.
- **The by-staff table** shows money taken by mode plus refunds as their own column, so Collected = taken − refunds is visible. Card, UPI and NEFT are one column with a per-app breakdown on hover.

**Tests**

- `e2e/billing/staff/SD-01` … `SD-03`: 18 tests.
- `BC-01` test 8 and `BD-02` test 8: bad links.
- Counter specs updated for "no default mode": P4-32, P4-33, P4-34, P4C-11, P4C-43, D02.
- Last run: 44 passed (staff, counter, BD-02, P4-34).
- **Already failing, not from this work:** P4-32 tests 1 and 9 also fail on the committed code; the test bill has a consultation added on its own.
