# 80 — "Paid · not final" badge for paid draft bills

Status: built (20 Oct 2026). Answers: Q1 yes, Q2 yes (an offer, never automatic), **Q3 no** (no Dues-tab list for earlier days). See "As built".

## 1. Ask

> "Plan the paid-not-finalised badge fix."

On 20 Oct, at 12:45, 7 of the day's 11 draft bills were **fully paid but never finalised**: no bill number and no final invoice. All 7 were paid with "Paid in HealthRay":

| Patient            | File no  | Floor       | Total  |
| ------------------ | -------- | ----------- | ------ |
| Arti Budhiraja     | P_182240 | left        | ₹1,400 |
| Priyanka Chaudhary | P_176620 | left        | ₹405   |
| Ishika             | P_176076 | left        | ₹945   |
| Vijay K Kaushal    | P_6000   | left        | ₹1,920 |
| Manjeet Kaur       | P_114410 | vitals done | ₹2,000 |
| Adeeba Khan        | P_182192 | checked in  | ₹150   |
| Sanjay Singla      | P_180824 | checked in  | ₹4,110 |

## 2. Why nobody notices

- **The badge.** `billState()` (`server/services/billing/counterPatients.js`) returns the same `paid` state for a final bill and for a fully paid draft (`PAID_DRAFT_SQL`). So the Bill tab list and the reception Arrivals rows show the same green **Paid** for both.
- **The list group.** `groupOf()` puts a paid draft under **Billed today / exited**, the same as a finished bill. Plan 66 decided this on purpose ("the paid draft is kept, counts as billed"), so the patient isn't chased for money they have already paid.
- **"Paid in HealthRay"** records the money on the Scribe bill and leaves it as a draft. Only the arrival bill (plan 66) tries to finalise by itself. The counter's Paid in HealthRay and Take payment buttons don't.

Nothing about the money is wrong. What is missing is the **final bill**: no bill number, no printable invoice, and it isn't in the final-bill reports.

## 3. The fix

### 3.1 New state: `paid_draft`

- `shared/billingVocab.js`: add `COUNTER_BILL_STATE.PAID_DRAFT = "paid_draft"`.
- `billState()` order: due → draft → claim pending → **paid_draft** (any paid draft on the visit) → claim cleared → paid → none. A visit with one final bill and one paid draft still reads **paid_draft**, because something is still not final.
- `groupOf()` is **unchanged**. A paid draft stays under Billed today / exited (plan 66), and only its badge changes.
- The counter response adds a day count `paidNotFinal` (visits with at least one paid draft) for the summary line in §3.3.

### 3.2 The badge

`BILL_BADGE` in `PatientList.jsx` (also used by the reception Arrivals rows through `BillBadge`):

```text
[Paid · not final]   amber outline, the words carry it, not the colour
[Paid]               green, as today, for final bills only
```

- Its tooltip, also used as the accessible description: "Fully paid, but the bill isn't final yet — open it and press Finalise & print to give it a bill number."
- It reuses the existing `bc-badge` style with a new `bc-badge--unfinal` tone in `billingCounter.css`, so there is no new component.

### 3.3 Bill tab list: count and filter

At the top of the patient list, shown only when the count is above 0:

```text
⚠ 7 paid, not final   [Show them]
```

- **Show them** filters the list to those patients. The button reads **Show all** while the filter is on, and the filter is remembered in the URL (`?unfinal=1`), like the other counter filters.
- Patients who have **left** sort first, because nobody will come back to the counter to prompt them.

### 3.4 On the bill itself

On a fully paid draft, a banner sits above the bill actions:

```text
Paid in full — not final yet. Finalise & print gives it a bill number.
[Finalise & print]
```

- If finalising is blocked, the banner lists the reasons from the existing `finaliseBlockers()`, for example "Choose a sub-category before this bill can be made final.". Staff then know what to fix instead of guessing.
- The banner's button is the existing finalise action, with the same confirmation and checks. There is no new finalise path.
- **Patient still on the floor:** the banner adds "Still on the floor — finalise when they leave if more may be added." Finalising early means a test added later goes on a new bill. Reception decides; nothing is blocked.

### 3.5 Not in this plan

- **No automatic finalising.** It is the safer fix, but it changes money records without a person checking the lines, and a finalised bill can't be edited. The option is in Q2.
- No change to payments, receipts, dues, reports or plan 66's grouping.
- No migration.

## 4. Questions

