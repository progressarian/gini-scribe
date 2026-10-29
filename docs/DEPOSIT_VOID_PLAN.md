# Void a wrongly taken deposit — Plan

Status: built 2026-10-29 on the local test DB (D06 + D07 pass); production migration not applied yet. Decided: who = own receipt while shift open, or reception admin / admin; no time limit while the money is unused.

## 1. Problem

Reception sometimes records **Take a deposit** for money that was never handed over. Example: P_67810 (Amrit Kaur), 29 Oct.

- The ₹1,500 consultation was paid in cash, and ₹375 was refunded after a 25% discount.
- Two minutes later a **₹1,125 UPI deposit** (RC26-000915, note "loin club") was recorded. It looks like an attempt to note "she paid ₹1,125", not a real advance.

There is no way to undo it today:

- `deposit_entries` is append-only (DB trigger).
- **Correct mode** skips deposit receipts (`paymentCorrection.js:27`, `!row.deposit_patient_id`).
- **Pay back** is the only way out, and it writes a refund: money leaving the hospital. For money that never arrived, this has two problems:
  - Cash pay back takes the amount out of the drawer count, so the drawer comes up short.
  - Card/UPI pay back adds a fake outgoing transfer to Collections and the shift totals, and asks for a reversal reference that doesn't exist.

## 2. Goal

A **Void** action on one deposit receipt means "this was entered by mistake; no money changed hands". It must:

- take the amount back out of the patient's deposit balance;
- remove the receipt from collections, shift totals and the cash drawer's expected amount, as if it was never taken;
- keep the receipt and its void on record forever (who, when, why); nothing is deleted;
- be possible only while the money is still sitting unused in the deposit.

It is **not** a refund. If the patient really paid and wants the money back, that is still **Pay back**.

## 3. Rules

| Rule                                 | Detail                                                                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What can be voided                   | A `received` deposit entry, i.e. money taken at the counter with **Take a deposit**. Not `restored` (refund kept as deposit, which has its own credit note), not `transfer_in`, `applied`, `to_ipd` or `refunded`.                  |
| Only once                            | A voided receipt can't be voided again.                                                                                                                                                                                             |
| Money must be unused (no time limit) | Patient's **available** balance (balance − amount held for a pending pay back) ≥ the receipt amount. If part of it already paid a bill, moved to a relative or IPD, or is held for a pay back, the void is refused with the reason. |
| Reason                               | Required, 5–300 letters. Shown in history and on the reprinted receipt.                                                                                                                                                             |
| Who                                  | **Decided:** the person who took it, while their shift is still open, **or** a reception admin / admin (`BILLING_MASTER`) at any time. This is the same rule as Correct mode (`mayCorrect`).                                        |
| No approval step                     | It's a correction of a typing mistake, not money going out, so it runs immediately like Correct mode. The audit trail is the control.                                                                                               |

## 4. Data model

Migration `server/migrations/2026-12-20_deposit_void.sql` (dated after the latest billing migration so it applies last):

```sql
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by   INT REFERENCES doctors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason TEXT CHECK (void_reason ~ '\S');

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_void_check,
  ADD CONSTRAINT payments_void_check
    CHECK ((voided_at IS NULL) = (void_reason IS NULL)
           AND (voided_at IS NULL OR (bill_id IS NULL AND direction = 'in')));

ALTER TABLE deposit_entries DROP CONSTRAINT IF EXISTS deposit_entries_kind_check;
ALTER TABLE deposit_entries ADD CONSTRAINT deposit_entries_kind_check
  CHECK (kind IN ('received', 'applied', 'restored', 'transfer_out', 'transfer_in',
                  'to_ipd', 'refunded', 'voided'));

ALTER TABLE deposit_entries
  DROP CONSTRAINT IF EXISTS deposit_entries_voided_check,
  ADD CONSTRAINT deposit_entries_voided_check
    CHECK (kind <> 'voided' OR (counter_entry_id IS NOT NULL AND note IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS deposit_entries_one_void_key
  ON deposit_entries (counter_entry_id) WHERE kind = 'voided';
```

- The receipt row in `payments` is **marked**, not reversed. A void is "it never happened", so no outgoing payment is written. That keeps refunds and Paid back figures honest.
- The deposit gets a new `voided` entry for −amount, pointing at the `received` entry through `counter_entry_id`. Balance history stays append-only and still adds up.
- The check constraint lets only deposit receipts (`bill_id IS NULL`, money in) be voided. Bill payments stay out of scope.
- The inline `kind` CHECK from `2026-11-12_patient_deposits.sql` has a generated name. The migration looks it up and drops it by that name. Confirm the name on the e2e DB before writing the final file.
- Additive and nullable, so screens on the deployed code keep working before the code ships.

