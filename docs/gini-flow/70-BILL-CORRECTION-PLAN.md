# 70 — Correcting a final bill (credit and re-issue)

Status: **decided 17 Oct 2026** (§9). Not built yet.

## 1. The problem

A final bill sometimes carries the wrong amount, category, consultant or patient. Today the
desk has three tools, and none of them gives the patient one clean, correct bill:

| Tool                              | Where                                               | What it does                                                    |
| --------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| Cancel an unpaid bill             | `bills.js` `cancelBill()` (P4-14)                   | Only when no money was ever taken                               |
| Refund / discount after final     | `creditNotes.js` `creditNoteIn()`, `discountFinalBill()` | A credit note against the bill; the bill keeps its full amount |
| Consultant change after final     | `consultantChange.js` `confirmConsultantChange()`  | Credits the old consult and re-bills the new one, money moves as a deposit |

The trigger case was GH26-000204 (₹1,500 billed, ₹1,100 correct). The fix is general; nothing
here is specific to that bill.

## 2. Why the current restrictions exist

| Rule                                              | Location                                              | Reason                                                                                                                         | Still valid?                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| A final bill can't be edited                      | `bills.js:602` `assertDraft()`                        | A final bill is a GST tax invoice; its number, lines and totals are what the patient holds                                    | **Yes — keep**                                                                                       |
| No cancel when a credit note exists               | `bills.js:1979–1987`                                  | Cancelling would reverse the bill a second time on top of the credit note, double-counting in reports                          | **Yes — keep**                                                                                       |
| No cancel once money was taken                    | `bills.js:1989–1990`, `takenOn()` at `bills.js:476`   | Written in P4-14 "because refunds do not exist yet" (52-BILLING-TASKS §P4-14). A cancel would leave the cash with no bill     | The stated reason is gone (refunds, credit notes, deposits exist), but the risk it guards is real    |
| Audit log is append-only                          | `2026-10-10_billing_settings_audit.sql:67–80`         | Accountability                                                                                                                 | **Yes — never touched**                                                                              |
| Credit-note, payment-direction and credit-line guards | `2026-10-22_billing_refunds.sql` triggers (`bills_credit_note_guard`, `payments_direction_guard`, `bill_lines_credit_guard`) | A credit note can't exceed its bill; cash out needs a shift                       | **Yes — keep**                                                                                       |
| Gap-free numbering                                | `billNumber.js` `nextNumber()`                        | Series row locked `FOR UPDATE` inside the finalising transaction, so no number is burnt                                         | **Yes — keep**                                                                                       |

**Risks of loosening "cancel a paid bill":**

1. **Orphaned cash.** The receipt stays on the shift; a cancelled bill no longer explains it,
   and the GST register shows ₹0 for money that was banked.
2. **Double reversal.** `reports.js` already subtracts credit notes (`SIGN`, line 30) and
   lists cancelled bills separately (line 987). A bill that is credited and then cancelled
   would be taken out of the totals twice.
3. **Race.** A payment or payout landing between the "nothing held" check and the cancel.
4. **Lost link.** The replacement bill has no recorded tie to what it replaces.

## 3. Recommendation

**Do not allow cancelling a paid or credited bill.** GST already has the right instrument for
"this invoice was wrong after it was issued": a **credit note**. Cancellation stays what it is
today — voiding an invoice that never had money on it.

Instead, add one workflow, **Correct bill**, which is the consultant-change pattern made
general:

1. A **full credit note** reverses the wrong bill (credit_kind `correction`). The original bill
   keeps its number, lines, receipt and history.
2. The money held on it moves to the patient's **deposit** — a ledger entry, not cash. No cash
   leaves or enters any drawer.
3. A **replacement bill** is created as a normal draft on the same visit (same `bill_date` as
   the visit, which is what `openDraft` already does — never a back-dated time), with the
   corrected lines, and is linked to the original (`replaces_bill_id`).
4. The deposit is **applied** to the replacement through `applyDepositIn()`. Whatever is left
   over stays in the deposit or goes to the Refunds board for an admin-approved payout,
   exactly as `confirmConsultantChange()` does with `leftover`.
