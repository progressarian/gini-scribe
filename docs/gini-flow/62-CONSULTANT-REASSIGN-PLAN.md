# 62 — Reassigning the consultant: stable/unstable, and the fee difference

Status: **phases 1–4 built** (2026-10-08).

- Phase 1 — `2026-11-15_giniflow_visit_stability.sql` (applied on production), shared comparison in
  `shared/biomarkerClassify.js`, OPD trend inputs in `server/services/opdBiomarkers.js`, sweep
  `triage.js assessStabilityDay`, chip `StabilityChip.jsx`, tests `e2e/giniflow/G68`. Readings older
  than 6 months (`STABILITY_RECENT_MONTHS`) are left out of the verdict, so a patient with only old
  reports shows "No recent reports". The HbA1c category badge on the Gini Flow screens now reads
  "HbA1c: …" so it is not mistaken for the Stable/Unstable verdict.
- Phases 2–3 — `2026-11-17_consultant_reassign.sql` (not yet applied on production),
  `server/services/giniflow/reassign.js`, `server/services/billing/consultantChange.js`, the fee
  preview in the Assign menu, the "Consultant changed" box on the Billing Counter
  (`ConsultantChange.jsx`), tests `e2e/giniflow/G69`.
- Phase 4 — the "🔴🟡✅ Triage" tab is back in the OPD Manager. Its Reassign (and Triage v3's) calls
  `POST /api/appointments/:id/consultant` (`reassign.js reassignAppointment`), which goes through
  the same reassign as Gini Flow when the appointment has a visit, and changes the consultant only
  when it has none yet. The doctor picker shows the same fee preview
  (`GET /api/appointments/:id/consult-fee`, `src/lib/consultFeeText.js`).

Found while building phase 1: the old comparison read a missing previous HbA1c as 0, so every
first-visit patient with an HbA1c showed as "Worse". Fixed in the shared file, which the OPD
Triage screens now use too.

### What was built differently from the plan below

- The money step is its own table, `consultant_changes` (one waiting per visit), not a
  `billing_requests` kind: the admin's request list and its approve button stay as they were, and
  the counter confirms it with the desk capability (R2).
- The leftover when the new consultant costs less is kept in the deposit, or raised as the
  existing deposit refund (cash / card / UPI), which still needs a second person to approve.
- A visit booked under "Dr. Hospital Admin" (samples only) keeps the old assign behaviour: only
  the Gini Flow consultant changes, never the appointment or the bill.
- R7: a consultation cleared as "paid in HealthRay" is credited into the Scribe deposit like any
  other payment (confirmed 2026-10-08).

Two things the floor asked for together:

1. Show each patient as **Stable / Unstable** from their test comparison (this visit's reports
   against the last visit's), the way the old OPD Triage screen did, so the coordinator can decide
   who should see which consultant.
2. When a patient is **reassigned to another consultant** and the two consultants charge different
   fees, the bill must follow: collect the extra, or give the difference back — kept as deposit or
   refunded.

## 1. Decisions

| #   | Decision (hospital, 2026-10-08)                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Reassigning is available on the **Gini Flow boards** (Triage board, Flow Manager) **and** the old **OPD Triage** tab.                                             |
| R2  | The money step is confirmed at the Billing Counter by **reception, reception admin or admin**.                                                                    |
| R3  | When the new consultant costs less, the desk chooses: **keep as deposit** or **refund** (cash, card, UPI, as paid).                                               |
| R4  | Reassigning happens **before the consultation**, on the basis of the reports. Once a consultant has started the consult, the patient can no longer be reassigned. |
| R5  | **Mixed** (some tests better, some worse) counts as **Unstable**.                                                                                                 |
| R6  | The person who **confirms** the money step must be **different** from the person who **reassigned**.                                                              |
| R7  | A consultation **paid in HealthRay** is brought into Scribe: the difference is settled through the Scribe deposit like any other (confirmed 2026-10-08).          |

## 2. What exists today (from the code, 2026-10-08)

**Fees.** A consultant's fee is a `service_items` row with `kind = 'consultation'`, keyed by
`(doctor_id, visit_type)`; a `NULL` doctor row is the clinic default for that visit type
(`2026-10-08_billing_service_master.sql:88-90`, Settings → Consultant Fees). Category rates and
discounts apply on top (`priceLine.js`).

**Which doctor the bill uses.** `appointments.doctor_id` (or a doctor matching
`appointments.doctor_name`) first, and `giniflow_visits.assigned_doctor_id` only when the
appointment has none (`visitLines.js:73-90`).

**What each reassign writes today.**

| Where                                            | Writes                                                | Bill follows?                    |
| ------------------------------------------------ | ----------------------------------------------------- | -------------------------------- |
| Triage board / Flow Manager (`triage.js assign`) | `giniflow_visits.assigned_doctor_id` + a triage event | Almost never — appointment wins  |
| Reception check-in pick (`journey.js`)           | `assigned_doctor_id`, only when empty                 | Only if the appointment has none |
| Old OPD Triage (`patchCategoryDoc`)              | `appointments.doctor_name` only (tab is hidden today) | Only if `doctor_id` is empty     |
| Gini Flow sync (`appointmentSync.js:622-633`)    | `assigned_doctor_id`, **only when empty**, no event   | —                                |
| HealthRay sync (`healthray/db.js:742`)           | `appointments.doctor_name`, **on every poll**         | Yes, when `doctor_id` is empty   |

The last row matters: HealthRay appointments carry a `doctor_name` and usually no `doctor_id`, and
the HealthRay sync writes HealthRay's name back on every poll. A reassignment that only changed
`doctor_name` (what the old OPD screen does) is silently undone a few minutes later.

**What happens to the bill.** Nothing, in every state. Once a consultation line exists
(`consultationSettled`, `visitLines.js:158-175`) a new consultant's fee is never added, a draft
keeps the first consultant's fee, and a paid bill is never touched.

**Tools we can reuse.** A visit may have a second invoice (only one _draft_ per visit). A bill can
be paid from the deposit. Credit notes on a final bill come two ways today:

- a **line refund** — only through a refund request approved by a second person
  (`billingRequests.js approveRefund`), paid out on the Refunds board, or kept as deposit;
- a **discount after finalising** — the desk alone, no approval (`creditNotes.js
discountFinalBill`, `POST /bills/:id/final-discount`).

A consultant change is closer to the second: it re-prices one line, it does not refund a service.

**Paid in HealthRay.** A bill can be cleared as "paid in HealthRay" (`payments.js
clearInHealthray`): the money is in HealthRay's books, not Scribe's drawer. "Keep as deposit"
today moves the full amount into the Scribe deposit whatever way it was paid (`refundLegs`), so a
HealthRay-paid consultation credited into the deposit would create Scribe money the drawer never
received. §7 handles this case separately.

**Stable / unstable.** Gini Flow already sorts every visit into five categories, but from **HbA1c
alone** (`triage.js categoriseHba1c`). The old OPD Triage compared HbA1c, FBS, BP, LDL, TG, UACR,
eGFR and more (`src/utils/biomarkerClassify.js classifyComposite`, browser-only) into Worse /
Mixed / Better / Stable / First.

## 3. Worked example

Rakesh, follow-up. Booked with **Dr A (₹800)**, paid ₹800 at check-in. His reports are worse than
last time, so the coordinator moves him to **Dr B (₹1,200)**.

| Step | What happens                                                                                                                    | Rakesh pays |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1    | Coordinator presses Reassign → Dr B. The menu shows "Dr A ₹800 → Dr B ₹1,200 · ₹400 more".                                      | —           |
| 2    | His card moves to Dr B. The Billing Counter shows "Consultant changed — ₹400 to collect".                                       | —           |
| 3    | Reception opens it: credit note on Dr A's line (₹800 into his deposit), new bill with Dr B's line, ₹800 taken from the deposit. | —           |
| 4    | Reception collects the remaining ₹400.                                                                                          | ₹400        |

The other way (Dr B ₹500): steps 1–3 the same, the new bill takes ₹500 from the deposit, and the
desk chooses for the ₹300 left — **keep it in his deposit**, or **refund it** (a refund request,
approved by a second person, paid out on the Refunds board).

Draft bill (nothing paid yet): Dr A's line is simply swapped for Dr B's and the bill reprices. No
credit note, no deposit.

## 4. Stable / unstable

- Move the composite comparison (`classifyBiomarker`, `classifyComposite`, targets) from
  `src/utils/biomarkerClassify.js` to `shared/biomarkerClassify.js`, **and** the red/amber/green
  rule (`triageTier`, `TIER_KEYS`, `readBio`, the target checks), which today lives inside the
  `TriageView.jsx` component and is imported from there by `TriageViewV3.jsx`. The browser and the
  server then import the same file, so the old OPD Triage, Triage v3 and Gini Flow can never
  disagree. Both OPD screens switch their imports in the same change and must look identical
  afterwards.
- `giniflow_visits.stability` (`stable | unstable | first | no_reports`), worked out in the same
  sweep as the category (`autoCategoriseDay`, every triage loop and when the board opens), from
  `appointments.biomarkers` against the previous visit's.
  - **Unstable** = Worse, or Mixed (R5), or stable-but-off-target (the old screen's red rule).
  - **Stable** = Better at target, or Stable at target.
  - **First** = nothing to compare against; **No reports** = no readings.
- A chip with the word, never colour alone — "Unstable · HbA1c ↑, LDL ↑" — on the Flow Manager card,
  the Triage board card, and the Vitals / MO / Doctor station headers. The reason list is what
  the old screen's Worse/Mixed chip explained.
- The existing HbA1c category is left as it is: it drives the board's columns and the MO's "close
  independently" rule, and changing it is a clinical decision.

## 5. One reassign action

Today four places write the consultant, two different columns, and only one logs it. Every
reassignment goes through a single service function, `reassignConsultant(visitId, doctorId, ctx)`:

1. Locks the visit; refuses a doctor who is inactive, not a consultant, or removed from the fee
   list, and refuses the reassignment once the consult has started — status `with_doctor` or
   later: "Dr A has already started this consult" (R4). A consultant who handed the patient back
   ("not my patient") returns them to `ready_for_doctor`, so they can be reassigned again. The menu
   greys Reassign out for cards past that point.
2. Writes `giniflow_visits.assigned_doctor_id` **and** `appointments.doctor_id` **and**
   `doctor_name`. `doctor_id` is what billing reads first (`visitLines.js:73`), so it is the
   column that makes the bill follow; `doctor_name` keeps the OPD and GHM lists in step.
3. Marks the change as manual (`appointments.doctor_set_manually_at`). The HealthRay sync
   (`healthray/db.js:742`) then leaves `doctor_name` alone for that appointment instead of writing
   Dr A back on the next poll — the same rule `category_source = 'coordinator'` already follows.
4. Writes the triage event (who, from, to, when) and a patient-history row
   (`appointment_change_log`, through `appointmentHistory.js logFieldChanges`).
5. If the bill is a draft, swaps the line (§7); if it is final, raises the Billing Counter item
   (§7). Both in the same transaction, so a reassignment never lands without its billing step.

The Triage board, Flow Manager and the restored OPD Triage tab (§8) all call it. The reception
check-in pick keeps its "only fill when empty" rule and needs no fee step.

## 6. Working out the difference

`consultFeeDifference(visitId, toDoctorId)` — read-only, also used for the preview in the menu:

- **Charged now**: the net of the visit's live consultation lines (after line and bill discounts,
  less anything already credited), across every non-cancelled bill of the visit.
- **New fee**: the new consultant's item for the same visit type, priced through `priceLine` for
  this patient (category rate, agreed rate, payment rules), so the preview matches the bill.
- No own fee for the new consultant → the clinic default; no default either → the preview says so
  and the money step needs the desk to add the line by hand.
- Result: `{ from, to, charged, newFee, difference, billState }`.

## 7. The money step at the Billing Counter

A new `billing_requests` kind **`consultant_change`** (from/to doctor, who reassigned, reason),
shown on the counter's Requests list and in the patient's bill.

The request does **not** store an amount. The difference is worked out again when the desk opens
it and again inside the confirm transaction (§6), because the bill can change in between — paid,
discounted, or reassigned a second time.

| Bill state                    | What the desk does                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No bill yet                   | Nothing to confirm — the new consultant's line is used when the bill is drafted.                                                                                                                                   |
| Draft (unpaid)                | Swapped automatically: old line removed, new line added, bill repriced, audited. No request. The swap bumps the bill version, so a desk holding the draft open unsaved is told to reload rather than overwrite it. |
| Final, same fee               | Nothing — the request is not raised.                                                                                                                                                                               |
| Final, **costs more**         | Confirm → credit note on the old line **into the deposit**, the new line on the visit's draft (or a new invoice when there is none) paid from the deposit, the rest collected as usual.                            |
| Final, **costs less**         | Confirm → the same credit-and-rebill, then the leftover: **Keep as deposit** (default) or **Refund** (cash / card / UPI / as paid) — a refund goes through the existing refund approval and Refunds board.         |
| Final, **unpaid / part-paid** | Credit note on the old line against what is due, new line on a new invoice — nothing moves through the deposit that was never paid.                                                                                |
| Final, **paid in HealthRay**  | Not moved through the Scribe deposit. The desk settles the difference in HealthRay and marks the request done in Scribe with a note (§9 Q2).                                                                       |

- **Who confirms**: reception, reception admin or admin (R2), like the existing discount after
  finalising — no second approval for moving money into the deposit, because nothing leaves the
  hospital. Paying money **out** (a refund) keeps the existing second-person approval. §9 Q1 asks
  whether the confirmer must be someone other than the person who reassigned.
- **The confirm dialog** shows patient,
  Health ID, both consultants, both fees, the difference and where the money goes — never a bare
  "Are you sure?".
- **Cancel**: the desk can dismiss it with a reason (e.g. same consultant agreed to see the patient
  at the old fee); the consultant stays changed, the bill does not.
- Everything is written to `billing_audit`; the credit note and new invoice print as usual and the
  deposit history shows "Consultant changed — Dr A → Dr B".

## 8. Bringing back the OPD Triage tab

- Un-hide "🔴🟡✅ Triage" in the OPD Manager top bar (`src/OPD.jsx:7373`).
- Its Reassign button stops writing `appointments.doctor_name` directly and calls
  `reassignConsultant` (through the patient's Gini Flow visit), with the same fee preview.
- Its Worse/Mixed/Better chip reads the shared comparison (§4), so it shows the same verdict as
  Gini Flow.
- An appointment with no Gini Flow visit yet (tomorrow's list) changes the consultant only; the
  fee is picked up when the bill is drafted.

## 9. Open questions

| #   | Question                                                   | Recommendation                                                                            |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Q3  | Should Unstable **suggest** a consultant (e.g. the chief)? | Suggest only, never auto-assign — the coordinator presses Reassign.                       |
| Q4  | A patient reassigned twice (A → B → C) before paying?      | Each change compares against what is charged at that moment, so A → C nets out correctly. |

## 10. Phases

| Phase | Builds                                                                                                                                                                  | Migration                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1     | Shared comparison, `stability` column + sweep, Stable/Unstable chip on boards and stations.                                                                             | `giniflow_visits.stability`                                            |
| 2     | `reassignConsultant`, all three columns written, HealthRay sync respects a manual change, Triage board + Flow Manager use it, fee preview in the menu, draft-bill swap. | `appointments.doctor_set_manually_at`                                  |
| 3     | `consultant_change` request, credit-into-deposit + rebill + collect/keep/refund at the counter, HealthRay-paid case.                                                    | `billing_requests` kind `consultant_change` (+ from/to doctor columns) |
| 4     | OPD Triage tab back, wired to `reassignConsultant` and the shared comparison.                                                                                           | —                                                                      |

Each phase ships with e2e tests on the test DB, including the worked example both ways, a draft
swap, a draft open unsaved at the desk, a second reassignment, a refund that needs a second
person, a HealthRay-paid consultation, a reassignment refused after the consult started, and the
HealthRay sync not undoing a reassignment.

Phase 2 changes who the bill charges as soon as it ships (the draft swap), so phases 2 and 3 go
live together; phase 1 and phase 4 can ship on their own.

## 11. Risks

- **HealthRay still names the old consultant.** HealthRay is not told about the change; its own
  appointment keeps Dr A. Scribe's bill and boards follow the reassignment. If HealthRay must
  change too, that is a manual step on HealthRay.
- **Consultant lists move with `doctor_id`.** Writing `appointments.doctor_id` puts the patient in
  Dr B's own lists (consultant station, OPD "my patients"). That is the intent, but a screen that
  still reads only `doctor_name` from HealthRay could show Dr A until §5 step 3 is in place.
- **Discounts on the old line.** A credit note gives back what was actually charged, not the list
  price, so a discount on the old consultation is not lost or doubled.
- **Removed consultant.** A doctor removed from the fee list cannot be reassigned to — the same
  rule `removedDoctor` applies at billing.
