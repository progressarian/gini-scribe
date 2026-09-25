# Billing Counter — floor trial checklist (P4-38)

One reception user bills real patients for one OPD session with a
reception_admin beside them. The point is to find what the tests could not:
real patients, real categories, real pace. Every problem found becomes a fix
**with** an e2e test that reproduces it first, or a logged task.

---

## 1. Before the day — all must be true

**Data (from the admin team)**

- [ ] Service master filled and imported (P0-06 → P2-13): every consultation,
      test, procedure and dressing billed at Gini has an item.
- [ ] Categories, rates and payment rules filled and imported (P0-07/08 →
      P3-23): CGHS and its sub-categories (Paid, Referral, Pensioner), any
      insurers. **General is not a category row** — a patient with no category
      is General, and the counter shows the badge **General** and the list's
      first entry **General (no category)**. Do not create a "General"
      category; if one exists, patients are not in it unless someone puts them
      there.
- [ ] CGHS Paid asks for the card number (**Card number required** on the
      sub-category), Referral for the referral number and scan (**Needs a
      referral**, **Needs the referral scanned**). If the CGHS bill must carry
      the category and the masked card number, tick **Print the category on
      the bill** on each CGHS sub-category — without it the bill PDF shows
      neither.
- [ ] Billing settings entered (P0-09): legal name, bill footer, GST left
      **off** unless registration is done.
- [ ] Bill and receipt number series exist for the current financial year
      (`MAIN` and `RCPT`) — without them finalise and payments refuse.
- [ ] A consultation item exists for every doctor on the day's roster, for New
      and Follow Up — otherwise the draft has no consultation fee. Check
      **Settings → Services → Not priced → Consultants without a fee**: none
      of the day's doctors may be listed (a hospital-wide default item covers
      a doctor with no fee of their own).
- [ ] **Settings → Services → Not priced** is empty for the tests ordered on a
      normal day — an unpriced test cannot be billed. It matters twice over:
      when an unpriced test is on the **same order** as a priced one, paying
      the bill releases the whole order to the lab and records it as paid in
      full, so the unpriced test is done free (rehearsal problem 10).
- [ ] Referral scans upload on production: open any patient's Referral bill
      on the counter and attach a small PDF. "Storage not configured" means
      the scan cannot be stored, and a Referral bill cannot be made final
      without it.

**Code**

- [ ] The full billing suite is green on the build being deployed, and
      `P4-38-floor-trial-rehearsal.spec.js` passes against it.
- [ ] P4-42 (reception money on the bill) and the P4-38 rehearsal fixes are
      merged, and **the API has been restarted** on that build (the
      consultation fix is server-side).
- [ ] **Know what deploying turns on.** From the moment this code is live,
      **every check-in in Scribe (Arrivals or walk-in) creates a draft bill
      with the doctor's consultation, and every test order adds a bill line —
      for every patient, not just the trial ones.** This is not behind a
      switch. Patients checked in only by the HealthRay sync get their draft
      and consultation when the counter first opens them. Opening a patient
      whose bills are all final also opens an empty draft. Drafts are harmless
      (no money, no number), but deploy on the morning of the trial, not days
      before.

**The one switch**

- [ ] `SCRIBE_BILL_TAKES_TEST_PAYMENTS` — **leave it off (`0`) for the trial.**
      With it on, reception's Payments tab refuses to take money for any test on
      a bill line, which on the day would mean _every_ priced test for _every_
      patient. Turn it on only when the counter is used for all patients.
      While it is off, the rule below prevents a double charge.

**People**

- [ ] One reception user at the counter, briefed on this sheet.
- [ ] One reception_admin present — they answer Desk requests
      (bill again / new item) and can close another desk's shift.
- [ ] Reception told: **trial patients pay only at the Billing Counter** — not
      on the Payments tab — for everything, tests included.

---

## 2. On the day

**Start**

- [ ] Open the shift on the counter (**Shift** tab) with the opening cash
      actually counted. Card and UPI need no shift; cash is refused without
      one.
- [ ] **Realtime check (supervised, once, at the start).** Realtime was
      proven on a local Supabase stack (P4C-03) but not against production's
      own Supabase settings:
  1. Two machines. A: reception_admin on **Settings → Desk requests**. B:
     reception on the Billing Counter with a patient's draft bill open.
  2. On A, DevTools → Network → WS: there should be a socket to
     `…supabase.co/realtime/v1/websocket`. If not, realtime is off — every
     step below will take up to 15 s instead of ~2 s; note it and carry on.
  3. On B, request a new item (search for something that doesn't exist →
     **Request new item** → **Send request**). Within 2 s the row appears on A
     under "Waiting for an answer", no reload. 10–15 s means the poll carried
     it: realtime isn't delivering.
  4. On B, ask to bill an item again; on A, approve it. Within 2 s B's
     **My requests** shows Approved, no reload.
  5. On A, reject another waiting request; B updates within 2 s.
  6. Fail if any step takes longer than 20 s — then even the poll is broken.

