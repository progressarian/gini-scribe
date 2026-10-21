# 83 — Opening a patient on the Bill tab is slow

Status: §4.1–4.3 built (21 Oct 2026). **Run `server/migrations/2026-12-10_bill_autofill_key.sql` on production**, then restart the API. See "As built".

## 1. Ask

> "When I select any patient from the list, their data opens in the right panel — why does it
> take so much time? Make a plan to fix it."

## 2. What happens on one click today (read from code)

`BillingDesk.jsx` clears the panel (`setBill(null)`) and calls **Open draft**
(`POST /billing/visits/:visitId/bills` → `openDeskDraft`, `server/services/billing/deskOpen.js`).
The panel stays empty until that request returns. Opening an earlier bill uses a plain re-read
instead.

`openDeskDraft` is **one write transaction** that runs, every click:

1. `consultationForDesk` — adds or checks the consultation line.
2. `healthrayLinesForDesk` — matches the **stored** HealthRay bill to service items. HealthRay
   itself is not called; the sync stored it earlier.
3. `testsForDesk` — floor lab/machine orders.
4. `labCaseTestsForDesk` — tests from the HealthRay lab report.
5. `clearReceptionLines` — items already paid at reception.
6. `openDraft` — opens or creates the draft (`openDraftIn` locks every bill on the visit),
   `catchUpPrices` reprices it, `keepFirstSnapshot`, category resolution, removed-doctor check.

In parallel the panel fires: visit bills (`listVisitBills`, polled every 15 s), not priced,
consultant change (polled every 15 s), deposit, HealthRay bill lines, lab report tests, and the
patient list (polled).

`listVisitBills` loads each bill's lines, credits and consultant **one bill at a time**, so a visit
with a corrected bill (bill + credit notes + replacement) repeats that work per bill.

The API runs on Railway and the database on Supabase (small instance), so every query is a
network round trip; a step with dozens of queries costs seconds even when each query is quick.

## 3. Measurements (21 Oct 2026)

Production, read-only (`BEGIN READ ONLY`, rolled back), from a laptop: one round trip ≈ 29 ms.
Open draft writes, so its round trips were counted on the test DB and costed at 29 ms.

| Request on one click              | Round trips             | Production time             |
| --------------------------------- | ----------------------- | --------------------------- |
| **Open draft** (blocks the panel) | **48 first / 38 again** | **≈ 1.2–1.5 s**             |
| Visit bills (2 / 3 / 5 bills)     | 13 / 17 / 29            | 0.43 / 0.61 / 0.95 s        |
| HealthRay bill lines              | 5                       | 0.25–0.35 s                 |
| Re-read bill                      | 7                       | 0.22 s                      |
| Lab report tests                  | 3                       | 0.13–0.18 s                 |
| Deposit                           | 4                       | 0.12 s                      |
| Consultant change / not priced    | 1 each                  | 0.03 s                      |
| Counter patient list (polled)     | 1                       | 0.4–0.7 s (planning ≈ half) |

Open draft breakdown (test DB): consultation 4, HealthRay lines 7, floor tests 4, lab report 5,
reception lines 1, open + reprice 27 (17 on a repeat open).

Side finding: the test DB had JIT on (production has it off), which made big queries take
14 s there. JIT is now off on the test DB so its numbers match production.

## 4. Proposal (in order of gain for effort)

### 4.1 Show the saved bill at once, fill in after

When the visit already has a draft (the counter row and `listVisitBills` know its id), the panel
first **reads** that draft (`GET /bills/:id`, no writes) and shows it immediately, then runs Open
draft in the background and swaps in the result when it returns. A visit with no draft yet keeps
today's path. Nothing about what ends up on the bill changes; it just stops blocking the screen.

### 4.2 Skip the auto-fill when nothing changed

Store on the draft the moment of its last auto-fill. On Open draft, if none of its sources is
newer — consultation, stored HealthRay bill `read_at`, floor orders, lab report cases, reception
payments, service item / price changes — skip steps 1–5 and the reprice and just return the
draft. One nullable column (`bills.autofilled_at`, migration `2026-12-09_bill_autofilled_at.sql`),
additive, no backfill (empty = fill as today).

### 4.3 Load all of a visit's bills in a few queries

`listVisitBills` reads lines, credits and consultants for **all** the visit's bills in one query
each, instead of per bill. Same response shape.

### 4.4 Fewer requests per click

Return consultant change, not-priced and deposit with the visit bills response (one request
instead of four), keeping the existing endpoints for other screens. Optional; do it only if §3
shows the parallel requests matter.

## 5. Not changed

- What the auto-fill adds, the prices, the bill rules, the audit log.
- HealthRay calls (none happen on open today, none added).
- The 15 s polling (separate decision if §3 shows it matters).

## 6. Tests (e2e, test DB)

- Open draft twice with no changes → second open makes no writes and returns the same bill
  (query count asserted far below the first).
- Change each source (new floor order, HealthRay bill re-read, lab case, reception payment, price
  change) → the next open fills again and picks it up.
- Panel shows an existing draft before Open draft returns (slow the request in the test), then
  shows the filled result.
- `listVisitBills` returns the same data as before for a visit with bill + credit note +
  replacement (snapshot compare), with fewer queries.
- Existing billing suites (P4, P4B, P4C, G-series counter tests) still pass.

## 7. Questions

1. Build §4.1–4.3 together, or §4.1 first (screen feels fast at once) and the rest after?
2. §4.2 needs one small migration (you run it on production). OK?

## As built (21 Oct 2026)

- **§4.1 Show the saved draft at once** (`BillingDesk.jsx`): while Open draft is running, as soon as
  visit bills shows a draft, the panel reads it (`GET /bills/:id`) and shows it; the Open draft
  result replaces it when it returns (only if nothing newer is shown).
- **§4.2 Skip the auto-fill when nothing changed** (`server/services/billing/autofillKey.js`,
  `deskOpen.js`): one fingerprint query over the visit, appointment, the day's consultations, the
  stored HealthRay bill, floor orders + tests + events, HealthRay lab cases, the visit's bill lines,
  other bills, consultant changes and the last billing-master change in `billing_audit`. If it
  matches the draft's stored key and the last fill was under 10 minutes ago, steps 1–5 and the
  reprice are skipped. Columns `bills.autofill_key`, `bills.autofilled_at`
  (`2026-12-10_bill_autofill_key.sql`); until the migration runs, the check quietly does nothing
  (savepoint-guarded). Production cost of the fingerprint: ≈ 35–40 ms.
- **§4.3 Visit bills / re-read in parallel** (`bills.js`): each bill's lines, states, credits and
  consultant are read together (`listVisitBills`, `readBill`, `withLines`, `shownLines`), one bill
  after another so a corrected visit never takes more than a handful of pool connections.
- **Result (round trips):** repeat open 38 → 22; visit bills ≈ 6 per bill in sequence → ≈ 2 per bill.
- **Tests:** `P4C-55-bill-open-skips-unchanged-autofill.spec.js` (6: skip, HealthRay change, new
  order, 10-minute expiry, master change, read/list agree), `P4C-56-bill-shows-before-autofill.spec.js`
  (draft visible while Open draft is held; verified to fail without the change).
- §4.4 (merging requests) not built; not needed per §3.
