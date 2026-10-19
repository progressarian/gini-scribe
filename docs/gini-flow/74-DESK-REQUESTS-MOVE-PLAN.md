# 74 — Desk requests move out of Settings

Status: built (19 Oct 2026). Approved the same day ("yes build it").

## Problem

Requests waiting for an admin are hard to find and manage:

- **Billing requests** (refund, deposit refund, new item, bill again) live at **⚙️ Settings → Desk requests**. Settings is the last of about 30 items in the top menu, and Desk requests is its 9th tab.
- **Test cancellations** live at **Settings → Test cancellations**, a separate tab.
- The waiting count shows only on those tabs, after the admin is already inside Settings.
- An admin working at the reception counter sees "Waiting for admin" on the Refunds tab, but has to leave the counter to answer it.

## Decision (19 Oct 2026)

Desk requests move out of Settings to **two places**. Both show the same screen with the same live counts:

1. **Its own item in the top menu:** "📥 Desk requests (3)", right before 🕐 Gini Flow.
2. **A tab on the reception screen:** "Requests (3)", after Refunds, for admins working at the counter.

The screen has two tabs:

- **Billing requests:** the current Desk requests page, unchanged.
- **Test cancellations:** the current Test cancellations page, unchanged.

Both are removed from Settings. The old Settings addresses forward to the new page, so bookmarks and links keep working.

## Who sees what

| Role                          | Menu item | Reception tab | Billing requests tab | Test cancellations tab |
| ----------------------------- | --------- | ------------- | -------------------- | ---------------------- |
| admin                         | yes       | yes           | yes                  | yes                    |
| reception_admin               | yes       | yes           | yes                  | no                     |
| reception, lab, everyone else | no        | no            | no                   | no                     |

- The **Billing requests** tab needs `BILLING_MASTER` and the **Test cancellations** tab needs `GINIFLOW_TEST_CANCEL_DECIDE`, the same permissions those pages need today. Nobody gains or loses access.
- The menu item and the reception tab show for anyone holding either permission. Inside, only the tabs they can use appear. With only one tab, the tab row is hidden and that page shows directly.
- The reception tab also needs the billing desk (`BILLING_DESK`), like Bill, Dues, Shift and Refunds. Both approver roles have it.
- No approver role has a menu allowlist (`ROLE_NAV_ALLOWLIST`), so the menu item is never hidden from them.

## Addresses

| Address                                               | Shows                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `/desk-requests`                                      | Billing requests if allowed, otherwise Test cancellations    |
| `/desk-requests?tab=tests`                            | Test cancellations                                           |
| `/giniflow/station/reception?tab=requests`            | Reception's Requests tab, first allowed sub-tab              |
| `/giniflow/station/reception?tab=requests&kind=tests` | Reception's Requests tab, Test cancellations                 |
| `/settings/desk-requests`                             | forwards to `/desk-requests` (keeps the history entry clean) |
| `/settings/test-cancellations`                        | forwards to `/desk-requests?tab=tests`                       |

- A sub-tab the person can't use falls back to the one they can, the same way `useReceptionTab` already falls back for desk tabs.
- The page is lazy-loaded through `lazyWithRetry`, like every other page.

## Counts

The counts match the pages exactly:

- **Billing requests:** `billing_requests` with `status = 'pending'` and `kind <> 'test_cancel'`. This is the list on the Billing requests tab (`listRequests` with no kind).
- **Test cancellations:** `kind = 'test_cancel'` and `status = 'pending'`. This is the `waiting` number from `listCancelRequests`.

The menu item and the reception tab show the sum of the kinds the person can see. Each sub-tab shows its own count.

**Server.** New `GET /api/approvals/waiting`:

- `server/services/billing/approvalsWaiting.js` runs one query:
  ```sql
  SELECT COUNT(*) FILTER (WHERE kind <> 'test_cancel')::int AS desk,
         COUNT(*) FILTER (WHERE kind = 'test_cancel')::int AS cancellations
    FROM billing_requests WHERE status = 'pending'
  ```
- It returns `{ deskRequests, testCancellations }`. A kind the person can't decide comes back `null`, not a number.
- `server/routes/approvals.js`, mounted in `server/index.js`, is guarded by `requireCapability([BILLING_MASTER, GINIFLOW_TEST_CANCEL_DECIDE])`. It is also added to `ROUTE_CAPABILITIES` in `server/middleware/auth.js`. Anyone else gets 403.
- It sends counts only, never names or amounts. Errors go through `handleError`, so no SQL text reaches the screen.