5. The replacement is finalised with a new number from the normal series.

The patient is handed the replacement bill (and, if asked, the credit note). Every rupee is
still traceable: receipt → original bill → credit note → deposit → replacement bill.

### Accounting effect

| Entry                    | GST register         | Cash drawer | Deposit ledger |
| ------------------------ | -------------------- | ----------- | -------------- |
| Original bill (stays)    | +₹1,500              | +₹1,500 (already) | —        |
| Correction credit note   | −₹1,500              | —           | +₹1,500        |
| Replacement bill         | +₹1,100              | —           | −₹1,100        |
| Leftover                 | —                    | −₹400 only if an admin approves a cash payout | −₹400 if paid out, else stays |

Net revenue ₹1,100, the GST register balances, and no shift is touched unless real cash goes
back.

### Bills that already have a partial credit note

A correction credits only what is **left** on the bill (`line.original − line.credited`, the
same arithmetic `planDiscount()` uses). Earlier credit notes and their payouts stay as they
are. For GH26-000204 that is ₹1,100 left after CN26-000006; the correction would credit
₹1,100 to deposit and the ₹1,100 replacement would use it, leaving ₹0. (The ₹400 payout
already recorded stays on its shift.)

## 4. Test entries and entries made in error

The system can't know whether a transaction was "only a test". This plan never treats one
differently on someone's word:

- The correction form has a required reason code: `wrong_rate`, `wrong_category`,
  `wrong_patient`, `wrong_item`, `entered_in_error`, `other` (note required for `other` and
  `entered_in_error`).
- `entered_in_error` does **not** skip any step. If no money was really taken, the receipt is
  still on record; the correction moves it to deposit, and the leftover is **written off at
  the shift close** as a counted difference with the reason — which is the honest record of a
  receipt that was never real. There is no "delete receipt".
- Production carries no test mode. Test runs belong on the e2e database
  (`localhost:5435/gini_scribe_test`).

## 5. Authorisation and audit

- New capability **`BILLING_CORRECT`** in `shared/permissions.js`, granted to **admin only**,
  enforced on the route and in the service, and gating the client button.
- **Maker–checker:** the desk **requests** a correction (`billing_requests.kind =
  'bill_correction'`, status `pending`), an admin **approves** it. The approver can't be the
  requester (same rule `confirmConsultantChange()` applies). Admin may raise and approve their
  own only when no one else holds the capability — off by default; decision §9.3.
- **Verified money:** approval shows the receipts, payouts and deposit movements on the bill,
  and the approver ticks "I have checked what was really collected" (stored, audited).
- **Audit:** every step writes `billing_audit` through `writeAudit` — request create,
  approve/reject, credit note create, deposit restore, replacement create/finalise, deposit
  apply — all with the request id, so one query shows the whole correction.

## 6. Data changes (one migration, `2026-11-30_bill_corrections.sql`)

- `bills.replaces_bill_id UUID REFERENCES bills(id) ON DELETE RESTRICT` — on invoices only;
  unique where not null (one live replacement per bill).
- `bills_credit_kind_check` gains `'correction'`.
- `billing_requests`: kind `bill_correction`; columns `correction_reason_code`,
  `correction_lines JSONB` (the corrected lines as item ids + quantities, priced at approval),
  `money_checked BOOLEAN`.
- Unique partial index: one **pending** correction per bill.
- Additive only; existing rows unaffected; no backfill. Roll back = stop using it (the
  columns are nullable).

## 7. Server

- `server/services/billing/billCorrection.js`
  - `requestCorrection(billId, input, ctx)` — final invoice, not a credit note, not
    cancelled, no pending correction, CGHS claim not `cleared`; reason required; corrected
    lines priced through `priceBill()` for preview only.
  - `previewCorrection(requestId)` — credit amount (what is left), held money, replacement
    total, deposit after, leftover.
  - `approveCorrection(requestId, { version, leftover: 'deposit'|'refund', money_checked, note }, ctx)`
    — one transaction: lock the original and its credit notes and the patient's deposit
    account (`lockAccount()`), recheck the version and that nothing moved since the preview
    (409 otherwise), `creditNoteIn()` for everything left, `restoreToDeposit()`, `openDraft()`
    + `addLineIn()` for the corrected lines with `replaces_bill_id`, `finaliseBill()`,
    `applyDepositIn()`, leftover → deposit or a refund request (as `consultantChange.js`).
  - `rejectCorrection`, `withdrawCorrection`.
