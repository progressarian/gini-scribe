# 61 — Patient deposits

Status: **all four phases built** (2026-10-07).

- Phase 1 (`2026-11-12_patient_deposits.sql`, applied on production): receive, pay a bill from the
  deposit, refunds kept as deposit (desk default "Keep as deposit", admin "Into the deposit", "as
  paid" deposit share, discounts after finalisation), cash shift and collections report, Deposit
  panel and header chip, deposit receipt.
- Phases 2–4 (`2026-11-13_deposit_moves.sql`, **not yet applied on production**): move to another
  patient with the depositor's consent photo, move to IPD with the HealthRay IP number, refund of
  the balance (held from the request until paid or rejected, approved by a different person on
  Requests, paid out on the Refunds board or the Deposit panel), DEP slips (`deposit_slip_seq`)
  and slip PDFs, Patients deposits report, merge scripts stop on a patient with deposit history.
- Open questions §11 answered with the recommendations: a deposit refund needs a second person;
  cash refunds stay allowed as an explicit choice.
- Tests: `e2e/billing/deposits/D01`–`D04`.

A **deposit** is money a patient pays before there is a bill for it. It is held against the
patient's name and used later: on any of their bills, on another patient's bills with their
consent, or carried into their IPD admission. Unused money can be paid back.

Today Scribe has no money that is not attached to a bill: `payments.bill_id` is `NOT NULL`
(`2026-10-17_billing_bills.sql`), every payment is on an invoice and every pay-out is on a
credit note (`payments_direction_guard`).

## 1. Decisions

| #   | Decision (hospital, 2026-10-06)                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Deposits are taken in **Scribe** at the billing counter. Scribe holds the balance; deposits taken in HealthRay are not copied in.                                             |
| D2  | Moving a deposit to another patient needs a **photo of the depositor's signed consent form**.                                                                                 |
| D3  | Only **reception admin and admin** may transfer a deposit (to another patient or to IPD). Any billing desk may receive a deposit and use it on a bill.                        |
| D5  | When services on a paid bill are **cancelled**, the refund is **kept as a deposit** for the patient by default, for their later visits, a family member, or an IPD admission. |
| D4  | Leftover deposit can be paid back **after approval** on the Refunds board, like a bill refund. Deposits **never expire**.                                                     |

Still open — see §11.

## 2. Worked example

| Step | What happens                                                                      | Ritesh's balance     |
| ---- | --------------------------------------------------------------------------------- | -------------------- |
| 1    | Ritesh pays ₹2,000 cash as a deposit. Receipt RCPT-… printed.                     | ₹2,000               |
| 2    | X-ray bill ₹800 → Collect payment → **Deposit** ₹800.                             | ₹1,200               |
| 3    | X-ray refund approved "as paid" → the ₹800 goes straight back into the deposit.   | ₹2,000               |
| 4a   | Admitted → **Transfer to IPD** ₹2,000 with his IP number. Slip DEP-… printed.     | ₹0                   |
| 4b   | or: his mother is seen → **Transfer to patient** ₹1,000 with consent. Slip DEP-…. | ₹1,000 (hers ₹1,000) |
| 4c   | or: he asks for it back → refund request (₹2,000 held) → approved → paid in cash. | ₹0                   |

## 3. Data model

### 3.1 `deposit_accounts` — one row per patient, created on the first deposit

| column       | notes                                                   |
| ------------ | ------------------------------------------------------- |
| `patient_id` | PK, FK `patients` `ON DELETE RESTRICT`                  |
| `balance`    | `NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0)` |
| `updated_at` |                                                         |

Every move locks the row `FOR UPDATE` and writes `balance = balance + $delta` (never a value
computed in JavaScript), so the `CHECK` is a real backstop against spending money twice.

**Available** = `balance − held`, where `held` is the sum of deposit-refund requests that are
pending **or approved but not yet paid out** (§4.6). The `CHECK` cannot see holds, so every
spender (pay a bill, transfer, IPD, new refund request) re-reads `available` **under the account
lock** and refuses if it is short.

### 3.2 `deposit_entries` — append-only ledger

| column                     | notes                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `id`                       | UUID                                                                                       |
| `patient_id`               | whose balance moves                                                                        |
| `kind`                     | `received`, `applied`, `restored`, `transfer_out`, `transfer_in`, `to_ipd`, `refunded`     |
| `amount`                   | signed; CHECK: `+` for `received` `restored` `transfer_in`, `−` for the rest               |
| `balance_after`            | balance after this entry — the history reads like a passbook                               |
| `payment_id`               | the `payments` row behind `received`, `applied`, `restored`, `refunded`                    |
| `bill_id`                  | the invoice (`applied`) or credit note (`restored`)                                        |
| `slip_no`                  | `DEP` series — only on `transfer_out` / `transfer_in` / `to_ipd` (no `payments` row there) |
| `counter_entry_id`         | the other half of a transfer pair                                                          |
| `other_patient_id`         | the other patient of a transfer                                                            |
| `relationship`, `reason`   | required for transfers; reason required for IPD and refunds                                |
| `consent_document_id`      | transfer to a patient: the consent photo (§6.4)                                            |
| `ipd_number`               | `to_ipd`: HealthRay IP / admission number                                                  |
| `request_id`               | `refunded`: the approved `billing_requests` row                                            |
| `created_by`, `created_at` |                                                                                            |

A trigger refuses `UPDATE` and `DELETE` (the `billing_audit` pattern). A mistake is undone with
a new entry, never an edit. Every entry is also written to `billing_audit` via `writeAudit`.

### 3.3 Money stays in `payments`

Real money (cash / card / UPI) coming in as a deposit or going out as a deposit refund is a
`payments` row, so the cash drawer (`DRAWER_SQL`, shift totals, `cashOutShift` all key on
`shift_id`) and receipt numbers keep working from one table.

| Event                   | `payments` row                              | ledger       | number |
| ----------------------- | ------------------------------------------- | ------------ | ------ |
| Deposit received        | `bill_id NULL`, `in`, cash/card/UPI, shift  | `received` + | RCPT   |
| Bill paid from deposit  | invoice, `in`, `deposit`, no shift          | `applied` −  | RCPT   |
| Refund into the deposit | credit note, `out`, `deposit`, no shift     | `restored` + | —      |
| Transfer to patient     | none — no money moves                       | pair         | DEP    |
| Transfer to IPD         | none                                        | `to_ipd` −   | DEP    |
| Deposit refunded        | `bill_id NULL`, `out`, cash/card/UPI, shift | `refunded` − | —      |

No transaction takes both an RCPT and a DEP number, so the two hospital-wide `bill_series` rows
(`nextNumber` locks them `FOR UPDATE`) can never deadlock each other.

## 4. Flows

### 4.1 Receive a deposit — any billing desk

Counter → patient → **Deposit** → **Receive deposit**. Amount, mode, reference (card / UPI),
optional note. Cash needs an open shift (the `collectOnBill` rule). One transaction: create /
lock account → RCPT number → `payments` row → `received` entry → audit. Prints a **deposit
receipt**: patient, Health ID, receipt no., amount in figures and words, mode, balance after,
"Advance deposit — not a bill".

### 4.2 Use the deposit on a bill — any billing desk

Collect payment offers **Deposit — ₹2,000 available** when the available balance is above zero,
prefilled with `min(available, outstanding)`; the rest by cash / card / UPI in the same submit
(`takePayments` takes up to 10 payments at once). Works on every **invoice** — consultation,
X-ray, lab, machine test, outsourced test, procedure.

In `collectOnBill`, after the bill is locked (§7 lock order), for each `deposit` payment: lock
the account of **the bill's own patient**, check `available`, insert the payment, write the
`applied` entry. Everything after is unchanged: `keepPaidInStep`, `settleTestOrders` releases
paid test orders, `tickBillingStep` moves the journey.

- Another patient's money is moved by a transfer first (§4.4), so the ledger always says whose
  money paid what.
- Drafts can be paid today (`collectOnBill` → `markDraftSaved`); deposit follows the same rule as
  cash. A deposit wrongly applied cannot be "undone": `cancelBill` and `deleteDraftIn` refuse
  bills with money taken, so the bill is finalised and refunded into the deposit (§4.3).
- Floor test orders cleared on reception's **Payments tab** are not invoices and do not take a
  deposit. A patient paying tests from a deposit is billed on the Bill tab, which settles the
  orders as today.

### 4.3 Refunds of a deposit-paid bill — restored automatically

A credit note is raised and approved as today. When the approval is **"as paid"**,
`refundShares` splits the refund by the modes the bill was paid with, so the deposit share is its
own leg. That leg is restored **inside the approval transaction** (`approveRefund`) — an `out`
/ `deposit` payment on the credit note plus a `restored` entry. No money leaves the building, so
there is no desk pay-out step and no "to pay" row for it. The cash / card / UPI legs are paid out
by the desk as today.

The same applies to discount credit notes after finalisation (`discountFinalBill`), which are
"as paid" by definition: the deposit share goes back to the deposit at once.

**Cancelled services are kept as a deposit (D5).** When services on a paid bill are cancelled,
the money is saved for the patient instead of being handed back:

1. The desk cancels the services as today (credit note + refund request). The request form gets
   a **Where should the money go?** choice, preselected to **Keep as deposit for the patient**
   (the other choice: pay back by cash / card / UPI).
2. The admin approves on the Refunds board as today; the approval dialog shows the desk's choice
   and can change it (new approved mode `deposit`, recorded on the request).
3. On approval the whole credit goes into the patient's deposit in the same transaction — no
   cash leaves, no desk pay-out step. The credit note and the refund receipt say "Kept as
   deposit DEP balance ₹…".
4. From then on it is ordinary deposit money: used on the patient's next bill (§4.2), moved to a
   family member with consent (§4.4), or carried into an IPD admission (§4.5).

Example: bill ₹2,000 paid in cash; an ₹800 test is cancelled → credit note ₹800, approved "Keep
as deposit" → Ritesh's deposit ₹800 → next visit his ₹500 consultation is paid from it (₹300
left), or his mother's bill, or his IPD bill.

