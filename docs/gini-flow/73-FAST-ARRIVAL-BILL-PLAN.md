# 73 — Fast bill at arrival

Status: plan (19 Oct 2026). Approved to build the same day ("yes write the plan and make it fast").

## Problem

Reception presses **✓ Arrived** and waits a long time on "Working out the bill…" before the consultation fee, tests and payment options appear. The reception team can't wait that long at the counter.

Measured on 19 Oct:

- One database query from the production server (Railway, Singapore) to the database (Supabase, Mumbai) takes about 50–100 ms. One query from this machine takes 31 ms.
- The bill preview from plan 72 rehearses the whole check-in inside a transaction and then rolls it back. For a normal 8-stop journey with one lab test that is **154 queries one after another**, about 8–10 seconds on production. Of these:
  - 107 are the rehearsed check-in: steps, events, orders, a draft bill and two reprices;
  - 47 are the bill build: consultation, floor tests and the view.
- The panel ran that preview two or three times per press, one after another, because every run locks the visit:
  - once for an empty journey, because the debounce starts from `steps: []`;
  - once for the template steps;
  - again when the HealthRay bill arrived and added test steps.

Caching repeated reads inside the rehearsal doesn't help: only 2 of the 154 reads repeat between writes.

## Change

### 1. The panel prices the journey once (built)

`CheckInPanel` (`src/pages/giniflow/ReceptionStationPage.jsx`) starts the preview only when all of these hold:

- the debounced journey equals the current steps;
- the HealthRay bill has loaded;
- the steps were built with that bill.

So a press runs one preview, not three.

### 2. A read-only quote for a visit with a clean slate

New `server/services/billing/arrivalQuote.js` `arrivalQuote(visitId, { add, remove, plan }, ctx, db)`.

It writes nothing and takes no locks. It works out the lines check-in would put on the draft, then prices them once with the same pricing engine (`priceBill`). That takes 15–30 queries, about half of them the pricing engine's own reads.

**Clean slate** is the usual arrival. The quote runs only when all of these hold, checked in one query:

- the visit isn't arrived yet (booked, no-show or cancelled);
- it has no bill of any status, no test order and no journey steps;
- there are no carried-over tests to offer;
- there is no HealthRay lab case for the patient that day.

Anything else (a returning patient with a draft, carried tests, a lab case, a sample taken earlier) goes to the existing rehearsal, unchanged.

**Lines**, following the code check-in runs:

1. **Journey tests.**
   - The steps go through `stepsAllowedByBill` with the stored HealthRay bill, and through `withoutChief` when the consultant sees patients directly.
   - Lab tests come from the Blood Sample steps (`labTestsOf` / `billedLabTestsOf`).
   - Picked tests must be in the catalogue (`testPricesFor`). If not, the rehearsal's own note comes back ("Not in the test catalogue: …") and no journey tests are added, exactly as the rehearsal rolls the journey back.
   - Machine steps add the machine's first test (`machine.tests[0]`). A machine with no price returns the same refusal note as `addMachineTestOn`.
   - Each test name becomes a service item through `TEST_MATCHES_SQL`, one line per item. Items the desk removed earlier (`REMOVED_BY_DESK_SQL`) are left out.
2. **Consultation.**
   - The same rule as `arrivalConsultationIn` / `consultationItem`.
   - The doctor comes from the journey: the first `with_doctor` step with a doctor, Chief first, then `sd_consult`, then step order. Otherwise the appointment's doctor or the assigned one.
   - A walk-in's visit type comes from the chosen visit type.
   - A removed doctor adds nothing.
3. **Desk changes.** Items added at the desk are added if not already there. Removed items are dropped.

**Price.**

- The lines are priced together on a draft that isn't saved: the patient, the appointment, the starting category from `resolutionFor` / `startingCategory`, and the visit date. This uses one new export from `bills.js`, `priceUnsavedDraft`.
- A line the engine can't price (`price_missing`) is dropped and the rest are priced again, as the rehearsal skips it.

**The answer has the same shape as the rehearsal:** `{ billId: null, lines, outstanding, carry: [] }`, plus `journeyNote` when there is one.

### 3. Money stays exact

The commit doesn't change. Check-in raises the real orders, and `commitArrivalBill` builds the real draft and compares it with `expectedTotal`.

If a quote ever differs from what check-in builds, nothing is collected: the existing `amount_changed` path shows reception the real total to collect. The quote can't make anyone pay a wrong amount; at worst it costs one extra press.

## Expected effect

- Before: 154 queries × 2–3 runs ≈ 15–25 s.
- After, for a clean slate: one quote of 15–30 queries, about 1–2 s.
- Other visits: one rehearsal, about 8 s, down from 2–3 runs.

## Not changed

- Check-in and collection (`checkInWithJourney`, `commitArrivalBill`).
- The GET preview used on the Bill step after check-in.
- Consultation rules, payment rules and the lab gate.

## Tests (e2e, test DB only)

`e2e/billing/phase4/P4C-51-fast-arrival-quote.spec.js`. Each scenario runs the quote and the rehearsal on the same visit and asserts the same items, amounts and outstanding total:

1. Consultation only (booked follow-up).
2. Consultation + a HealthRay-billed lab test.
3. Consultation + a picked lab test + a machine step.
4. A test not in the catalogue: same note, no test lines.
5. A desk add and a desk remove.
6. A consultant who sees patients directly (Chief step dropped).
7. Not a clean slate (a draft already exists): the rehearsal runs, and the answer is marked as such.
8. The quote writes nothing: no bill, order, step or audit row afterwards.
9. Query count: the quote stays under 35 queries.

Rerun P4C-13, P4C-43, P4C-50, P4-38 and G100.