**Screen.** New `useApprovalsWaiting()` in `src/queries/hooks/useApprovals.js`:

- Query key `["billing", "approvals-waiting"]`, enabled only for people with either permission.
- Polls every 30 s, not while the browser tab is hidden, and refreshes when the tab comes back.
- Approving or rejecting already invalidates `["billing"]` (`useDecision` and the test cancellation actions), so the counts drop as soon as the admin answers.

## The shared screen

New `src/components/billing/DeskRequestsInbox.jsx`, `<DeskRequestsInbox param live />`. `param` is the address word that holds the sub-tab: `tab` on `/desk-requests`, `kind` inside reception (where `tab` is already the reception tab). It has:

- a tab row "Billing requests (3)" and "Test cancellations (1)", using the existing Settings tab styles (`set__tabs` / `set__tab` / `set__tab-badge`, as Billing reports does), because the station `st-tabs` styles only apply inside the reception screen. It has `role="tablist"` / `role="tab"` / `aria-selected` / `aria-controls`, and the arrow keys move between tabs. A count of 0 shows in grey;
- the matching panel: `DeskRequestsPage` or `TestCancellationsPage`, as they are.

Small changes to the two pages:

- **`live` (default true).** `DeskRequestsPage` and `TestCancellationsPage` call `useDeskRequestsLive()`, which opens its own live connection. The reception screen is allowed exactly one live connection (P4C-13 test 10). So inside reception they get `live={false}` and lean on the reception's own connection:
  - that connection already receives billing request signals (`useGiniflowLive` → `billing_request`);
  - the `billing_request` entry in `useGiniflowLive.js` `INVALIDATES` gains `["giniflow", "cancel-requests"]` and `["billing", "approvals-waiting"]`, so test cancellations and counts refresh live there too.

  On the `/desk-requests` page the inbox calls `useDeskRequestsLive()` **once**, not once per page, so that page holds a single connection as well.

- **Title.** The Settings pages had no page title (Settings gave it). The new top-level page gets a page header: "Desk requests", with the line "Refunds, items to add, repeat billing and test cancellations waiting for an admin." The reception tab has no extra header; the tab name says it.

## Top menu