This works whatever the bill was paid with (cash, card, UPI or deposit). Choosing cash / card /
UPI instead pays the money out as today — an explicit decision, recorded on the request.

### 4.4 Transfer to another patient — reception admin / admin

Counter → Ritesh → Deposit → **Transfer to another patient**.

1. Search the receiving patient (name / Health ID / phone).
2. Both shown side by side — name, Health ID, phone, age / sex — so money cannot land on someone
   with the same name.
3. Amount (≤ available), relationship, reason, **consent photo (required)**.
4. Confirmation: "Move ₹1,000 from Ritesh Kumar (P*…) to Sunita Kumar (P*…). Ritesh's deposit
   becomes ₹1,000, Sunita's ₹1,000. Only a transfer back can reverse this."
5. One transaction: lock **both** accounts in `patient_id` order → DEP slip number →
   `transfer_out` + `transfer_in` linked by `counter_entry_id` → audit.
6. **Transfer slip**: both patients, amount, slip no., consent reference, signature lines
   (depositor, receiver, desk).

Refused: same patient, amount above available, no consent photo, role without the capability.

### 4.5 Transfer to IPD — reception admin / admin

IPD billing is in HealthRay, and Scribe cannot write to HealthRay bills.

1. Counter → Ritesh → Deposit → **Transfer to IPD**: amount (≤ available), **HealthRay IP /
   admission number** (required), reason.
