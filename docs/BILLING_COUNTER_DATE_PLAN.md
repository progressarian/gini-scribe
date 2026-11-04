# Billing counter: pick a past date — Plan

Status: reviewed 2026-11-04, decisions below. No code changed yet.

## 1. Why

The billing counter (`/giniflow/station/reception?tab=bill`) only ever shows **today's** patients. Work on older visits has nowhere to happen:

- **Paid but never finalised.** In October, 135 bills (₹2,63,605) were paid in full but never finalised. The counter flags "Paid · not final" only for today's list, so these are never seen again and stay out of every Billing Reports tab.
- **Payment modes to correct.** ₹4.59 lakh in October was "Paid in HealthRay" with no mode recorded. Fixing it needs "Update mode" on each payment, which lives on the counter.
- **Refunds, credit notes and reprints** for earlier visits.
- **Answering "what happened at the counter on 21 Oct?"**

## 2. What exists today

- **API:** `GET /api/billing/counter/patients` already accepts `?date=YYYY-MM-DD` (`giniflowDateQuerySchema`) and caches the list per date (`counterPatients.js`). The screen never sends it, because the hook `useCounterPatients(q)` calls without a date.
- **Bills on an older visit:** `openDraft` dates a new draft to the **visit's** date, so pricing, category rates and the bill number follow the visit day. That is already right.
- **Payments:** they always carry the time they're taken, so they land in **today's** shift and today's collections. Also right; nothing to change.
- **Parts of the list that assume today:**
  - the "On floor", "Not arrived" and "Left" splits;
  - waiting times (`shapeArrival(row, now)` would say "waiting 3 days");
  - the poll every few seconds.
- **The same hook feeds other tabs.** `ReceptionStationPage.jsx` uses `useCounterPatients("")` for the "tests to bill" badge and the bill-state map on other tabs. Those must stay on today.

## 3. Screen

```
Billing counter                                  [ ◀ ] [ 30 Oct 2026 ▾ ] [ ▶ ] [Today]
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⓘ Viewing Thursday, 30 Oct 2026 — not today. New payments are recorded today │
│   (in your shift) against that day's bills.               [Back to today]    │
└──────────────────────────────────────────────────────────────────────────────┘
Search name, file no, phone…
To bill (3) · Billed (61) · Waiting (0)       Paid · not final: 2  [Show]
```

- **Date control** in the patient-list header:
  - Previous / next day buttons, a date input (no future dates) and a **Today** button.
  - Keyboard: the buttons are real `<button>`s and the input is labelled "Counter date".
- **The date lives in the link:** `?tab=bill&date=2026-10-30`, so it survives a reload, can be shared, and works with "Open at counter" links from the dashboard. Without `date` the counter shows today, as now. The date is not remembered between visits to the page.
- **Banner on any past date:** amber, with a text label (not colour alone), saying the date isn't today and that a payment taken now is recorded today in your shift. It has a **Back to today** button.
- **The list on a past date:**
  - Same groups (To bill / Billed / Waiting) and the same search, run against that day.
  - Hide the "On floor" / "Not arrived" splits and the waiting times.
  - Show each patient's final status for that day instead, e.g. "Left 4:12 pm" or "Did not come".
- **Polling:** none on a past date; the list loads once, plus a Refresh button. Today keeps its current poll.
- **"Paid · not final" count:** shown for the chosen date, with a button that filters the list to those patients.

## 4. Rules on a past date

| Action                                           | Past date          | Why                                                                                 |
| ------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------- |
| View bills, payments, history                    | ✅                 |                                                                                     |
| Print bill or receipt                            | ✅                 |                                                                                     |
| **Finalise** a paid draft                        | ✅                 | Main purpose. The bill number follows the bill date, as now.                        |
| Take a payment (settle a due)                    | ✅ with a warning  | Money is taken today; the dialog says "Bill dated 30 Oct · payment recorded today"  |
| Correct payment mode / Update mode (HealthRay)   | ✅                 | Same rules as today (own open shift, or reception admin)                            |
| Refund / credit note                             | ✅                 | Existing approval flow, unchanged                                                   |
| Edit a draft (add or remove items, discounts)    | ✅ with the banner | The draft keeps the visit's date and that day's prices                              |
| Open a **new** draft for a visit with no bill    | ✅ (decided)       | Dated to the visit day with that day's prices; the banner and payment warning apply |
| Check-in, arrival bill, end visit, floor actions | ❌ hidden          | Floor actions belong to today only                                                  |

No permission changes: the same `BILLING_DESK` capability, and backend rules unchanged.

## 5. Changes

**Backend (small):**