**Cover at least one of each** (tick as done, note the bill number)

| Case                            | What to check                                                                                                                                                                                             | Bill no. |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **General** patient             | badge **General**; consultation fee from the doctor and visit type already on the draft; tests added from the MO's order (a test ordered while the bill is open appears within ~15 s)                     |          |
| **CGHS Paid**                   | one tap on the suggested "CGHS › Paid"; card number asked for and shown masked (`XXXX1234`) after **Save numbers**; patient pays their part, the rest shows as Claimed; **CGHS pending** after finalising |          |
| **CGHS Referral**               | referral number **and** scan asked for; **Finalise & print** stays disabled, listing both, until they are saved                                                                                           |          |
| **Pensioner**                   | ₹0 to pay; button reads **Finalise & print**; badge **CGHS pending** afterwards; lab test starts without a payment                                                                                        |          |
| **Discount code**               | code accepted and shown as "CODE · name · ₹ off"; a wrong code refused in words                                                                                                                           |          |
| **Bill again**                  | same item twice → greyed → "Ask admin to bill again" → approved in **Settings → Desk requests** → **Add to bill** in My requests → added once                                                             |          |
| **New item**                    | search finds nothing → "Request new item" → admin **Create item** with a code, subgroup and price → **Add to bill** → added at that price                                                                 |          |
| **Card / UPI**                  | reference required (Take payment stays disabled without it); receipt printed                                                                                                                              |          |
| **Cash**                        | taken with the shift open                                                                                                                                                                                 |          |
| **Pay later** (only if allowed) | tick **Pay later** → bill final with a balance; shows on the **Dues** tab; **Take payment** from there                                                                                                    |          |
| **Second bill**                 | a test ordered after the first bill was finalised: the counter says "A new draft bill is open on this visit" → **Open the new draft bill**; the first bill is under "Earlier bills on this visit"         |          |
| **Cancel**                      | an unpaid final bill cancelled with a reason (an earlier one is reopened from **Earlier bills → Open**), then **Start a new bill for this visit**; a paid one shows no Cancel button                      |          |
| **Lab gate**                    | a paid test is released to the lab; an unpaid one (pay later, or a test on its own unpriced order) is not                                                                                                 |          |
| **Print**                       | bill PDF opens on Finalise & print; **Print receipt** gives one page per payment (a split payment is two receipts)                                                                                        |          |
| **Bill button**                 | on reception's Arrivals row, opens the counter for that same patient in a second tab                                                                                                                      |          |

**If something goes wrong**

- **Stop using the counter for that patient** and let reception handle them as
  today — with the switch off, nothing on reception is blocked.
- **An unpaid bill** can be cancelled on the counter.
- **A paid bill cannot be refunded at the counter** — the refund services exist
  (P4B-03…07) but there is no screen for them yet (P4B-10). Handle it the way
  reception does today, and log it. This is the main reason to go slowly on
  payments.
- **A bill that looks out of date** (a line missing, a refusal naming a new
  version): press the patient in the list again, or **Save draft** — both
  read the bill again.
- Note the patient, bill number, time, screen, what happened and what was
  expected, and take a screenshot.

**End**

- [ ] Close the shift with the counted cash; note the difference shown.
- [ ] Compare each trial patient's bill with what HealthRay billed for the same
      visit — HealthRay is still the record.

---

## 3. After the day

- [ ] Every problem is either fixed (with a test that reproduces it first) or
      written up as a task in `52-BILLING-TASKS.md`.
- [ ] Decide with the team: go live for all patients (turn
      `SCRIBE_BILL_TAKES_TEST_PAYMENTS` on), run a second trial, or wait for
      refunds (Phase 4b).
- [ ] Mark P4-38 done with what was found.

---

## Rehearsal (2026-09-25)