2. One transaction: DEP slip number → `to_ipd` entry → audit.
3. **IPD transfer slip**: patient, Health ID, IP number, amount, slip no., who, when.
4. The IPD desk enters the amount as a deposit on the patient's HealthRay IPD account quoting
   the slip no.; the final IPD bill is reduced by it.

No cash moves. Accounts reconcile `to_ipd` entries against HealthRay by slip no. using the
Deposits report (§5).

### 4.6 Refund the balance — request, approve, pay out

1. Counter → Deposit → **Refund balance**: amount (≤ available), reason → a `billing_requests`
   row of new kind **`deposit_refund`** (existing `patient_id`, new `amount`).
2. The amount is **held** from that moment until the request is **paid out or rejected** — not
   released on approval.
3. Refunds board row "Deposit refund". Approve with a mode — **cash, card or UPI** ("as paid"
   has no meaning for a deposit: the balance mixes received, transferred-in and restored money)
   — or reject (hold released). Approved through the existing
   `/master/requests/:id/approve` and `/reject` routes with a `deposit_refund` branch.
4. Desk pays out: `payments` row `bill_id NULL`, `out`, the approved mode, shift for cash (the
   `payOut` drawer check) → `refunded` entry → request `used` → **deposit refund receipt**.

## 5. Accounting and reports

- A deposit received is a **liability**, not income. Income is recognised when a bill is paid
  from it — exactly as with cash.
- **Cash shift** (`cashShifts.js`): deposit cash in / out carry a shift, so the drawer already
  counts them. `deposit`-mode rows carry no shift (CHECK, like `payments_healthray_no_shift_check`),
  so ₹2,000 is never counted twice. New summary lines "Deposits received" / "Deposits refunded";
  `payment_count` (`cashShifts.js:119`) excludes deposit rows so "payments taken on bills" stays
  true (`bill_count` already ignores `NULL`).
- **Collections report** (`reports.js` ~404): today an inner join to `bills`, so deposit rows
  would vanish. Becomes a `LEFT JOIN`; deposit money rows show as "Deposit received / refunded";
  the `deposit` mode (applied and restored) is removed from **every** total, the rollup `()` row
  and `net` (~410-417), and shown as a separate "Paid from deposit" memo. With a scheme /
  category filter (`b.scheme_code`) deposit rows are out of scope and the report says so.
