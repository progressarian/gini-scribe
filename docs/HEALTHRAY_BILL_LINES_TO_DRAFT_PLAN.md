# HealthRay bill items reach the Scribe draft without opening the Bill tab

## Problem

The worker reads each patient's HealthRay bill in the background
(`machineSync.js` → `readPatientBill` → `giniflow_patient_bills`). That read
already:

- marks test orders paid,
- raises machine orders, and
- sets the journey steps.

It does **not** put HealthRay's items on the Scribe bill. That happens only at
two points:

1. **Check-in**: `arrivalBill.js` → `healthrayLinesAtArrivalIn`.
2. **Reception opening the patient's Bill tab**: `deskOpen.js` →
   `healthrayLinesForDesk`.

A HealthRay invoice raised after check-in therefore sits outside Scribe until
someone opens that bill. Example: P_182320 (27 Oct). Check-in was at 11:02.
HealthRay invoice OPD/2627-17528 (Microalbumin/Creatinine Ratio ₹500 + ABI,
VPT, Fundus ₹800) was read at 11:29. The ₹500 lab line was on no Scribe bill
until the Bill tab was opened, and the billing reports were short by that
amount meanwhile.

## Change

When the background read finds **new** HealthRay items for a visit, the same
transaction adds them to that visit's draft. It uses the same matching the Bill
tab uses (`candidatesFor` → `matchLines` → `billableDue` →
`addLinesToDraftIn`), so a line added in the background is identical to one
added by opening the Bill tab:

- **Same item matching**: aliases, then the test catalogue, then exact name.
- **Same price**: Scribe's rate, or HealthRay's amount for items priced from
  HealthRay (`price_from_healthray`).
- **No duplicates.** Lines are skipped when the item is already on the visit,
  when the test was already cleared at reception, or when the desk removed it
  (`REMOVED_BY_DESK_SQL`). A line the desk deleted is never put back.
- **Consultation lines are not touched.** They keep coming from the visit, as
  today.

**Not changed:** settling ("Paid in HealthRay") and **Finalise** stay buttons
at the counter. The background never marks money collected, finalises,
cancels, credits or removes a line.

### When it runs

- Only when the read actually brings new items. The new item keys
  (`billLineKey`: HealthRay item id, or invoice + description) are compared with
  the previous stored bill. A re-read that changes nothing writes nothing, so
  there is no extra database load on quiet polls.
- Only for visits that have arrived (not `booked`) and are not merged. Exited visits
  are already handled by the late-test path (`reopenForTests`) and get the same
  step.
- Right after the existing per-visit work in `syncMachineOrdersForVisit`
  commits, in its own short transaction
  (`healthrayLinesInBackground`). It locks the visit, then the draft, the same
  lock order the sync uses. A billing failure is logged and never rolls back the
  step and order sync. There is no new loop and no new HealthRay call.

### A draft being edited at the counter

- The lines are added even if reception has the draft open. The bill version
  goes up, so the counter gets the existing "this bill changed — reload"
  conflict on its next save and reloads with the new lines.
- The next Bill-tab open runs its normal fill. It finds the lines already
  there and adds nothing twice.

### HealthRay items with no matching Scribe service

- They are left for the counter. The background adds matched items only.
  Unmatched ones still become a "HealthRay review" line when the Bill tab is
  opened (`ensureReviewService`), as today.

### What staff see

- **Bill tab**: the line shows exactly as if the Bill tab had added it on open,
  priced from HealthRay where the item is priced that way. No new UI.
- **Payments tab**: the existing "HealthRay bill waiting" flag
  (`healthrayBillWaiting`) shows until the bill is settled.
- **Billing reports**: they include the draft line as soon as it is added, the
  same as a line added at the counter.
- **Audit**: every added line writes `billing_audit` through
  `addLinesToDraftIn`. The actor is the last staff member who worked on that
  visit's bills or lines (latest `billing_audit` actor on them). With none, it is
  the system user (`actor_id` NULL).

## Decisions (27 Oct 2026)

1. HealthRay item with no Scribe service: leave it for the counter.
2. Draft open at the counter: add the lines anyway. The counter reloads on the
   version conflict.
3. Recorded as: the last reception user on that bill (system user if none).

## Not in scope

- Automatic "Paid in HealthRay" or Finalise.
- Removing Scribe lines that HealthRay doesn't have. That stays
  `correct-bills-to-healthray.mjs` / the counter.
- Any change to how often HealthRay is polled.

## Tests (`e2e/billing/phase5/`, local test DB)

1. A HealthRay invoice that arrives after check-in (lab + machine) puts its
   lines on the draft in the next sync run, with HealthRay's price where that
   applies. The consultation line is unchanged.
2. A re-read with the same items adds nothing and writes no audit rows.
3. A line the desk removed is not added back.
4. A test already cleared at reception is not added twice.
5. A draft open at the counter gets the lines, and a save from the counter's
   older version is refused with the reload message.
6. The audit row is recorded as the last reception user on the bill, or as the
   system user when there is none.
7. An unmatched HealthRay item is not added in the background. Opening the Bill
   tab still adds it as a review line.
8. Nothing is finalised or marked paid. The bill stays a draft and the payment
   stays due.
9. An exited visit that gets a late HealthRay item gets the line as well as the
   reopened step.