| #   | Question                                                                                       | Recommended                                                                                                                                             | Other choice                                                                                             |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Q1  | Also show the badge on the reception **Arrivals** rows? They use the same `BillBadge`.         | **Yes**, the same badge everywhere.                                                                                                                     | Bill tab only.                                                                                           |
| Q2  | Also offer **Finalise & print right after "Paid in HealthRay"** when it covers the whole bill? | **Yes, as an offer**: after a full payment, the banner from §3.4 appears straight away with its button focused. Nothing is finalised without the press. | Finalise automatically when fully paid (like the arrival bill). Faster, but no human check of the lines. |
| Q3  | **Earlier days:** fully paid drafts from previous days also never got a bill number.           | **Add a "Paid · not final" filter on the Dues tab** covering the last 30 days, so they can be cleared.                                                  | Today only.                                                                                              |

## 5. Tests (e2e, test DB only) — `P4C-54-paid-not-final-badge.spec.js`

1. A fully paid draft shows **Paid · not final** on the Bill tab list and on Arrivals. After Finalise & print it shows **Paid**.
2. A visit with a final bill plus a paid draft shows **Paid · not final**.
3. An unpaid or part-paid draft still shows **Draft** or **₹… due**, unchanged.
4. The count "3 paid, not final", **Show them** and **Show all** work; patients who left come first, and the URL keeps the filter.
5. The banner on a paid draft finalises through the existing action. With a blocker (sub-category missing), it lists the reason and the button is disabled.
6. A paid draft for a patient still on the floor shows the "Still on the floor" line.
7. Group unchanged: a paid draft stays under Billed today / exited (pins plan 66).
8. 1366 px and 390 px: the badge and count fit, and the keyboard reaches **Show them** and the banner button.

Rerun P4C-13, P4C-43, P4C-52 and P4-13 (finalise).

## 6. Files

- **Changed:**
  - `shared/billingVocab.js`;
  - `server/services/billing/counterPatients.js` (`billState`, `paidNotFinal`);
  - `src/components/billing/counter/PatientList.jsx` (badge, count, filter);
  - `src/components/billing/counter/TotalsAndPayment.jsx` or `BillActions.jsx` (banner);
  - `src/pages/billing/billingCounter.css`;
  - the Dues tab, if Q3 is yes.
- **New:** `e2e/billing/phase4/P4C-54-paid-not-final-badge.spec.js`.

## As built (20 Oct 2026)

- **State:** `COUNTER_BILL_STATE.PAID_DRAFT = "paid_draft"`. `billState()` returns it when any paid draft is on the visit, right after claim pending.
  - `groupOf()` is unchanged: the patient stays in Billed today / Exited.
  - `paid_draft` joins `OPEN_BILL_STATES`, so a no-show with a paid draft still appears.
- **Badge:** "Paid · not final" (`bc-badge--unfinal`, amber outline), with a title that says what to do. The Arrivals rows get it through the same `BillBadge`.
- **List:** the bar "⚠ N paid, not final [Show them / Show all]" sits at the top of the Bill tab list, and its filter shows patients who have left first.
  - **Change from the plan:** the filter is kept in the component, not in the URL. Changing the URL on the bill page goes through the leave-draft guard.
- **Banner** (`BillActions.jsx`): on a fully paid draft invoice it shows "Paid in full — not final yet." with a **Finalise this bill** button.
  - It uses the same `makeFinal`, so the confirmation, blockers and printing are unchanged. The button is named differently so it can't be confused with "Finalise & print".
  - It adds "Still on the floor — finalise when they leave if more may be added." while the patient hasn't left, and lists blockers when finalising is blocked.
- **Q2 offer:** a payment from **Take payment** or **Paid in HealthRay** sends `announcePaid(billId)` (`paidSignal.js`). The banner button takes focus only then; opening an already-paid bill doesn't move the page.
- **Side fix, from plan 78 Part 2:** the Lab sample control moved from the patient header to a card under the bill items. In the header it pushed the payments table off a 720 px laptop screen (P4C-52).
- **Tests:**
  - P4C-54 passes all 7 checks.
  - P4C-27 test 1, the pinned "paid" for a HealthRay-paid draft, is now "paid_draft" on purpose.
  - P4C-09: its Arrivals field list gained plan 78's `homeCollection`, `homeRecord` and `homeRecordsOn`.
  - P4C-52, P4C-09, P4C-13, P4C-43, P4-13, P4C-21, P4C-22 and G106 pass.
  - P4C-27 test 1 failed once and passed on retry: the dialog read "Patient —" while the list was still loading.
