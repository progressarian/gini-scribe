# 75 — Desk requests by date, with filters

Status: built (19 Oct 2026). Approved the same day ("yes build it").

## Ask

"Can we show it date wise and filter, and also a status filter; by default show today's and all."

Applies to both tabs of 📥 Desk requests (plan 74): **Billing requests** and **Test cancellations**, in both places they appear (the top menu page and the reception Requests tab).

## Today

- **Billing requests** shows two tables: "Waiting for an answer" (every pending request, any date) and "Already answered" (the last 200, searched in the browser). There is no date or status filter, and requests are not grouped by day.
- **Test cancellations** has Status (default **Waiting**), From/To (hidden while Waiting) and Search, all on the server, 20 per page. Requests are not grouped by day.

## Change

### One filter bar, the same on both tabs

```text
[Search by patient, UHID, bill no or item]  [Status ▾]  [Kind ▾]  From [19 Oct]  To [19 Oct]  [Today] [Clear filters]
```

| Filter | Options                                                                      | Default   |
| ------ | ---------------------------------------------------------------------------- | --------- |
| Status | All · Waiting · Approved · Rejected · Used · Withdrawn                       | **All**   |
| From   | date                                                                         | **today** |
| To     | date                                                                         | **today** |
| Kind   | Billing requests only: All · Refund · Deposit refund · New item · Bill again | All       |
| Search | patient name, UHID, bill no, item / test name (2+ letters)                   | empty     |

- Test cancellations has no "Used" status and no Kind filter.
- The date is the day the request was **asked**, in India time.
- **Today** puts both dates back to today. **Clear filters** puts every filter back to its default. Clear filters only shows when something differs from the default.
- From can't be after To; the date pickers enforce it.
- Search waits 300 ms after typing, like Test cancellations does now.
- Filters stay while you switch between the two tabs, until the page is left.

### Date-wise list

One table per tab, grouped by day, newest day first:

```text
Mon, 19 Oct 2026 · 4 requests · 2 waiting
  10:42  E2E Reception   P_180824 Ravi Kumar   Refund on bill GH26-000264   Waiting   [Approve] [Reject]
  09:15  …
Sun, 18 Oct 2026 · 1 request
  …
```

- Inside a day, waiting requests come first (oldest first, so the longest wait is on top), then answered ones, newest first.
- Each row keeps what the two current tables show: asked by and time, patient (name, UHID, age), what for, reason, status (with who answered and when), and Approve/Reject on waiting rows.
- The status reads as a label plus a colour: Waiting, Approved, Rejected, Used, Withdrawn, the same words used today.
- 20 rows per page, counted and paged on the server. A day split across pages repeats its header on the next page.

### Waiting requests from earlier days are never hidden

With today as the default, a refund asked yesterday and still waiting would disappear from view. So when the dates exclude any waiting requests, a notice sits above the list:

```text
⚠ 2 requests from earlier days are still waiting.  [Show them]
```

**Show them** sets Status to Waiting and clears both dates. The tab counts (and the menu number) keep counting every waiting request, whatever the filters.

### Empty and error states

- Nothing today: "No requests today." plus, if any exist, the earlier-days notice.
- Nothing matches: "No requests match these filters." with **Clear filters**.
- Load failed: "Unable to load requests. Please try again." with **Try again**.
- Loading: "Loading requests…".

## Server

**Billing requests:** new `GET /api/billing/master/requests/search`, so the existing `GET /api/billing/master/requests` (used by older screens and tests) keeps answering a plain list.

- Query: `status`, `kind`, `from`, `to`, `q`, `page`, `limit` (default 20, max 100).
- It returns `{ rows, total, page, olderWaiting }`. `olderWaiting` is the count of waiting requests outside the date range.
- It excludes `test_cancel` like the current inbox, uses the existing `LIST_SQL` and `shape`, and keeps refund previews on waiting rows only.
- It is guarded by `BILLING_MASTER` like the rest of `/api/billing/master`. Bad dates, statuses or kinds get a 400 with a plain message.

**Test cancellations:** `listCancelRequests` gains `olderWaiting` in its answer. Its sort changes to day first (newest), then waiting first, then time. Its existing filters already cover the rest.

Both use `(requested_at AT TIME ZONE 'Asia/Kolkata')::date` for the day, as Test cancellations does now.

## Screen

- New shared `src/components/billing/RequestFilters.jsx` with the filter bar. It uses the existing `fset__field`, `jb-assign` and `cxl-filters` styles from the Test cancellations page, so no new design.
- New shared `src/components/billing/DayGroups.jsx`, which renders the day header rows (`<tr><th colSpan scope="colgroup">`) inside the existing `flow-table`.
- `DeskRequestsPage.jsx`: the two tables become one filtered, date-grouped table. The decision dialogs stay unchanged.
- `TestCancellationsPage.jsx`: the default becomes All + today, the dates are always visible, plus the day groups and the earlier-days notice.
- Query keys stay under `["billing", "requests", …]` and `["giniflow", "cancel-requests", …]`, so approving, rejecting and live signals refresh them as they do now.
- At 390 px the filter bar wraps into one column, and the table becomes the readable rows Test cancellations already uses on a phone.

## Not changed

- How requests are raised, approved or rejected, and the dialogs.
- The tab counts and the menu number (all waiting requests).
- Who can see what (plan 74).

## Tests (e2e, test DB only)

New `e2e/billing/phase4b/P4B-23-desk-requests-filters.spec.js`. Fixture: requests asked today and two days ago, in several statuses and kinds, on both tabs.

1. **Defaults:** both tabs open on All + today; only today's requests show, in every status, under one "today" header.
2. **Status:** Waiting / Approved / Rejected each narrow the list, and the counts on the day header match.
3. **Kind** (billing requests): Refund shows only refunds.
4. **Dates:** a two-day range shows two day groups, newest first; within a day, waiting comes first.
5. **Earlier waiting:** the old pending request is hidden by today's dates, the notice says "1 request from earlier days", and **Show them** lists it.
6. **Search:** by patient name, UHID and bill no.
7. **Clear filters / Today** restore the defaults; Clear only shows when something changed.
8. **API:** the search endpoint's `total` and `olderWaiting` match the database; reception and lab get 403; a bad date gets 400.
9. **Paging:** 21 requests in one day give two pages, and the day header repeats.
10. **Screen sizes 1366, 768 and 390 px:** no sideways page scroll; the filters are reachable.

Rerun P4B-22, P4-36, P4B-11, P4B-17, G92.