- Routes under `routes/billing.js`: `POST /bills/:id/corrections`,
  `GET /corrections/:id/preview`, `POST /corrections/:id/approve|reject|withdraw` — validated
  with Zod schemas in `schemas/index.js`.
- `billPdf.js`: the replacement prints "Replaces bill GH26-…"; the original's view lists
  "Corrected by GH26-…".
- **Not changed:** `assertDraft()`, `cancelBill()`'s credit-note and money guards, the audit
  trigger, numbering.

## 8. Screen

- Counter (`BillActions.jsx`): on a final bill, **Correct bill…** for the desk (raises a
  request) and the admin (raise or approve). Hidden on credit notes, cancelled bills and when
  one is pending ("Correction waiting for admin").
- Dialog: patient + UHID + bill no., current lines, corrected lines (item picker reused from
  the counter), reason, live preview (credit, replacement total, deposit after, leftover),
  explicit confirm text: "Credit GH26-000204 in full (₹1,100), issue a new bill for ₹1,100 paid
  from deposit. The old bill stays on record."
- Admin list: Settings → Billing → Corrections (pending / approved / rejected), same shape as
  the Refunds board.

## 9. Decisions (17 Oct 2026, the recommendations taken)

1. The desk raises a correction; an admin approves it.
2. Leftover defaults to the deposit; the approver may send it to the Refunds board instead.
3. No self-approval: the approver can never be the requester.
4. A bill with any CGHS claim (pending or cleared) is not eligible in this version.

## 10. Tests (Playwright, test DB)

`e2e/billing/phase4d/P4D-01…`

1. **Unpaid final bill:** correction credits ₹0 held, replacement finalised, original
   unchanged and still numbered; cancel still works as before.
2. **Paid bill:** ₹1,500 paid, corrected to ₹1,100 → credit note ₹1,500, deposit +₹1,500 then
   −₹1,100, leftover ₹400 in deposit; no `payments` row with `direction = 'out'`; shift
   expected cash unchanged.
3. **Leftover as refund:** leftover goes to the Refunds board as a pending request; no cash
   until payout.
4. **Already part-credited:** CN for ₹400 exists → correction credits ₹1,100 only; totals
   reconcile; old CN untouched.
5. **Fully refunded bill:** nothing left → refused "Nothing is left on GH26-… to correct".
6. **Credit-note / cancelled / draft bill:** refused with words.
7. **Duplicate request:** second pending request on the same bill → 409; unique index holds
   under a hand-written insert.
8. **Concurrent approve:** two admins approve at once → one succeeds, one gets "already
   approved"; exactly one credit note, one replacement, one audit chain.
9. **Payment races approval:** a payment taken after preview → approve refuses (version).
10. **Rollback:** a failure at `finaliseBill()` (missing series) leaves no credit note, no
    deposit entry, no draft, no number burnt.
11. **Maker–checker:** requester can't approve; reception can't approve (403); button hidden
    without `BILLING_CORRECT`.
12. **Numbering:** credit note and replacement take the next numbers with no gap; original's
    number unchanged.
13. **Audit:** every step present with the request id; audit rows can't be updated (trigger).
14. **Print:** replacement PDF says "Replaces bill …"; original's says "Corrected by …".
15. **Reports:** GST register and day collection after a correction equal the corrected
    amount, not the sum of both bills.
16. **Production guard:** the service refuses `approve` without an `actorId`; no script path
    bypasses the request.

## 11. Scope recommendation

Support **every eligible final invoice** through the request-and-approve flow, not a list of
named bills. Eligibility is the rule set in §7 (`requestCorrection`); there is no per-bill
override and no script that skips the request.