`src/components/AppLayout.jsx` `NAV_ITEMS` gets `{ path: "/desk-requests", label: "📥 Desk requests", cap: C["/desk-requests"] }`, placed right before 🕐 Gini Flow (moved there on 19 Oct at the user's request; first built after 🏥 Reception).

- **A number, not a dot.** The menu today has only a yellow dot (`.tab-badge`) for "something new". This item shows the count, because the admin needs to know how many:
  - the existing `.tab-count` pill (amber, used by 🏥 Reception) with a new `.tab-count--alert` red variant and "99+" above 99;
  - the item's accessible name includes "3 waiting";
  - it shows on the current page too, unlike the dot, so the admin sees the queue empty out.
- `src/config/routes.js`: `"/desk-requests": [CAP.BILLING_MASTER, CAP.GINIFLOW_TEST_CANCEL_DECIDE]`. The `/settings/desk-requests` and `/settings/test-cancellations` entries stay so their forwards keep the same guard.
- `src/pages/SettingsLayout.jsx`: the Desk requests and Test cancellations tabs are removed. Their badges (`DeskRequestsBadge.jsx`, `TestCancellationsBadge.jsx`) had no other user and are deleted.

## Reception tab

`src/pages/giniflow/ReceptionStationPage.jsx`:

- `DESK_TABS` (in `BillingDesk.jsx`) gains `requests: { key: "requests", label: "Requests", tabId: "bc-tab-requests", panelId: "bc-panel-requests" }`.
- `useReceptionTab` adds it to `deskTabs`, after Refunds, only for people with either permission. Asking for `tab=requests` without it falls back to Arrivals, like the other desk tabs.
- The tab shows "Requests" plus the count in `st-tab-n`, red (`st-tab-n--alert`) when above 0, with aria-label "3 requests waiting for you".
- The panel renders `<DeskRequestsInbox live={false} />` inside the station layout, with the same padding as the Refunds panel.

## Styles and screen sizes

The two pages keep their own CSS (`deskRequests.css`, `cancelRequests.css`, `billingUi.css`, `FlowSettings.css`). Inside the reception screen they sit under `.gf`, so the build step checks that nothing clashes:

- `npm run check:giniflow` must show no new stranded styles;
- a screenshot of each tab at 1366, 768 and 390 px.

| Width   | Menu item                   | Inbox                                                                                                                             |
| ------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1366 px | in the menu with its number | tables at full width                                                                                                              |
| 768 px  | in the scrolling menu       | tables scroll inside their own box (`fset__scroll`), never the page                                                               |
| 390 px  | same                        | sub-tabs stay on one line (they scroll sideways in the tab row if needed); tables scroll inside their box; dialogs fit the screen |

The page never scrolls sideways at any of these widths.

## Not changed

- How requests are raised, approved or rejected; the decision dialogs; the request data.
- The reception Refunds tab: it still lists refunds to pay out, and its "Waiting for admin" rows stay.
- Nobody gains or loses access.

## Tests (e2e, test DB only)

New `e2e/billing/phase4b/P4B-22-desk-requests-moved.spec.js`. Fixture: one pending refund request, one pending new-item request and one pending test cancellation, created through the existing services.

1. **API counts:**
   - admin gets both counts, equal to the two lists;
   - reception_admin gets `testCancellations: null`;
   - reception and lab get 403.
2. **Menu:**
   - admin sees "📥 Desk requests" with the total, and its accessible name says how many are waiting;
   - reception sees no item;
   - reception_admin sees the item with the billing requests count only.
3. **/desk-requests as admin:**
   - both tabs, with counts;
   - Billing requests is open by default;
   - `?tab=tests` opens Test cancellations;
   - the arrow and Tab keys move between tabs;
   - the page holds exactly one live connection.
4. **reception_admin:** no tab row, the Billing requests page shows directly, and `?tab=tests` falls back to it.
5. **Old addresses:** `/settings/desk-requests` and `/settings/test-cancellations` end up on the new page, on the right tab. Settings no longer lists the two tabs.
6. **Reception tab:**
   - admin sees "Requests" with the total after Refunds;
   - opening it shows the inbox;
   - `?tab=requests&kind=tests` opens test cancellations;
   - reception doesn't see the tab, and `?tab=requests` falls back to Arrivals;
   - the reception page still holds exactly one live connection.
7. **Answering updates counts:** approve a request from the reception tab, and the tab count, the sub-tab count and the menu number all drop by one without reloading.
8. **Live:** a new request raised by another user shows on the open reception Requests tab without reloading. Realtime is off in the test environment, so this proves the poll path; live signals arrive through the reception's own connection (`BILLING_REQUEST_KEYS` in `useGiniflowLive.js`).
9. **Screen sizes 1366, 768 and 390 px:** on `/desk-requests` and the reception tab, the page never scrolls sideways, the tabs are visible, and the decision dialog fits the screen.
10. **Nothing waiting:** no number on the menu item and a grey "0" on the tabs (the test answers the counts as zero, since the shared test DB may hold other pending requests).

Existing specs that open `/settings/desk-requests` or `/settings/test-cancellations` move to the new address:

- P4-36, P4-38, P4B-11, P4B-17, P4B-19, P4C-03, G92;
- P4-36 tests 9 and 10 open `/desk-requests` and check the menu item is absent;
- P1-28 and P1-38 no longer expect the two Settings tabs; P4C-13 test 1 expects Requests for reception_admin.

Rerun all of those plus P4C-13, P4B-04, P4B-20, G91, and `npm run check:giniflow`.

## Files

- New:
  - `server/services/billing/approvalsWaiting.js`;
  - `server/routes/approvals.js`;
  - `src/queries/hooks/useApprovals.js`;
  - `src/components/billing/DeskRequestsInbox.jsx`;
  - `src/pages/billing/DeskRequestsHome.jsx` (the `/desk-requests` page);
  - `e2e/billing/phase4b/P4B-22-desk-requests-moved.spec.js`.
- Changed:
  - `server/index.js`, `server/middleware/auth.js`;
  - `src/router.jsx` (new route and the two forwards), `src/config/routes.js`;
  - `src/components/AppLayout.jsx` (menu item with count), `src/styles/App.css` (`.tab-count--alert`);
  - `src/pages/SettingsLayout.jsx` (two tabs removed);
  - `src/pages/billing/DeskRequestsPage.jsx`, `src/pages/billing/TestCancellationsPage.jsx` (`live` prop);
  - `src/queries/hooks/useGiniflowLive.js` (two keys on `billing_request`);
  - `src/components/billing/counter/BillingDesk.jsx` (`DESK_TABS.requests`), `src/pages/giniflow/ReceptionStationPage.jsx` (tab and panel);
  - the seven existing specs listed above.