- **Deposits report** (new, Billing reports): per day / per desk — received, applied, restored,
  transferred between patients, to IPD, refunded, held for refund, and hospital-wide **deposits
  held**. Reconciles: opening held + received + restored − applied − to IPD − refunded = closing
  held (transfers net to zero).
- **Bill PDF / receipts**: a `deposit` payment prints "Paid from deposit". `receiptPdf.js` is
  bill-scoped, so deposit receipts and slips get their own loader on the same letterhead.

## 6. Screens

### 6.1 Billing counter — patient header

**Deposit ₹2,000** chip when the balance is above zero ("₹500 held for refund" when a refund is
waiting). Clicking it opens the Deposit panel.

### 6.2 Billing counter — Deposit panel

Collapsed card like Add items. Balance, held, available, and the actions the role may use:
Receive deposit · Transfer to another patient · Transfer to IPD · Refund balance. History below
(passbook): no., date/time, kind, amount, balance after, bill / other patient / IP number, who;
each row reprints its receipt or slip. A patient with no deposit sees only **Receive deposit**.

### 6.3 Collect payment

`Deposit` appears only with an available balance, labelled with it; the amount cannot exceed it;
no reference box.

### 6.4 Consent photo

Stored through the patient documents store (as the scanned billing reports are), category
"Deposit transfer consent". The transfer keeps the document id; the photo opens from the history
row.

### 6.5 Refunds board

`refundBoard.js` reads only `kind = 'refund'` joined to `bills`; a `UNION` adds "Deposit refund"
rows: patient, Health ID, amount, reason, requested by / at, status (Waiting for approval →
Approved to pay → Paid back / Rejected), same actions as bill refunds. The approve dialog offers
"Into the deposit" for bill refunds (§4.3).

### 6.6 Print

Deposit receipt, patient transfer slip, IPD transfer slip, deposit refund receipt — `billPdf.js`
letterhead.

## 7. Wiring

**Lock order — one rule everywhere: bills (id order) → deposit accounts (patient-id order) →
orders.** It matches what exists (`payOut` locks both bills first, `approveRefund` request →
bill, `discountFinalBill` the bill), so no existing path is reordered. Receive, transfer and IPD
lock accounts only; nothing holds an account while waiting for a bill.

| Layer          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration      | `deposit_accounts`; `deposit_entries` (append-only trigger, RLS forced, revoked from anon / authenticated); `payments.bill_id` nullable + `deposit_patient_id` (indexed) + `CHECK ((bill_id IS NULL) = (deposit_patient_id IS NOT NULL))`; `deposit` in `payments_mode_check`; `payments_reference_check` lets `deposit` go without a reference; `CHECK (mode <> 'deposit' OR shift_id IS NULL)`; `payments_direction_guard` refuses `mode = 'deposit'` on a bill-less row; `billing_requests`: kind `deposit_refund`, `amount`, and the `refund_only` / `refund_approved` / `reason_code_refund` checks widened for it; `approved_mode` gains `deposit`; `DEP` series row for every financial year. |
| Numbers        | `DEP` in `BILL_SERIES` (`shared/billingVocab.js`) and in `billSeries.js` `ISSUED`, so its prefix / width lock once a slip is issued.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Service        | `server/services/billing/deposits.js`: `account`, `ledger`, `receive`, `applyOnBill(client, …)`, `restoreLeg(client, …)`, `transferToPatient`, `transferToIpd`, `requestRefund`, `payOutRefund`, `report`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| payments.js    | `TAKING.modes` gains `deposit` **separately** — `PAYMENT_MODES` in `cashShifts.js` must not (it drives shift totals and report ordering); `NO_REFERENCE` gains `deposit`; `MODE_LABEL`; `collectOnBill` calls `applyOnBill` for deposit legs.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Refund paths   | `approveRefund` (`billingRequests.js`) and `discountFinalBill` (`creditNotes.js`) restore deposit legs in their transaction; `refuseOtherModes` / `refundLegs` treat an approved `deposit` mode; `billingRequests.js` `KINDS`, `usable` (must not list `deposit_refund` as usable for items) and `approveRequest` gain a `deposit_refund` branch.                                                                                                                                                                                                                                                                                                                                                    |
| Reports        | `cashShifts.js` lines + `payment_count`; `reports.js` LEFT JOIN + totals; new deposits report; `refundBoard.js` UNION; `billPdf.js` / `reports.js` mode labels; deposit receipt / slip PDFs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Schemas        | `schemas/billing.js` `paymentEntry` (mode enum + reference rule) for take and pay-out; one Zod schema per new POST.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Routes         | `billing.js`: `GET /billing/patients/:id/deposit`, `POST …/deposit/receive`, `…/deposit/transfer`, `…/deposit/ipd`, `…/deposit/refund-request`, `POST /billing/deposit-refunds/:id/pay-out`, slip / receipt PDFs. Approval reuses the existing `/master/requests/:id/approve` and `/reject` routes.                                                                                                                                                                                                                                                                                                                                                                                                  |
| RBAC           | Reuse: `BILLING_DESK` → receive, use, view, request refund; `BILLING_MASTER` (reception admin, admin — exactly D3) → transfers and approving deposit refunds. No new capabilities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Client         | A separate `DEPOSIT_MODE` label — **not** added to `PAYMENT_MODE_LABEL`, which drives the shift panel columns (`ShiftPanel.jsx`), the refund mode picker (`RefundDialog.jsx`) and saved-form validation (`counterForm.js`); deposit handled explicitly in `TotalsAndPayment.jsx` (reference checks), `BillRefunds.jsx` `needsReference`, `lineText.js` `MODE_WORD`. New `DepositChip`, `DepositPanel`, `TransferToPatient`, `TransferToIpd`, `DepositRefund`; `RefundsBoard.jsx` row type; hooks in `useBilling.js`.                                                                                                                                                                                 |
| Patient merges | `scripts/fix-obt-shell-duplicates.mjs` and `merge-walkin-chart-into-healthray.mjs` delete patients; the `RESTRICT` FK stops them on a patient with a deposit. They move the balance first with a transfer pair, reason "chart merge", before deleting.                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 8. Phases

