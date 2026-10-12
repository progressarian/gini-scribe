# 64 — Correct a payment's mode

Status: built (2026-10-12). Tests: `e2e/billing/phase4/P4C-42-correct-payment-mode.spec.js`.

## Why

Reception sometimes records a payment under the wrong mode (UPI entered as Cash). Once the bill is
final nothing can change it, and the refund flow is wrong for it — no money moves. Every payment
sits on a cash shift and the shift counts its drawer by mode, so a wrong mode leaves the drawer
short or over and the receipt shows the wrong mode.

## Decisions (2026-10-12)

| #   | Decision                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Only the **mode** (cash ↔ card ↔ UPI) and its **reference** change. Amount, date, bill, receipt number stay.                                   |
| M2  | Reception may correct **their own** payment while **its shift is open**. Otherwise only a **BILLING_MASTER** holder (reception admin, admin).  |
| M3  | A **reason** is required. Every correction goes to `billing_audit` (old → new mode, who, why).                                                 |
| M4  | A correction on a **closed** shift is allowed (M2) and the shift's stored `expected_cash` / `difference` are recomputed when cash is involved. |
| M5  | Not for deposit payments, "Paid in HealthRay" entries or money paid back (`direction = 'out'`).                                                |

## Behaviour

- `PATCH /api/billing/payments/:paymentId/mode` `{ mode, reference?, reason }` — desk capability.
  Refused: same mode and reference (400), not a collected cash/card/UPI payment (409), cancelled bill
  (409), not allowed by M2 (403 with who can do it).
- Switching to cash clears the reference.
- Shift per-mode totals are read live from `payments`, so they follow the correction. A closed
  shift's stored expected cash and difference are rewritten in the same transaction (audited).
- Receipts are rendered on demand, so a reprint shows the corrected mode.
- `GET /api/billing/bills/:billId/payments` adds `received_by_name`, `shift_open` and
  `can_correct` (M2/M5 for the caller).

## Counter UI

Bill summary gets **Payments received**: one row per collected payment — receipt no., mode,
amount, reference, time, who took it. A row the caller may correct has **Correct mode**, which
opens a small dialog: new mode, reference (card/UPI), reason, and a confirmation line
("₹1,000 · Cash → UPI · receipt R/123"). Saving refreshes the bill, its payments and the shift.

## Tasks

1. Service + route + `can_correct` on the payments list. Tests: own open shift; other desk refused;
   admin on a closed shift recomputes expected cash; deposit/HealthRay refused; audit row.
2. Payments received list + Correct mode dialog. Screen test.