**What was run.** The whole of this sheet on the test system (web 3100, API
3101, test database), in a real browser, as `reception` at the counter and
`reception_admin` on Desk requests. The day was seeded with a random tag and
removed afterwards: CGHS with Paid (card required, patient pays 50 %),
Referral (number and scan required, pays nothing) and Pensioner (pays
nothing); New and Follow Up consultation items for Dr Rahul and Dr Beant;
HbA1c and Lipid linked to items, Uric acid deliberately unpriced; a 10 %
discount code; `MAIN` and `RCPT` series; legal name, footer, pay later on.
Six patients were checked in on reception's Arrivals screen, tests were
ordered through the doctor's order endpoint, and every row of the table above
was walked on the counter, ending with the shift closed ₹50 short. It is
encoded as `e2e/billing/phase4/P4-38-floor-trial-rehearsal.spec.js` (one test,
the whole day) — run it before the real trial.

**What was found and fixed** (each with a test that failed first):

1. **Checking in on Arrivals made no draft**, and the HealthRay sync never
   makes one either, so the counter opened an empty bill with no consultation
   fee. Arrivals now drafts at check-in, and the counter adds the doctor's
   consultation when it opens a visit that has never had one (not again after
   the desk removes it or once a bill is final; again after a cancel).
   Server-side — needs the API restarted. `P4-38b` (5 tests).
2. **A General patient could never be finalised.** The counter demanded
   "Confirm the patient's category first" and offered no way to answer
   "General"; the server bills a patient with no category as General. The badge
   now reads **General** and the list's first entry is **General (no
   category)**; only a bare parent (CGHS with no sub-category) still blocks.
   Every earlier counter test had set a category, which hid this. `P4-38c`
   8–9.
3. **A test ordered while the bill was open never appeared**, and pressing the
   same patient did nothing — a payment would then be refused as stale. The
   counter now re-reads a draft the server has moved on, and pressing the open
   patient reads the bill again. `P4-38c` 2–3.
4. **Second bill was a dead end** after finalising: nothing showed the new
   draft. The counter now offers **Open the new draft bill**. `P4-38c` 4.
5. **Earlier bills were print-only**, so a ₹0 CGHS bill or a finalised bill
   could not be reopened to cancel it or reprint its receipt once the desk had
   moved on. **Open** added. `P4-38c` 7.
6. **After a cancel the screen sat on the cancelled bill.** **Start a new bill
   for this visit** added. `P4-38c` 5.
7. **An accepted code showed only its letters**; it now reads "CODE · name ·
   ₹ off". `P4-38c` 1.
8. **An empty draft said "No payment is needed on this bill."** It no longer
   does. `P4-38c` 6.

9. **While the item search caught up with typing, the old results stayed
   clickable** — a quick click added the wrong item. Add is now held until the
   results match what was typed. `P4-38c` 10.

**Still open** (reported, not fixed here):

10. **An unpriced test on the same order as a priced one goes to the lab free.**
    Paying ₹450 for HbA1c on an order that also held Uric acid (₹200, no item)
    marked the whole ₹650 order paid and released both. `settleOrder` in
    `server/services/billing/payments.js`. Until fixed, keep **Not priced**
    empty.
11. **Referral scans need Supabase storage.** On the test system the upload
    says "Storage not configured" (the spec stands storage in), a document row
    is left behind, and the Referral bill cannot be finalised. Check it on
    production before the day (section 1). The upload also runs the documents
    pipeline's extraction and pushes the letter to the patient's app — decide
    whether a referral letter should go there.
12. **The CGHS bill PDF shows neither the category nor the masked card
    number** unless **Print the category on the bill** is ticked on the
    sub-category (section 1). Otherwise the bill and receipt PDFs read
    correctly; a split payment prints one receipt page per payment.
13. **Opening a patient whose bills are all final opens an empty draft**
    (`openDraft` always opens one). Harmless, but it shows in the visit's list.
14. **The shared test database makes the billing specs step on each other**:
    `billing_settings` is one row that several specs rewrite, fourteen P4
    specs delete the reception user's cash shifts, and the P4 fixture deletes
    the year's bill series on teardown. The rehearsal re-creates its series
    before each finalise and refuses to start on a shift it does not own; run
    it alone.
    **What changed on this sheet**: General is no category, not a row; the
    card/referral/print settings named; Consultants without a fee; the storage
    check; the API restart; what deploying turns on for HealthRay-synced patients;
    the realtime check (proven separately on a local Supabase stack, P4C-03); the
    table rows now say what the screen actually shows; refunds wording.

**Verdict.** With the API restarted on this build, the counter is ready for a
supervised floor trial. Item 10 is avoided by an empty **Not priced**; item 11
must be checked on production first — a Referral patient cannot be finalised
without a stored scan.
