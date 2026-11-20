# 97 — Payment mode on "Paid in HealthRay" + close yesterday's shift before taking money

Status: built (2026-11-20). Not yet run through e2e.

Built as: `paymentMode.js` (shared mode/app/reference rules), `clearHealthrayAtDesk` + `paid_via` on
the HealthRay payment, `PaidModeFields.jsx` (shared by Correct mode and the HealthRay dialog);
`useCloseShiftForm` + `CountCashFields.jsx` (shared by the Shift tab and the dialog),
`EarlierShiftDialog.jsx` + `useEarlierShiftCheck.jsx`, `POST /api/billing/shifts/current/skip-close`
(audit row `close_skipped_on`; `close_skipped_today` on the current shift).

## Why

1. **"Paid in HealthRay" records no mode.** The counter writes a `healthray` payment with
   `paid_via = NULL`. From 1–20 Nov all 467 HealthRay payments (₹8,37,487) have no mode, so the
   billing dashboard and the audit report can only say "Paid in HealthRay (mode not recorded)".
   The mode can be added later with **Correct mode** (plan 64), but nobody does it.
2. **Yesterday's shift stays open.** One open shift per desk (`cash_shifts`, unique on open
   `user_id`). If it is not closed, today's cash goes into yesterday's drawer. The counter only
   shows a quiet hint (`shiftReminder() === "earlier"`), which is easy to miss.

## What exists (reuse, don't rebuild)

| Piece                             | Where                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| HealthRay button + confirm dialog | `src/components/billing/counter/TotalsAndPayment.jsx` (`ConfirmModal`, `clearInHealthray`)                                            |
| Clear endpoint                    | `POST /api/billing/bills/:billId/clear-healthray` → `bills.clearHealthrayAndFinalise` → `payments.clearInHealthray` → `collectOnBill` |
| Request schema                    | `billingClearHealthraySchema` in `server/schemas/billing.js` (only `version` today)                                                   |
| `paid_via` / `upi_app` rules      | DB checks in `2026-12-26_payment_neft_upi_app.sql`; validation `cleanCorrection` + `cleanUpiApp` in `paymentCorrection.js`            |
| Mode picker, UPI app, labels      | `TAKE_MODE_LABEL`, `needsUpiApp`, `HEALTHRAY_LABEL` in `counter/lineText.js`; mode `<select>` in `TotalsAndPayment.jsx`               |
| "Shift is from an earlier day"    | `shiftReminder()` in `counter/shiftReminder.js`                                                                                       |
| Close shift (count cash, notes)   | `ShiftPanel.jsx` close form → `closeCurrentShift`                                                                                     |
| Open shift                        | `OpenShiftForm.jsx` / `SavedOpenShiftForm`                                                                                            |
| Dialog                            | `ConfirmModal` (already used on the counter)                                                                                          |

## Part A — mode required on "Paid in HealthRay"

**Behaviour**

- The existing "Mark as paid in HealthRay?" dialog gets a **How did the patient pay in
  HealthRay?** field: Cash / Card / UPI / NEFT-cheque (same list and labels as Take payment).
- UPI → choose the app (BharatPe / Paytm / Other), same as Take payment.
- Card / UPI / NEFT need the reference number (D1), same rule as Take payment.
- "Mark ₹X paid" stays disabled until a mode (and app, for UPI) is chosen, with the reason shown.
- Saved on the payment as `mode = 'healthray'`, `paid_via = <mode>`, `upi_app`, `reference`.
  It is **not** cash in the Scribe drawer (unchanged): HealthRay cash is handed over in HealthRay.
- Server refuses a clear without a valid `paid_via` (400, plain message) so no other caller can
  skip it.
- Old HealthRay payments without a mode are untouched; they can still be fixed with Correct mode.

**Tasks**

1. Shared helper for "mode + upi_app + reference" validation, used by both `cleanCorrection` and
   the clear endpoint (move out of `paymentCorrection.js`, no duplicate rules).
2. Schema: `billingClearHealthraySchema` takes `paid_via`, `upi_app?`, `reference?`.
3. `clearInHealthray` passes them into the planned payment; `collectOnBill` INSERT writes
   `paid_via`. Audit row carries them.
4. Counter dialog: mode select + UPI app + reference, blocked-reason line, sends them.
5. Check: dashboard and audit cards now put these under Cash / BharatPe / … (they already read
   `paid_via` through `MONEY_COLUMN`).

## Part B — close yesterday's shift before the first payment

**When it shows**

- The desk's open shift started on an earlier IST day (`shiftReminder(shift) === "earlier"`), and
- the user presses any money action on the counter: **Take payment**, **Paid in HealthRay**,
  taking a deposit (D3).

**Dialog** (`ConfirmModal`-style, focus-trapped)

> **Close yesterday's shift first**
> Your shift opened on 19 Nov, 09:12 is still open (12 payments · ₹14,300 cash expected).
> Close it so today's cash is counted on its own, then open today's shift.
>
> [Close shift and continue] [Skip for now]

- **Close shift and continue** → the dialog shows the existing close form (counted cash / note
  count, same rules and warnings as the Shift tab), then the open-shift form (opening cash), then
  returns to the payment the user was taking — nothing they typed is lost.
- **Skip for now** → the payment goes ahead on the old shift (today's behaviour). Skip is
  remembered per desk for the rest of the day (D2) and written to `billing_audit`
  (who skipped, which shift) so admins can see it.
- If the shift is from today, nothing changes. If no shift is open, the existing "Open one here"
  prompt stays.

**Tasks**

6. Pull the close form out of `ShiftPanel.jsx` into a reusable `CloseShiftForm` (Shift tab keeps
   using it — no behaviour change there).
7. `EarlierShiftDialog` on the counter: summary → close form → open form → continue / skip.
8. Hook it in front of Take payment, Paid in HealthRay and taking a deposit.
9. Skip: `POST /api/billing/shifts/current/skip-close` → audit row; remembered for the IST day.

## Checks (manual + read-only; e2e only when asked)

- Paid in HealthRay without a mode → button disabled; API without `paid_via` → 400.
- UPI without app, or card/UPI/NEFT without reference → blocked, and refused by the API.
- Saved payment has `paid_via`; dashboard + audit show it under the real mode.
- Shift opened yesterday → first Take payment shows the dialog; close + open + payment goes to
  today's shift; Skip → payment on old shift, audit row, no dialog again today.
- Shift opened today → no dialog.

## Decisions (2026-11-20)

| #   | Decision                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------ |
| D1  | Card / UPI / NEFT on a HealthRay payment **require** the reference number. Cash needs none.            |
| D2  | Skip asks **once per desk per day**; every Skip is audited.                                            |
| D3  | The shift check runs before **every money action**: Take payment, Paid in HealthRay, taking a deposit. |
