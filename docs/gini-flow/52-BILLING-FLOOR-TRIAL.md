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
      P3-23): General, CGHS and its sub-categories (Paid, Referral, Pensioner),
      any insurers.
- [ ] Billing settings entered (P0-09): legal name, bill footer, GST left
      **off** unless registration is done.
- [ ] Bill and receipt number series exist for the current financial year
      (`MAIN` and `RCPT`) — without them finalise and payments refuse.
- [ ] A consultation item exists for every doctor on the day's roster, for New
      and Follow Up — otherwise check-in makes an empty draft.
- [ ] **Settings → Services → Not priced** is empty for the tests ordered on a
      normal day — an unpriced test cannot be billed.

**Code**

- [ ] The full billing suite is green on the build being deployed.
- [ ] P4-42 (reception money on the bill) is merged.
- [ ] **Know what deploying turns on.** From the moment this code is live,
      **every check-in creates a draft bill and every test order adds a bill
      line — for every patient, not just the trial ones.** This is not behind a
      switch. Drafts are harmless (no money, no number), but deploy on the
      morning of the trial, not days before.

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

- [ ] Open the shift on the counter with the opening cash actually counted.

**Cover at least one of each** (tick as done, note the bill number)

| Case                            | What to check                                                                                                      | Bill no. |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- |
| **General** patient             | consultation fee from the doctor and visit type; tests added from the MO's order                                   |          |
| **CGHS Paid**                   | category shows "CGHS › Paid"; card number asked for and shown masked; patient pays, rest claimed                   |          |
| **CGHS Referral**               | referral number **and** scan asked for; finalise refused without them                                              |          |
| **Pensioner**                   | ₹0 to pay; button reads **Finalise & print**; badge **CGHS pending** afterwards; lab test starts without a payment |          |
| **Discount code**               | code accepted with the reason shown; a wrong code refused in words                                                 |          |
| **Bill again**                  | same item twice → greyed → "Ask admin to bill again" → approved → added once                                       |          |
| **New item**                    | search finds nothing → "Request new item" → admin creates it with a price → added                                  |          |
| **Card / UPI**                  | reference required; receipt printed                                                                                |          |
| **Cash**                        | taken with the shift open                                                                                          |          |
| **Pay later** (only if allowed) | bill final with a balance; shows on the Dues tab; paid later from there                                            |          |
| **Second bill**                 | a test ordered after the first bill was finalised lands on a new draft                                             |          |
| **Cancel**                      | an unpaid final bill cancelled with a reason; a paid one cannot be                                                 |          |
| **Lab gate**                    | a paid test is released to the lab; an unpaid one is not                                                           |          |
| **Print**                       | bill PDF and receipt PDF open and read correctly                                                                   |          |

**If something goes wrong**

- **Stop using the counter for that patient** and let reception handle them as
  today — with the switch off, nothing on reception is blocked.
- **An unpaid bill** can be cancelled on the counter.
- **A paid bill cannot be refunded in Scribe** — refunds do not exist yet
  (Phase 4b). Handle it the way reception does today, and log it. This is the
  main reason to go slowly on payments.
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