1. **Receive and use** — migration, ledger, receive + receipt, deposit mode on Collect payment,
   automatic restore on "as paid" / discount approvals, **cancelled services kept as deposit**
   (D5: request choice + approval mode), cash shift +
   collections changes, Deposit panel with history, merge-script guard.
2. **Transfer to another patient** — consent photo, both-patient confirmation, slip.
3. **Transfer to IPD** — IP number, slip, Deposits report (needed for reconciliation).
4. **Refund the balance** — request with hold, Refunds board row, approval branch, pay-out,
   receipt.

Each phase ships on its own; phase 1 alone covers "a deposit can be used on any bill".

## 9. Tests (e2e, `e2e/billing/deposits/`)

- Receive cash without an open shift → refused; with one → receipt, balance, drawer +₹2,000.
- Part-pay a bill from deposit, rest in cash → bill paid, test orders released, drawer counts
  only the cash, balance reduced, collections report totals exclude the deposit leg.
- Deposit above available → refused; two concurrent ₹1,500 payments from one ₹2,000 deposit →
  exactly one succeeds; a receive racing a bill payment does not deadlock.
- "As paid" refund of a deposit-paid bill → restored at approval, no pay-out row, drawer
  unchanged; "Into the deposit" for a cash-paid bill → balance up, nothing to pay; fixed cash
  approval of a deposit-paid bill → paid out as cash.
- Discount after finalisation on a deposit-paid bill → deposit share restored at once.
- Transfer: refused for a desk role, without consent, to the same patient, above available;
  succeeds for reception admin; both balances, the linked pair and the DEP slip correct.
- Transfer to IPD requires the IP number; balance reduced; on the Deposits report.
- Deposit refund: the request holds the amount (cannot be spent, transferred or requested again);
  the hold survives approval; reject releases it; pay-out → drawer −₹, balance reduced, request
  `used`.
- Ledger rows cannot be updated or deleted; balance never negative (DB check); a `deposit`
  payment cannot carry a shift or sit on a bill-less row.
- Deposits report reconciles; shift `payment_count` unchanged by deposit rows.
- Existing suites (`e2e/billing`) pass unchanged.

## 10. Not in scope

- Copying deposits taken in HealthRay into Scribe (D1).
- Writing the IPD transfer into HealthRay automatically — no HealthRay API for it.
- Interest, expiry or forfeiture (D4).
- Paying reception Payments-tab test clearances from a deposit (§4.2).

## 11. Open questions for the hospital

1. **Two people for a deposit refund?** Reception admin holds `BILLING_MASTER`, so one person can
   request and approve their own deposit refund, or transfer money with nobody else involved.
   Recommended: the approver of a deposit refund must be a different person from the requester.
2. **Cash still allowed?** With D5, cancelled services go to the deposit by default. Should the
   desk / admin still be able to choose cash / card / UPI when the patient insists, or is a
   deposit the only outcome?
