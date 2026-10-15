# 68 — Urgent cancellation of a test after the sample is collected

Status: **built 15 Oct 2026** (not committed). See §15 for where the build differs from the plan.

---

## 1. The rule (agreed with the team)

| Stage of the test                                                                               | What staff can do                                                                                              |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Ordered / payment pending / paid, sample **not** drawn                                          | Cancel directly, as today. A paid test raises a refund request (see P4B-15 and the paid-draft fix, P4B-21)     |
| Sample being drawn (lab)                                                                        | Cancel the start first (today's behaviour), then cancel directly                                               |
| **Sample collected, sent, received or processing** (lab), or test **started or done** (machine) | **No cancellation and no refund.** Only an **urgent cancellation request**, which an admin approves or rejects |
| **Report or result exists**                                                                     | **No cancellation of any kind.** No request can be raised                                                      |

When an admin approves, the test is cancelled. The patient gets back the **amount paid for the
test minus a collection charge**. The charge is a percentage (default **10%**) or a fixed amount
(default **₹50**), and the admin chooses the type and value at approval. The charge **may equal
the full amount**, meaning cancel with no refund, and it has **no GST**.

### What "collected" means in the code

- **Scribe lab order:** `giniflow_lab_orders.sample_status` is in `sample_collected`,
  `sample_sent`, `sent_outside`, `sample_received` or `processing` (rungs collected → processing
  in `shared/labStages.js`).
- **Scribe machine order:** `sample_status` is `in_progress` (Start test pressed) or `done`.
- **HealthRay case:** `CASE_STARTED_SQL` is true, meaning `sample_taken`, `sample_sent` or
  `sample_received` was marked in Scribe, or HealthRay shows the case collected or received.
  `drawing_started` alone keeps today's "cancel the start first".
- **Report exists:** for orders, `ORDER_OUTPUT_SQL` (report file, document or lab_results);
  for cases, `reported_on`, `results_synced` or lab_results. In both cases the request is refused.

These go in one shared helper, `shared/testCancelStages.js`, returning
`'direct' | 'cancel_start_first' | 'request' | 'locked'`. The server and the screens both use it
to decide which control to show.

---

## 2. Roles and permissions (`shared/permissions.js`)

| Capability                              | Held by                                                                       | Allows                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `GINIFLOW_TEST_CANCEL` (exists)         | reception, lab, lab_admin, machine_tech, echo, xray, tech, coordinator, admin | Raise an urgent request; withdraw your own pending request |
| **`GINIFLOW_TEST_CANCEL_DECIDE`** (new) | **admin only**                                                                | Approve or reject, or cancel directly with a charge        |

Deciding is **not** given to `BILLING_MASTER`, so reception admin cannot approve. After changing
the matrix, run `node server/scripts/verify-rbac.mjs`.

---

## 3. The request lifecycle

```
            raise (floor)                  approve (admin)
  [none] ───────────────► [pending] ─────────────────────► [approved]  → test cancelled, partial credit note, refund on Refunds tab
                              │  reject (admin, note)
                              ├────────────────────► [rejected]  → hold lifted, test continues
                              │  withdraw (requester or admin)
                              └────────────────────► [withdrawn] → hold lifted
```

- **Only one pending request per test.** A second attempt shows "A cancellation is already
  waiting for admin for this test".
- **While pending, the test is on hold.** Every lab and machine action on that test is refused
  with the message "Cancellation requested — waiting for admin" (see §6). Other tests on the
  same visit carry on.
- **If the report arrives while the request is pending** (for example HealthRay results sync in),
  the request is closed as `rejected` automatically with the note "Report arrived before a
  decision". The admin and the requester are notified.
- **Admin direct cancel:** an admin who opens the request form sees **Cancel now** instead of
  **Send to admin**, followed by the same charge step. It is recorded as a request created and
  approved by the admin in one transaction, so the audit trail is the same.

---

## 4. Money

1. If the test's money sits on a **paid draft**, the draft is finalised first, exactly as the
   paid-draft fix does (`finaliseBill` inside the same transaction). If finalising fails (money
   still to collect, referral missing, etc.), the approval is refused with that reason and nothing
   changes.
2. **Credit note, amount-based.** This reuses the mechanism behind discount credit notes
   (`planDiscount` / `discountFinalBill` in `creditNotes.js`, `quantity: 0`, `ONLY_PAYABLE`) with
   a new `credit_kind = 'cancel_charge'`:
   - credit = amount paid for that test line − collection charge;
   - the test line **stays** on the bill; the credit note line reads "Cancelled after
     collection — ₹C collection charge kept";
   - if credit = 0 (full charge kept), **no credit note** is made, and the cancellation and charge
     are recorded on the request only.
3. **Refund.** The credit note shows on the **Refunds** tab (`refundBoard.js` gains the new
   credit kind). Reception pays it out from the bill's refund panel exactly as today, and pays
   back only what was actually taken (`pay_back` logic of the discount credit).
4. The floor order is detached from the bill line, as a floor cancel on a final bill already does
   (`detachFinalLines`), so that cancelled test never reaches the patient's bill again.
5. **Reports.** The kept charge stays as revenue on that test line. The Refunds and credit-note
   reports list the new kind under its own label "Cancelled after collection".

### Settings (Settings → Billing → "Cancellation after collection")

| Field                | Type                             | Default    | Validation                 |
| -------------------- | -------------------------------- | ---------- | -------------------------- |
| Default charge type  | radio: Percentage / Fixed amount | Percentage | required                   |
| Default percentage   | number, %                        | 10         | 0–100, up to 2 decimals    |
| Default fixed amount | ₹                                | 50         | 0–100000, up to 2 decimals |

Storage is new `billing_settings` columns (`cancel_charge_type`, `cancel_charge_pct`,
`cancel_charge_amount`). They touch `CLEANERS`, `COLUMNS`, the zod `billingSettingsUpdateSchema`
and the GeneralCard form; changes are audited like every billing setting. Each approval stores its
own type, value and computed amount, so later setting changes don't alter past cancellations.

---

## 5. Data (one migration, `2026-11-xx_test_cancel_requests.sql`)

- `billing_requests.kind` CHECK gains **`test_cancel`**. `billing_requests_refund_only_check` is
  re-made so the refund columns stay NULL for `test_cancel`.
- New columns on `billing_requests` (NULL for other kinds, enforced by a CHECK):
  - `cancel_target` jsonb `{ kind: 'lab'|'machine'|'healthray_case', order_id?, test_id?, case_no?, test_name, stage }`
  - `charge_type` text (`'percent'|'fixed'`), `charge_value` numeric(12,2), `charge_amount` numeric(12,2)
  - `paid_amount` numeric(12,2), a snapshot of what was paid for the test at decision time
  - `reason_code` reuses the existing column, with a new list `URGENT_CANCEL_REASONS` (see §7)
- `status` CHECK gains `withdrawn`.
- A unique partial index gives one pending `test_cancel` per target:
  `(kind, (cancel_target->>'order_id'), (cancel_target->>'test_id'), (cancel_target->>'case_no')) WHERE status = 'pending' AND kind = 'test_cancel'`.
- Hold flag: `giniflow_lab_orders.cancel_request_id uuid NULL REFERENCES billing_requests(id)` for
  orders, and `giniflow_lab_case_actions` action **`cancel_requested`** for HealthRay cases. The
  action is removed (via an action row `cancel_request_closed`) when the request closes.
- `bills.credit_kind` CHECK gains `cancel_charge`.
- `billing_settings`: the 3 columns in §4.
- New timeline markers in `MARKER_STATUSES`: `cancel_requested`, `cancel_rejected`. Approval
  writes the existing `test_cancelled` marker with `meta.reason = 'urgent_after_collection'` and
  `meta.charge`.

The test DB needs `npm run test:e2e:setup` after the migration.

---

## 6. Server

### Service: `server/services/giniflow/cancelRequests.js`

| Function                                    | What it does                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancelStageOf(client, target)`             | Reads the order or case and returns the stage from §1                                                                                                                                                                                                                                                                                                                        |
| `raiseCancelRequest(input, ctx)`            | Validates input; locks the order or case; requires stage = `request`; inserts the request; sets the hold; writes `cancel_requested`; calls `announceRequest('created')` **after commit**                                                                                                                                                                                     |
| `withdrawCancelRequest(id, ctx)`            | Requester or admin; pending only; clears the hold                                                                                                                                                                                                                                                                                                                            |
| `approveCancelRequest(id, input, ctx)`      | Admin; locks the request (`FOR UPDATE`) and the order; re-checks the stage (no report since); finalises a paid draft if needed; computes the charge; cancels the test (`cancelTestIn` with a new `allowCollected` flag so the stage guard is skipped for this path only); makes the partial credit note; marks the request approved; clears the hold; all in one transaction |
| `rejectCancelRequest(id, { note }, ctx)`    | Admin; note required; clears the hold; writes `cancel_rejected`                                                                                                                                                                                                                                                                                                              |
| `closeOnReport(client, orderId \| caseNo)`  | Called where a report or result is saved: auto-rejects a pending request                                                                                                                                                                                                                                                                                                     |
| `cancelHeld(client, { orderId \| caseNo })` | Throws `409 code:'cancel_pending'` when on hold; used by every guard below                                                                                                                                                                                                                                                                                                   |

**Charge maths** (all in paise, integers):

- `paid = what was actually paid for this test line` (the line's patient_payable, capped by the
  bill's taken amount);
- percent: `charge = round(paid × pct / 100)`;
- fixed: `charge = min(value, paid)` is **not** applied silently. A fixed value above `paid` is
  refused with "The charge can't be more than ₹paid";
- `refund = paid − charge`.

### Where the hold is enforced (each already locks the row first)

- `labStation.advanceSample` (send, receive, processing, results ready, upload via
  `uploadReport`)
- results entry `POST /giniflow/lab/:orderId/results`
- `uploadOutsideReport`, `markCaseSentOutside`, `uploadOutsideCaseReport`
- `markLabCaseAction` and `uploadLabCaseReport` (HealthRay cases, keyed by `case_no`)
- `machineStation.advanceMachineTest`, machine report upload and `addExtraReport`
- `TESTS_HOLD_SQL` (the doctor's "waiting for tests" clock) counts an on-hold test as **still
  open**, so the patient isn't sent onward as if it were done

### Routes

| Method & path                                                               | Gate                        | Body (zod)                                                                                                                  |
| --------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/giniflow/tests/cancel-stage?orderId=&testId=&caseNo=`             | GINIFLOW_TEST_CANCEL        | — returns `{ stage, paid, testName, defaults }`                                                                             |
| `POST /api/giniflow/tests/cancel-requests`                                  | GINIFLOW_TEST_CANCEL        | `{ target:{orderId?,testId?,caseNo?,patientId?,date?}, reason_code, note? }`                                                |
| `POST /api/giniflow/tests/cancel-requests/:id/withdraw`                     | GINIFLOW_TEST_CANCEL        | `{}`                                                                                                                        |
| `GET /api/giniflow/tests/cancel-requests?status=&q=&from=&to=&page=&limit=` | GINIFLOW_TEST_CANCEL_DECIDE | — **server-side** filter, search (patient name, UHID, test), date range, pagination; returns `{ rows, total, page, limit }` |
| `POST /api/giniflow/tests/cancel-requests/:id/approve`                      | GINIFLOW_TEST_CANCEL_DECIDE | `{ charge_type, charge_value, note }`                                                                                       |
| `POST /api/giniflow/tests/cancel-requests/:id/reject`                       | GINIFLOW_TEST_CANCEL_DECIDE | `{ note }`                                                                                                                  |
| `POST /api/giniflow/tests/cancel-now`                                       | GINIFLOW_TEST_CANCEL_DECIDE | `{ target, reason_code, note?, charge_type, charge_value }`                                                                 |

### Validation (server, zod plus service checks; messages say how to fix)

| Field               | Rule                                                                     | Message                                                                 |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| target              | exactly one of orderId(+testId) or caseNo(+patientId, date); valid UUIDs | "This test is no longer on the list"                                    |
| reason_code         | one of `URGENT_CANCEL_REASONS`                                           | "Pick why this test must be cancelled"                                  |
| note                | required when the reason is `other`, 3–300 characters                    | "Say why — at least 3 characters"                                       |
| charge_type         | `percent` or `fixed`                                                     | "Choose a percentage or a fixed amount"                                 |
| charge_value        | percent 0–100 (2 dp); fixed 0–paid (2 dp)                                | "Enter a percentage from 0 to 100" / "The charge can't be more than ₹X" |
| approve/reject note | required, 3–500 characters                                               | "Write a short note for the record"                                     |
| stage               | must be `request` (raise) and still not `locked` (approve)               | "A report is already on this test — it can't be cancelled"              |
| duplicates          | unique pending index (23505 → 409)                                       | "A cancellation is already waiting for admin for this test"             |
| state               | approve, reject or withdraw only when pending                            | "This request was already answered by NAME at TIME"                     |

Errors never show SQL or internal names (`run()` wrapper as for other routes).

---

## 7. Screens (existing components and design tokens; no new UI library)

### 7a. Station control (Lab Collection, Lab Processing, Machine Room, Reception Payments)

`CancelTestControl` gets a `stage` prop from the server (`direct | cancel_start_first | request | locked`):

| stage                | What the screen shows                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direct`             | Today's cancel form, unchanged                                                                                                                                                                                  |
| `cancel_start_first` | Today's message, unchanged                                                                                                                                                                                      |
| `request`            | Button **"Request urgent cancellation"** (secondary, not red)                                                                                                                                                   |
| `locked`             | No button; muted text "Report is out — cannot be cancelled"                                                                                                                                                     |
| pending              | Badge **"⏸ Cancellation requested — waiting for admin"** (icon + text, not colour alone); action buttons for that test disabled with the same text as the tooltip; requester and admin see **Withdraw request** |

**Request form** (inline panel on desktop, bottom sheet under 640px):

| Field   | Control                                                                                                                                       | Required       | Validation                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------- |
| Patient | read-only: name, UHID, age/sex                                                                                                                | —              | —                                                    |
| Test    | read-only: name, stage reached ("Sample collected 14:22"), price paid                                                                         | —              | —                                                    |
| Reason  | select: Patient left (emergency) · Doctor withdrew the test · Wrong test ordered · Duplicate test · Sample unusable — will not repeat · Other | yes            | must pick                                            |
| Note    | textarea, 300 chars, counter                                                                                                                  | only for Other | ≥3 chars                                             |
| Notice  | "No refund unless an admin approves. If approved, a collection charge is kept."                                                               | —              | —                                                    |
| Actions | **Send to admin** (primary) · Cancel                                                                                                          | —              | disabled until valid; shows "Sending…" while sending |

For an admin the primary action is **Cancel now…**, which opens the decision step (7b) directly.

### 7b. Admin decision (new tab "Test cancellations" on the existing Requests page, `/settings/desk-requests`)

**List (server-side search, filter and pagination):**

- Filters: Status (Waiting · Approved · Rejected · Withdrawn), date range (default today), search
  "Search by patient name, UHID or test".
- Columns: Asked (time, who, station) · Patient (name, UHID) · Test (name, stage) · Paid ·
  Reason · Status · Action.
- Waiting rows are sorted oldest first, with an **Answer** button. The tab badge shows the
  waiting count, live through the existing billing-request realtime channel (15s poll fallback).
- Under 900px the table becomes stacked cards with the same fields.
- Empty: "No cancellation requests waiting" / "No requests match these filters [Clear filters]".
- Error: "Unable to load cancellation requests. Please try again. [Try again]".

**Decision dialog (focused dialog, keyboard accessible):**

| Section                             | Content                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Who and what                        | Patient name, UHID, bill no., test, stage reached and time, requester and station, reason and note                                             |
| Collection charge                   | Radio **Percentage / Fixed amount**, pre-filled from Settings; value input with % or ₹ suffix; switching the type re-fills that type's default |
| Summary (live, right-aligned money) | Paid ₹X · Collection charge −₹C · **Refund ₹R** · if R = 0: "No refund — full charge kept"                                                     |
| Note                                | required, 500 chars                                                                                                                            |
| Actions                             | **Approve and cancel test** (primary) · **Reject** (secondary, destructive style) · Close                                                      |

Confirm step on Approve repeats: "Cancel **HbA1c** for **Kuldeep Singh (P_182211)**. Keep ₹50,
refund ₹450 on bill GH26-000140. The test stops and can't be restarted." Buttons:
**Confirm** / Back. Reject confirms with the note only.

Validation runs on the client (same rules as §6) and again on the server. Errors appear under the
field and are linked with `aria-describedby`. Buttons show "Approving…" or "Rejecting…" and
prevent double submission. After success, a toast plus the row's status update; the result is
also shown in the dialog's final state.

### 7c. Bill and refunds

- **Bill refund panel** (`BillRefunds.jsx`): the new credit kind is listed as "Cancelled after
  collection — HbA1c · ₹50 kept · Refund ₹450", with the usual **Pay out** button.
- **Refunds tab** (`RefundsBoard`): new rows appear under "To pay" with the label "Cancelled
  after collection".
- **Credit-note PDF**: the line reads "HbA1c — cancelled after collection (collection charge
  ₹50 kept)".

### 7d. Timeline (Flow Manager visit timeline)

- "Cancellation requested — HbA1c · Patient left (emergency) · by Lab 1"
- "Test cancelled — HbA1c · Urgent after collection · ₹50 kept · approved by Admin", or
  "Cancellation rejected — HbA1c · <note>"

### 7e. Settings → Billing

A new card, **"Cancellation after collection"**, holds the three fields from §4 with labels,
helper text ("Pre-filled when an admin approves; they can change it"), inline validation and the
existing save/loading/error pattern.

---

## 8. Realtime and notifications

- Raising, withdrawing or deciding calls `announceRequest` after commit. The admin's Requests badge
  and the requester's station refresh live.
- The station card shows the decision on its next refresh (≤15s), with no page reload.

---

## 9. Audit

Every step writes to `billing_audit` (request created, withdrawn, approved, rejected; credit note;
settings change) and to the visit events. Each record shows who, when, the reason, the charge
type and value, the amounts and the previous and new state.

---

## 10. Tests (Playwright, test DB `localhost:5435` only)

File: `e2e/giniflow/G91-cancel-after-collection.spec.js` (API and service), plus
`e2e/giniflow/G92-cancel-after-collection-ui.spec.js` (screens).

**Stage rules**

1. A paid lab test not yet drawn: `stage = direct`; the cancel works as today.
2. Drawing started: `cancel_start_first`.
3. Lab `sample_collected`, `sample_sent`, `sample_received`, `processing`: `stage = request`;
   direct cancel is refused (409).
4. Machine `in_progress` and `done`: both `request`; direct cancel refused.
5. HealthRay case with `sample_taken`: `request`; with `reported_on` or results: `locked`.
6. Any report, document or lab_result: `locked`; raising a request is refused.

**Request and hold** 7. Raising a request sets the hold. `advanceSample` (send), results entry, report upload and
`advanceMachineTest` are refused with `cancel_pending`. Another test on the same visit still
advances. 8. A second request for the same test is refused, including a parallel race where only one
succeeds. 9. Withdraw by the requester lifts the hold; withdraw by another non-admin is refused. 10. A report arriving while pending auto-rejects the request with "Report arrived before a
decision". 11. Validation: missing reason, Other without a note, unknown reason, bad target id — each gives
a 400 with the message from §6.

**Decision and money** 12. Approve with the 10% default on a ₹500 final paid bill: charge ₹50, credit note ₹450
(`credit_kind = cancel_charge`), the line stays live, the order is detached, the test is
cancelled, the hold is cleared, and the Refunds tab shows ₹450 to pay. Pay out ₹450 and the
bill balances. 13. Approve with fixed ₹50 on a ₹40 test is refused ("can't be more than ₹40"); fixed ₹40 means
no credit note, test cancelled, "No refund — full charge kept". 14. Approve on a **paid draft**: the draft is finalised first, then as test 12. 15. Approve when the draft still owes money: refused with the finalise reason; nothing changed. 16. Reject: note required; the hold is lifted; the test then advances normally; the timeline
shows "Cancellation rejected". 17. Two admins approving at once: one succeeds, the other gets "already answered". 18. Percent value outside 0–100, a negative value or 3 decimals are each refused. 19. The settings defaults change, and a past approval's stored charge stays the same.

**Permissions** 20. Reception, lab and machine_tech can raise but get 403 on approve, reject and cancel-now. 21. reception_admin (BILLING_MASTER) gets **403** on approve. 22. The admin cancel-now creates an approved request in one step with the same money result as
test 12.

**Screens** 23. Lab Collection: a collected test shows **Request urgent cancellation**; the form requires a
reason (and a note for Other); after sending, the badge "Cancellation requested — waiting
for admin" shows and **Send to lab** is disabled. 24. Machine Room: same for a started and for a done machine test. 25. Admin Requests → Test cancellations: the waiting row appears live; search by UHID and the
status filter go to the server (checked via the request URL); pagination moves pages. 26. The decision dialog: switching % and ₹ re-fills the defaults; the summary updates; a charge
above paid shows the field error and disables Approve; the confirm step names the patient,
test and amounts; after approval the row shows Approved. 27. Phone width (390px): the request form opens as a bottom sheet, the list shows cards, and all
actions can be reached with the keyboard. 28. Settings → Billing: the new card saves, validates (101% refused) and shows the saved value
after a reload. 29. Timeline shows the requested, cancelled or rejected markers with the right text.

**Regression:** run the existing P4B-15, P4B-18, P4B-21, G58, P4C-07, P4-36 and P4B-11, plus the
full `e2e/billing` and `e2e/giniflow` suites.

---

## 11. Build order (each step tested before the next)

1. Migration + `shared/testCancelStages.js` + stage tests (1–6).
2. Raise, withdraw and hold guards + tests 7–11.
3. Approve and reject + the partial credit note + Refunds tab + tests 12–19.
4. Permissions + tests 20–22; `verify-rbac.mjs`.
5. Station UI + tests 23–24, 27.
6. Admin tab + decision dialog + tests 25–26.
7. Settings card + test 28; timeline + test 29.
8. Full regression, `npm run build`, `npm run check:giniflow`, Prettier.

---

## 12. Gaps found in review and how this plan covers them

| Gap                                                                      | Covered by                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Credit notes are quantity-based; "price − charge" needs an amount credit | New `credit_kind = 'cancel_charge'` on the discount-credit mechanism (§4)           |
| A separate charge bill would need a new payment mode                     | Not used; the charge stays on the test line (decision 2)                            |
| No hold exists anywhere                                                  | Hold column/action plus the guard list (§6)                                         |
| The cancel button disappears after collection                            | `stage` prop and the request control (§7a)                                          |
| Floor roles lack BILLING_DESK                                            | New routes gated by GINIFLOW_TEST_CANCEL; deciding by the new admin-only capability |
| Today's Requests history is capped at 200 and filtered on the client     | The new tab uses a server-side, paginated endpoint (§6, §7b)                        |
| No `version` column on requests                                          | Row lock + pending check + unique pending index; race test 17                       |
| A report can arrive while waiting                                        | Auto-reject (§3, test 10)                                                           |
| Done tests need an admin note in `creditNoteIn`                          | The approval note is required anyway and is passed through                          |
| Realtime is skipped inside a caller's transaction                        | `announceRequest` after commit                                                      |
| The doctor's tests-hold clock could treat an on-hold test as done        | `TESTS_HOLD_SQL` counts it as open                                                  |

## 13. Decisions (15 Oct 2026)

1. Collection charge defaults: **10%** or **₹50** fixed; the admin picks the type and value at approval.
2. The charge is kept on the test line via a **partial credit note** (`cancel_charge`), not a separate bill.
3. **No GST** on the charge.
4. The charge **may equal the full amount** (cancel with no refund).
5. **Admin only** approves or rejects; floor roles (lab, machine, reception) can request; an admin can cancel directly.
6. Machine tests follow the same rule once **Start test** is pressed; nothing after a report.
7. While waiting, the test is **on hold**.
8. HealthRay cases are cancelled **in Scribe only**.
9. The refund is paid out through the **Refunds tab** as today.

## 14. Still to confirm before building

- **Reason list** in §7a: are those six reasons right for the floor?

## 15. As built

The build follows this plan except where listed here.

**Changes from the plan**

- **Hold.** There is no `cancel_request_id` column on orders. A test is held while a `pending`
  `test_cancel` request exists for its `cancel_key` (`order:<id>:<test|all>` or
  `case:<case_no>`). The key is unique among pending requests, so the hold can't drift from the
  request. `server/services/giniflow/cancelHold.js` holds the guard and the SQL used by the
  stations.
- **Guards.** These are added in:
  - `advanceSample`, which also covers `uploadReport` and `uploadOutsideReport`;
  - `saveResults`;
  - `markLabCaseAction`, `markCaseSentOutside` and `uploadLabCaseReport`;
  - `advanceMachineTest`, `cancelMachineStart` and `addExtraReport`.
- **Report arriving while a request waits.** The request is not rejected automatically. If a
  report arrives first, approval is refused with "A report arrived on this test, so it can't be
  cancelled now — reject the request". Scribe's own report and result screens can't save while
  the test is held.
- **Reason storage.** The urgent reasons are stored in `billing_requests.cancel_reason_code`. The
  refund-only `reason_code` column is left alone.
- **Settings.** The defaults are `billing_settings.cancel_charge_type`, `cancel_charge_pct` and
  `cancel_charge_amount`.
- **A test on two bills.** Approval is refused with "This test is on more than one bill — refund
  it from the Billing Counter instead".
- **Routes.** These live under `/api/giniflow/tests/…` (`server/routes/testCancelRequests.js`).
  Raising a request needs `GINIFLOW_TEST_CANCEL`; listing, deciding and cancel-now need the new
  admin-only `GINIFLOW_TEST_CANCEL_DECIDE`.
- **Admin screen.** It is Settings → **Test cancellations** (`/settings/test-cancellations`),
  with a waiting-count badge.
- **Tests.** `e2e/giniflow/G91-cancel-after-collection.spec.js` (15 service and API tests) and
  `e2e/giniflow/G92-cancel-after-collection-ui.spec.js` (6 screen tests).

**Open point:** the Machine Room's existing **Cancel start** button still works on a started
machine test that has no request pending. It is meant for a mistaken press of Start. It can also
be used to return the test to "paid" and then cancel it directly with a full refund.