## 5. Server

**`server/services/billing/deposits.js`: `voidDeposit(entryId, input, ctx)`**

1. Validate the entry id (UUID) and the reason.
2. In one transaction:
   - Load the entry and its payment `FOR UPDATE`.
   - Refuse if it isn't `received`, or if it's already voided.
   - Check rights (§3). The payment's shift must be open unless the user has `BILLING_MASTER`.
   - `lockAvailable` and `refuseShort(account, amount, "voided")` give the existing "only ₹X is available" message.
   - `UPDATE payments SET voided_at, voided_by, void_reason`, with a `writeAudit` before/after.
   - Add the `voided` entry with `addEntry`, for −amount, `counterEntryId` = the received entry and `note` = the reason.
   - If it was cash and the shift is already closed, `refreshClosedDrawer(client, shiftId, ctx)` recomputes expected cash and the difference. This is the same as Correct mode.
3. Return the new balance.

**Route** in `server/routes/billing.js`: `POST /billing/deposit-entries/:entryId/void`, using the `desk` guard. Rights are checked inside the service, like `correctPaymentMode`. Add the Zod schema `billingDepositVoidSchema` with `{ reason }`.

**Readers that must skip voided receipts.** Only deposit receipts can be voided, so bill payment queries are untouched.

| Where                                                                                    | Change                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `cashShifts.js:100-106` expected cash in drawer                                          | `AND p.voided_at IS NULL`                                                      |
| `cashShifts.js:120-130` shift totals (`deposits_received`, `deposit_count`, mode totals) | same filter                                                                    |
| `reports.js:428` Collections                                                             | same filter                                                                    |
| `reports.js:1147+` Patient deposits report                                               | add a "Voided" column; keep `received` gross                                   |
| `deposits.js` `ENTRY_SQL` / `getDeposit`                                                 | return `voided_at`, `void_reason`, `voided_by_name` so the history can show it |
| `depositReceiptPdf.js`                                                                   | a voided receipt still prints, with a "VOID: reason, by, when" stamp           |

Before building, go through the other `FROM payments` readers: `billPdf`, `billSeries`, `bills`, `counterPatients`, `dues`, `payments`, `refundBoard`. Confirm each one already filters on `bill_id IS NOT NULL` or joins `bills`. That's expected, but check it.

## 6. Client

`src/components/billing/counter/DepositPanel.jsx`, History table:

- On a `received` row the user may void: a quiet **Void** button next to **Receipt**.
- It opens a small confirm dialog (existing dialog pattern), showing:
  - Patient name and file no.
  - Receipt no, mode, amount, time and who took it.
  - Result: "Deposit balance ₹1,125 → ₹0. This receipt will no longer count in collections or the cash drawer."
  - Required **Reason** field.
  - Buttons **Cancel** / **Void receipt**; loading text "Voiding…".
- After a void:
  - The original row shows a "Voided" badge (label, not colour only) with the reason.
  - A new history row "Receipt voided · RC26-000915" shows −₹1,125.
  - Invalidate the deposit query and the shift/drawer query.
- The button is hidden when the user may not void it. When the money isn't available, it's disabled with the reason shown, for example "₹600 of it has already paid bill GH26-…".
- `KIND_LABEL.voided = "Receipt voided"`.

## 7. RBAC

- No new capability. The route is under the existing billing desk prefix.
- The service enforces "own receipt + open shift" for reception, and any receipt for `BILLING_MASTER`.

## 8. Tests

New spec `e2e/billing/deposits/D06-deposit-void.spec.js`, run on the local test DB. It covers:

- Void an unused UPI deposit: balance goes to 0, Collections and shift totals drop, and the receipt PDF says VOID.
- Void a cash deposit in an open shift: expected drawer cash drops.
- Void after the shift closed, as reception admin: the closed shift's expected cash and difference are recomputed.
- Refusals:
  - The deposit is partly used on a bill.
  - It's held for a pay back.
  - It's already voided.
  - It's a `restored` entry.
  - Reception tries to void another user's receipt, or their own after the shift has closed.
- The audit has the payment update plus the deposit entry.

## 9. After it ships

Amrit Kaur's ₹1,125: reception confirms with the UPI statement that nothing arrived. Then a reception admin voids RC26-000915 with the reason "Recorded by mistake; bill already settled in cash RC26-000914".

## 10. Build order

1. Migration on the e2e DB, then the service, the route and the reader filters, with D06 server cases.
2. Panel button, dialog and history display, with D06 screen cases.
3. Receipt PDF stamp and the reports column.
4. Ask before applying the migration to production.
