# 87 — Procedure-only arrivals (dressing etc.) at check-in

Status: **decisions made 2026-10-23** (§7), ready to build

## 1. The case

Ateeq Ur Rehman (P_178031), 23 Oct 2026. Booked under **Dr. Hospital Admin**. HealthRay bill OPD/2627-17361: **DRESSING ₹500, paid** (operator Anita Verma, 4:57 PM). Checked in on Gini Flow at about 5:09 PM.

What reception saw in the check-in panel:

- Journey: **Check-in → Report Upload** (7 min), with the hint "Today's HealthRay bill has no lab or machine tests — test steps were left out of the journey".
- Bill at arrival: "Nothing to bill yet — the consultant may still order tests."

Neither is right for a dressing patient. Report Upload is a lab step, and the dressing was not shown. If reception had added "Dressing" by hand and left it on **Collect now**, the patient would have been charged ₹500 twice.

## 2. Today

- **Samples-only booking.** Any booking under Dr. Hospital Admin is treated as samples-only (`server/services/giniflow/labOnlyVisits.js` `labOnlyPredicate`). Reception loads the saved **Lab only** journey for it (plan 86).
- **Journey vs. bill.** The check-in panel reads today's HealthRay bill through the machine/lab bill reader (`server/services/giniflow/machineSync.js`, the function ending at line ~660). That reader looks only at lab lines and machine lines. A bill with anything else (dressing, injection, procedure) returns `status: "no_tests"`.
- **Steps are dropped.** On `no_tests`, `withBilledSteps` → `dropUnbilledTestSteps` (`shared/journeyOrder.js:127`) removes Lab Collection and Lab Processing. Check-in and Report Upload are not test steps, so they stay.
- **Bill at arrival.** `arrivalQuote` / `rehearseArrivalBill` (`server/services/billing/arrivalQuote.js`, `arrivalBill.js`) price only the consultation fee and the journey's tests. They never read HealthRay bill lines.
- **The Bill tab already reads them.** `healthrayLinesForDesk` / `healthrayBillSuggestion` (`server/services/billing/healthrayBillLines.js`) match every live HealthRay bill line to a service item (`matchLines`). They skip anything already on the visit and price `price_per_patient` / zero-price items at the HealthRay amount.
- **Procedures already exist as items.** `service_items.kind` already allows `'procedure'` (`2026-10-08_billing_service_master.sql`). Doctor-ordered procedures are priced at reception (G115, G120).

## 3. Goal

1. Bill at arrival shows what HealthRay has already billed for the patient today, marked **Paid in HealthRay**, so nothing is collected twice and nothing is typed by hand.
2. A samples-only booking whose bill has procedures and no tests gets a **procedure journey**, not a lab journey.
3. A lab-only patient whose bill has tests gets exactly the journey they get today.

## 4. Design

### 4.1 Bill at arrival reads HealthRay bill lines

- **Server.** `arrivalQuote` and `rehearseArrivalBill` add the visit's HealthRay bill lines, using the same matcher as the Bill tab (`candidatesFor` → `matchLines`). They are not copied.
  - **Matched lines** become bill lines with `source: "added"`, priced the way `lineInput` already prices them (`agreed_rate` = HealthRay amount when the item is per-patient or zero-price).
  - **Lines `matchLines` skips** stay skipped: already on the visit, a held lab test, or the consultation line.
  - **Unmatched lines** are **not** created at check-in. Creating review items stays a Bill tab action. The preview returns them as `notMatched: [{ desc, amount }]` so the panel can name them.
- **Preview shape.** Each line gains `fromHealthray: true` and `healthrayAmount` (paise).
- **Panel** (`src/components/giniflow/ArrivalBill.jsx`). HealthRay lines start on the existing **Paid in HealthRay** choice (`SOURCES` already has it, and commit already accepts `alreadyPaid: [{ source: "healthray" }]`). Reception can still switch a line to Collect now, for example if HealthRay shows it unpaid. Unmatched lines are listed under the bill: "On the HealthRay bill, not in the service list: DRESSING ₹500 — bill it from the Bill tab".
- **No double billing later.** After commit the line is on the visit, so the Bill tab's `matchLines` skips it (`on_visit`). This needs no new rule.

### 4.2 Procedure journey for samples-only bookings

- **Bill reader.** It reports procedures as well. A live line that matches a service item with `kind = 'procedure'` is a procedure. The result gains `procedures: [{ name, itemId }]`, and a new status `procedures_only` when there are procedures and no lab or machine tests. Today's `no_tests` is unchanged for every other case.
- **Step catalog.** A migration adds one catalog step: `procedure`, "Procedure", 10 min, with **no station** (§7.2). Reception ticks it done from the journey button on the Arrivals row ("tick the ones the board cannot see"). It has **no chain status**, so it never puts the patient in a consultation column. The step takes the bill line's name ("Dressing") as its display name, the same way Lab Collection carries its tests.
- **Closing.** The visit does **not** close on its own when the procedure is ticked (§7.3). Reception closes it, as for any patient who has left.
- **Journey for a samples-only booking:**
  - Bill `procedures_only` → **Check-in → Procedure (Dressing)**. Lab Billing, Lab Collection, Lab Processing and Report Upload are all left out.
  - Bill with tests → the saved Lab only journey, unchanged. Any procedures on that bill are added as procedure steps after Check-in.
  - Bill `no_tests` with no procedures, `no_bill` or `blocked` → today's behaviour, unchanged.
