# 68 — Cancelling a test after the sample is collected

Status: **plan, decisions settled 15 Oct 2026, waiting for the go-ahead to build**. Nothing is built yet.

## 1. The rule (agreed with the team, 15 Oct 2026)

- Once the sample is **collected** (the barcode is printed in HealthRay's lab), the test is
  normally **not cancelled and not refunded**.
- The only exception is an **urgent** case. Staff raise a **cancellation request**, an **admin
  approves or rejects it**, and if it's approved the patient gets back the price **minus a
  collection charge**.
- The same rule applies to **machine tests** (Fundus, VPT, ABI, ECG…) once **Start test** has
  been pressed.
- Once a **report or result exists**, there is **no cancellation at all**, urgent or not.

"Collected" means any of these:
- in Scribe, the sample is drawn, sent or received, or a machine test has started or finished;
- in HealthRay, the case shows collected, received or reported, or results have arrived.

These are the same signals that block cancelling today (`CASE_STARTED_SQL`,
`CANCELLABLE_ORDER_STATUSES`). Before collection, nothing changes: cancelling is direct, and any
refund goes through the existing refund request (see plan 67 and the paid-draft fix).

## 2. Who does what

| Role | Can |
|---|---|
| Lab (collection / processing) | Raise a request for a lab test |
| Machine Room | Raise a request for a machine test |
| Reception | Raise a request for any test on the visit (Payments tab) |
| Admin | Raise **and** approve in one step, or approve/reject others' requests |

New capabilities in `shared/permissions.js`:
- `giniflow.cancel_request.create`: lab, machine, reception, admin.
- `giniflow.cancel_request.decide`: admin only.

These capabilities are checked on the server and in the UI.

## 3. The flow

1. **Request.** The cancel button on a collected test opens **Urgent cancellation request**. It
   shows the patient (name, UHID), the test, its price and its current stage, and asks for a
   reason. Reasons come from a fixed list plus "Other" with a note, and the reason is required.
   Staff then submit it.
2. **On hold.** The test is put **on hold**:
   - the station card shows "Cancellation requested — waiting for admin";
   - Start, Collect, Send and the report upload are disabled for that test;
   - other tests on the visit are not affected.
3. **Admin decides** on the Requests page (the same page as today's refund requests, with a new
   "Cancellation" kind). The panel shows:
   - patient, bill number, test, price paid, the stage it reached, the requester, the reason
     and the time;
   - **Collection charge**: choose **Percentage** or **Fixed amount**, pre-filled from the
     Settings default for that choice;
   - a live summary: "Refund ₹X · Charge kept ₹Y · Paid ₹Z". The charge can never be more than
     what was paid. If the charge equals what was paid, the summary says "No refund — full
     charge kept";
   - **Approve** and **Reject** buttons, each requiring a note. Before approving, the confirm
     step repeats the patient, test, refund and charge.
4. **Approved:**
   - the test is cancelled (reason recorded as urgent-after-collection, with the approver);
   - the bill is finalised first if it is still a paid draft (as the paid-draft fix already
     does);
   - a **refund** for the refund amount is raised and waits on the **Refunds** tab. Reception
     pays it out from there as today, and the credit note shows the line, the collection
     charge kept, and the amount refunded;
   - the hold is lifted and the test leaves the station queues;
   - for a HealthRay case, Scribe records the cancellation **in Scribe only**, as decided. The
     HealthRay case is not touched.
5. **Rejected:** the hold is lifted, the test carries on as normal, and the requester sees the
   admin's note.

## 4. Settings

These go in Settings → Billing, under a new **Cancellation after collection** section:
- **Default charge type**: Percentage / Fixed. Default: Percentage.
- **Default percentage**: **10%**.
- **Default fixed amount**: **₹50**.
- **GST on the charge**: none, because it is exempt like other medical services.

Every approval stores the type, the value and the computed charge, so later changes to these
settings don't alter past refunds.

## 5. Data (one migration)

- `billing_requests.kind` gains **`test_cancel`**. A new nullable column `cancel_target` (jsonb)
  holds `{ orderId, testId?, caseNo?, kind, stage }`. On decision we also store
  `charge_type`, `charge_value` and `charge_amount`.
- The hold uses a `hold_request_id` column on `giniflow_lab_orders`, plus a
  `giniflow_lab_case_actions` action `cancel_requested` for HealthRay cases. The station queues
  read these to show the hold and disable actions.
- **Credit note with a charge kept**: today a refund always credits whole lines. Two ways to
  return price − charge:
  - **(a), chosen:** credit the full line and add a separate **"Collection charge (test
    cancelled after collection)"** service item on a small new bill. The accounts stay simple
    and the charge shows up in reports like any other service. This needs one service item in
    the master, with no GST.
  - (b), not chosen: a "retained amount" on the credit note, which would touch the credit-note
    maths, GST and every report that reads credits.
- Everything is written to `billing_audit` and to the visit events, so the timeline shows
  "Cancellation requested", then "Cancelled — admin approved, ₹Y kept" or "Cancellation
  rejected".

## 6. API

| Method | Path | Who |
|---|---|---|
| POST | `/api/giniflow/tests/cancel-requests` `{ target, reason, note }` | create capability |
| GET | `/api/billing/requests?kind=test_cancel&status=pending&page=` | decide capability (server-side filter, search, pagination; extends the existing list) |
| POST | `/api/billing/requests/:id/approve` `{ charge_type, charge_value, note, version }` | decide capability |
| POST | `/api/billing/requests/:id/reject` `{ note }` | decide capability |

The service lives in `server/services/giniflow/cancelRequests.js`. It reuses `cancelTestIn`,
`refundCancelledTest` and the paid-draft finalise, all inside one transaction.

Rules enforced on the server:
- the test must be collected and have no report;
- only one open request per test;
- the charge is between 0 and the amount paid;
- the request's version is checked so two admins can't approve the same one twice.

## 7. UI

- **Stations** (Lab collection/processing, Machine Room, Reception Payments): the existing
  `CancelTestControl` switches to "Request urgent cancellation" when the test is collected or
  started. The on-hold card shows a "Cancellation requested" badge with text, not colour
  alone.
- **Admin Requests page**: a new "Cancellation" filter on the existing page, with the decision
  panel described in §3.
- Both work at small widths, with labels on every field and the existing loading, empty and
  error states.

## 8. Tests (Playwright, test DB only)

1. Before collection, cancelling is direct, as today.
2. Collected lab test: staff can only request; the test is put on hold; Collect, Send and Upload
   are refused while it's on hold.
3. Admin approves with a percentage: the test is cancelled, the refund equals price − %, the
   charge bill is made, and the credit note is correct.
4. Admin approves with a fixed amount: same as 3.
5. A charge greater than the amount paid is refused.
6. Reject: the hold is lifted, the test continues, and the requester sees the note.
7. Once the report exists, the request button is not offered and the API refuses.
8. Machine test after Start: same rule as a lab test.
9. HealthRay case collected in HealthRay: the request works, and the cancel happens in Scribe
   only.
10. Permissions: lab, machine and reception can request but can't decide; admin can do both.
11. Two admins approving the same request: only one succeeds.
12. A paid draft is finalised before the refund (reuses P4B-21).

## 9. Decisions (15 Oct 2026)

1. Default charge: **10%**, or **₹50** fixed. The admin picks the type and can change the value
   at approval.
2. The charge is billed as a **separate "Collection charge" line** on its own bill; the test line
   is credited in full.
3. **No GST** on the collection charge.
4. The charge **may equal the full amount paid**, which means the test is cancelled with no
   refund. The approval summary then says "No refund — full charge kept".
