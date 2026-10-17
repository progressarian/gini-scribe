# 71 — Rapid blood sugar is a nurse test, not a lab sample

Status: built 17 Oct 2026.

## Problem

"Blood Sugar" (₹30) is a rapid strip test. A nurse pricks the finger and reads a glucometer. No sample is drawn and the lab team has nothing to do with it.

HealthRay bills it under Pathology. So when reception builds the journey, it lands in the Blood Sample step like any lab test. That raises a floor lab order, and after payment it waits on Lab 1 under "To call — test ordered" with **Start collection** (Jyoti Kansal P_10880 and Dikshit Garg P_157560, 15 Oct).

Since 1 Sep there have been 14 such orders:

- 8 were clicked through to "sent" or "uploaded" by the lab for nothing;
- 4 were still open;
- the rest had Blood Sugar mixed in with real lab tests.

The venous glucose tests are different. Glucose Fasting, Glucose - Random Blood and PP (₹50, drawn by the lab) **are** lab samples and do not change.

## Rule

A HealthRay bill line named exactly **Blood Sugar** (case and spacing ignored) is a nurse rapid test:

1. **Charged.** The ₹30 goes straight onto the visit's Scribe draft bill as an `added` line (service item "Blood Sugar"), with no lab order and no Payments-tab card. The counter collects it with the rest of the bill.
2. **Never a lab order.** It does not go into the Blood Sample step or a lab order, so it never shows on Lab 1, Lab 2, the lab tiles or the lab pending counts.
3. **Mixed bills.** When it comes with real lab tests, only the real tests go to the lab.
4. **Never holds the patient.** It cannot block the exit or the lab step.
5. **Not a lab line anywhere else.** It doesn't count as a lab line for HealthRay auto-cancel or for "is this HealthRay case on the bill".

A doctor, MO or desk order for "Blood Sugar" from the test catalogue still goes to the lab as before (decision 4).

The list lives in one shared place (`shared/nurseTests.js`), so another strip test can be added later by name.

## Changes

- `shared/nurseTests.js`: `NURSE_RAPID_TESTS = ["blood sugar"]` and `isNurseRapidTest(name)`.
- `server/services/giniflow/patientBill.js`:
  - `billedLabLines` skips nurse rapid tests. Everything that turns bill lines into lab orders or lab steps reads this one function: the check-in journey suggestion, the bill sync and reception's HealthRay lab money.
  - New `billedNurseTestLines(bill, opts)` lists the nurse tests on the bill.
- `server/services/billing/visitLines.js` `linesForNurseTests(visitId, names, ctx, db)`:
  - adds the matching service item to the visit's draft as an `added` line;
  - skips it when a live line for that item is already on a bill of the visit;
  - skips it when the desk removed that line (`REMOVED_BY_DESK_SQL`), so the sync never puts back something reception took off.
- `server/services/giniflow/machineSync.js`: the bill sync calls it next to the other HealthRay charges, for visits still on the floor.
- `server/services/giniflow/testCancel.js` `cancelDeadBillTests`: lab cases are auto-cancelled only when the real lab lines are all gone. Blood Sugar neither keeps them alive nor kills them.
- `server/services/giniflow/testsHold.js`: a HealthRay case counts as "not on the bill" when the bill has no live lab line other than nurse tests (`NOT_NURSE_RAPID_TEST_SQL`).
- `server/services/healthray/billingExtractor.js`: the patient-flow check-in suggests no Blood Sample step for Blood Sugar.

## Production clean-up (done 17 Oct)

The 4 open Blood Sugar-only orders were cancelled from the floor with "Rapid blood sugar — done by nurse, no lab sample" and no refund:

- Jyoti Kansal, Dikshit Garg, Ratan Goyal: paid; payment kept on the cancellation record.
- Sawinder Kaur (8 Oct): unpaid. Her ₹30 line left her Scribe draft. The draft's HOMA-B and HOMA-IR then repriced from ₹1 to ₹0 at the current price list, with the user's OK.

## Decisions (17 Oct 2026)

1. Only **Blood Sugar** (₹30) for now. Glucose Fasting, Random and PP stay lab tests.
2. No payment wait. The nurse does it any time.
3. The open Blood Sugar-only orders are closed on production.
4. A doctor, MO or desk catalogue order for Blood Sugar stays orderable and goes to the lab as before.
5. The HealthRay-billed ₹30 is added to the Scribe bill automatically.

## Known limits

- A Blood Sugar billed in HealthRay only after the patient has exited is not added to the Scribe bill, because the sync adds charges only while the visit is on the floor.
- A Blood Sugar refunded in HealthRay after its line reached the Scribe draft is not removed automatically. Reception removes it at the counter.

## Tests

`e2e/giniflow/G100-rapid-blood-sugar.spec.js`:

- the name rule;
- billed lab lines and step ids;
- no lab order for Blood Sugar only;
- a mixed bill orders only the lab test;
- HealthRay case on-bill check;
- auto-cancel;
- legacy check-in steps;
- the Scribe bill line added once by the sync.

The bill, lab payment and lab station suites were rerun.