- **Hint text** for `procedures_only`: "✓ From the HealthRay bill: Dressing — a procedure, no lab tests; lab steps were left out".
- **Server side.** The floor sync seeds samples-only visits without the panel (`ensurePlan` / `labOnlyPlan` in `journey.js`). It applies the same rule, so a patient HealthRay checked in on its own also gets the procedure journey.

### 4.3 Recognising a procedure

A line counts as a procedure **only** through the service list: it matches an item whose `kind = 'procedure'`. There is no keyword guessing on the bill text.

If DRESSING is not in the service list as a procedure, the patient still falls back to today's journey. The panel then names the line (§4.1), and admin can add or fix the item in Settings → Services. Before building, check that DRESSING (and the other common procedures: injection, nebulisation, suture removal) exist with `kind = 'procedure'`. This is a read-only query on `service_items`, with no patient data.

## 5. Out of scope

- No write-back to HealthRay.
- The Arrivals-tab badge for a patient with a second, lab-only booking (Nishu Bharaj, P_181444) is a separate plan.
- Doctor-ordered procedures during a consultation (G115/G120) are unchanged.

## 6. Tests (local e2e DB)

New `e2e/giniflow/G124-procedure-only-arrival.spec.js`:

1. Samples-only booking, HealthRay bill = DRESSING (procedure item):
   - the journey is Check-in → Procedure "Dressing";
   - Bill at arrival shows Dressing at the HealthRay amount on Paid in HealthRay, with ₹0 to collect;
   - after commit the Bill tab suggests nothing more.
2. Samples-only booking, bill with lab tests and a dressing → the Lab only journey plus a procedure step. The tests and the dressing are both on the arrival bill.
3. Samples-only booking, bill with a lab test only → journey and arrival bill identical to today (regression).
4. A HealthRay line not in the service list → not billed at arrival, named in the panel; the Bill tab still creates the review item as today.
5. Consultation booking with a dressing on the HealthRay bill → the consultation journey is unchanged; the dressing appears on the arrival bill as Paid in HealthRay.
6. Switching a HealthRay line to Collect now collects it and records the payment as today.

Existing suites to rerun: G101 (lab-only flows), G109, G110, G115, G120, the arrival-bill specs under `e2e/billing/`.

## 7. Decisions (2026-10-23)

1. **Paid default:** HealthRay lines start on **Paid in HealthRay**. Reception can switch a line to Collect now.
2. **Who does the procedure:** **no station**. The step lives only on the journey, and reception ticks it done.
3. **Closing:** **reception closes** the visit; there is no automatic exit when the procedure is ticked.
4. **Which items count:** **any service item of kind `procedure`**. The service list already marks 2,858 items as procedures (dressing, injection, nebulisation, …, checked 2026-10-23), so the service list decides and there is no code list. DRESSING matches `PROC-DRESSING` (₹500, procedure).

## 8. Rollout

- One migration (the `procedure` catalog step). Code reads it tolerantly, so local dev on the production DB keeps working before it runs.
- No change to bill pricing rules, payment recording, lab orders, or the samples-only predicate.

## 9. Built (2026-10-23)

- Migration `2026-10-23_procedure_journey_step.sql`: catalog step `procedure` ("Procedure", 10 min, Reception / reception, no chain status).
- `shared/labOnly.js`: `PROCEDURE_STEP`, `procedureStep()`, `withProcedure(steps, procedure, { only })`. `only` keeps Check-in and anything the desk added by hand.
- `healthrayBillLines.js`: `billedProcedures()` (live non-consultation, non-lab lines that match a `kind = 'procedure'` item), `healthrayBillWaiting()`, and `healthrayLinesAtArrivalIn()`, which shares `billableDue()` with the Bill tab's `healthrayLinesForDesk`.
- `journey.js`: `procedureStepFor()`. `ensurePlan` adds the procedure step for samples-only visits, replacing the lab steps when the bill has no lab or machine tests.
- `machineSync.js` `healthrayBillSteps`: returns `procedure`, and status `procedures_only` when the bill has procedures and no tests.
- `arrivalBill.js`: preview and commit add the matched HealthRay lines (`fromHealthray`) and return `notMatched`. The fast quote is skipped when the HealthRay bill has non-consultation lines.
- Reception check-in panel: `procedures_only` hint; samples-only journeys go through `withProcedure`. `ArrivalBill.jsx` sets HealthRay lines to Paid in HealthRay (once per line, so switching to Collect now sticks), tags them "on the HealthRay bill", and names unmatched lines.
- e2e `G124-procedure-only-arrival.spec.js`: 5 tests, all passing.