- **`counterPatients(date, q)`:** when `date` isn't today, skip the floor-only splits. It returns `{ date, isToday, toBill, billed, waiting, left }`, and each row carries its final status for the day instead of a live waiting time.
- **`date` validation:** reject future dates with a 400 ("The counter can't show a future date"). Any date from the first billed day up to today is allowed (decided).
- **Shared cache:** past days are already cached per date. On a past day, keep the result until something is written (the existing `billingChanged()` counter already handles this).

**Frontend:**

- **`useCounterPatients(q, { date })`:** the query key includes the date, and there's no `refetchInterval` when the date isn't today. Other tabs keep calling it without a date, so they stay on today.
- **`BillingDesk.jsx`:**
  - read and write `date` in the URL;
  - the date control and the past-date banner;
  - pass `date` to the list;
  - hide floor-only actions when `!isToday`;
  - the "Paid · not final" filter.
- **Payment dialog:** when the bill's date isn't today, show "Bill dated … · payment recorded today".
- **Dashboard:** "Open at counter" links carry `date=<bill date>`, so they open on the right day.

## 6. Tests (e2e DB only)

**`e2e/billing/counter/BC-01-counter-past-date.spec.js`:**

1. With no date, the counter shows today, as before. `?date=` a past day lists that day's visits, and the search runs within that day.
2. A future date gets a 400 from the API, and the screen keeps the date input from going past today.
3. A past date shows the banner, no floor-only actions, no waiting times, and no polling (no repeat requests within 10 s).
4. A paid draft from a past day: the "Paid · not final" count is 1. Finalise it, and it gets a bill number in that day's financial-year series, keeps its bill date, and the count drops to 0.
5. Settling a due on a past bill: the payment is recorded with now and in today's open shift, and the dialog shows the bill-date warning.
6. Update mode on a past HealthRay payment works with the same rules as today.
7. Other reception tabs' badges still count today while the counter shows a past date.
8. "Back to today" and the **Today** button clear `date` from the link. A reload keeps the chosen date, and the dashboard's "Open at counter" lands on the bill's day.
9. Phone width (390 px): the date control fits with no sideways scroll.

Then `npm run build`, the existing counter specs (P4/P4C counter specs), and a manual check by you.

## 7. Out of scope

Bulk-finalising many old drafts at once, and changing how payments or shifts are dated.

## 8. Decisions (2026-11-04)

- **New bills on a past date:** allowed, dated to the visit day with that day's prices.
- **Range:** any date from the first billed day in Scribe up to today. No future dates.
- **Dashboard "Paid, not finalised" list:** add one, covering all dates. The API returns the paid drafts in the dashboard's filters (bill date, patient and UHID, amount, category). Each row links to the counter on its bill date (`?tab=bill&date=…&patient=…`) so it can be finalised there, and the list is in the Excel file too. Test: BD-01 checks the list matches the "not finalised" figures, and BD-02 checks the link opens the counter on the right day.

## 9. Built (2026-11-04)

- **Server:** `counterPatients(date)` refuses future dates (400) and returns `today`, `isToday` and `firstDay` (the first billed day, cached for an hour).
- **`useCounterPatients(q, { date })`:** the date is part of the query key, with no polling on a past date. The other tabs' badges still call it without a date, so they stay on today.
- **Reception page:** `?date=` is kept while bills are opened (`openBill`), and changing the date clears the open patient (`setDeskDate`). `/giniflow/station/billing` already redirects with every parameter, the date included.
- **Counter:**
  - `CounterDate`: previous day, a date input (`min` = first billed day, `max` = today) and next day.
  - The **Today** button was dropped: the patient list is narrow by default, it hid the date, and the banner's "Back to today" does the same job.
  - `PastDayBanner`, plus "Billed / Exited" wording on a past date.
  - The "still on the floor" hint and the lab-site control are hidden on a past date.
  - The existing "paid, not final" banner and filter work per date.
- **Payment box:** "Bill dated … · this payment is recorded today, in your shift." whenever the bill's date is before today.
- **Dashboard:**
  - A "Paid, not finalised" section (up to 500 bills, within the dashboard's filters), with "Finalise at counter" links that carry the bill's date.
  - The top-bills "Open at counter" links also carry the date.
  - Excel gets a "Paid not finalised" sheet.
- **Tests:** `e2e/billing/counter/BC-01-counter-past-date.spec.js`, 7 tests: the past-day list, future refused, banner and no polling, finalising an old paid draft (keeps its date and gets a number), settling an old due (warning; payment today in today's shift), back/reload/previous day, the dashboard link, and phone width. All pass.
- **Regression run:**
  - Dashboard specs and P4C-11, P4C-42, P4C-54 pass.
  - P4C-43 passes after fixing its test 11, which hadn't picked a UPI app for a split part since the UPI-app change.
  - P4-32 test 1 fails on the committed code too (the counter shows a bill with an auto-added consultation, ₹2,500 against the ₹500 the test expects). It isn't caused by this work and is left as is.
