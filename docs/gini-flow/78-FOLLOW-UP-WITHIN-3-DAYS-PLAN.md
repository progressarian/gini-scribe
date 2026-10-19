# 78 — Follow-up within 3 days: ₹0 consultation

Status: built (2026-10-19). See "As built" at the end.

## Ask

A third consultation type beside **New** and **Follow Up**: **Follow-up within 3 days**, ₹0 for
every consultant. It applies automatically when the patient's last consultation **with the same
consultant** was 3 days ago or less. Nobody at the counter has to choose it.

## How consultation fees work today (read from code)

- Each consultant has consultation items in `service_items` (`kind = 'consultation'`,
  `visit_type` = `New` or `Follow Up`, `doctor_id` = the consultant). A row with
  `doctor_id IS NULL` is a **default** that covers consultants without their own item; Settings →
  Consultant fees already shows default rows.
- `consultationItem` (`server/services/billing/visitLines.js:99`) picks the item from the booking's
  visit type (`billingVisitType`) and the consultant. It is the single place every path asks:
  check-in draft, Bill at arrival (`arrivalConsultationIn`), the counter's consultant change, and
  the arrival quote.
- The allowed visit types are `CONSULTATION_VISIT_TYPES = ["New", "Follow Up"]`
  (`shared/billingVocab.js`) and a CHECK on `service_items.visit_type`; billing rules check
  `New / Follow Up / Investigation`.

## Proposed change

1. **New visit type `Follow Up (3 days)`.** Added to `CONSULTATION_VISIT_TYPES` and `VISIT_TYPES`.
   A migration widens the three CHECK constraints (`service_items.visit_type`, the two rule
   tables' `visit_types`).
2. **One default item, ₹0, for every consultant.** The migration adds a single
   `service_items` row: code `CONS-FU3`, name **Follow-up within 3 days**, subgroup OPD-CONS,
   `kind = 'consultation'`, `doctor_id = NULL`, `visit_type = 'Follow Up (3 days)'`,
   `base_price = 0`, with its `billing_audit` row. Being a default, it covers every consultant,
   including ones added later. An admin can still give one consultant their own item for this type
   in Settings → Consultant fees if the hospital ever wants a different amount for them.
3. **Automatic choice in `consultationItem`.** Before the usual lookup:
   - *recent* = the patient has an appointment with `status = 'completed'` dated 1 to 3 days
     before this visit, **with the same consultant** (`appointments.doctor_id`, or the same doctor
     name, matching how `visitFor` resolves the booking doctor).
   - If recent: use the consultant's own `Follow Up (3 days)` item if they have one, otherwise the
     default ₹0 item.
   - If not recent, or no such item exists: the current behaviour, unchanged.
   - Applies whether the booking says New or Follow Up: a patient seen 2 days ago is not new.
4. **Nothing else changes.** Pricing, category rates, discount and payment rules all run as today
   on a ₹0 line. The bill shows the line "Follow-up within 3 days" at ₹0, so reception can see why.
   The counter's "consultation owed" check treats the ₹0 line as billed.

"3 days" means the visit date minus the last completed consultation's date is 1, 2 or 3 (a
patient seen on the 16th is free on the 17th, 18th and 19th; paid on the 20th). A second visit on
the same day is not covered.

## Not changed

- HealthRay billing: if HealthRay bills the consultation at a fee, the HealthRay amount still
  wins where it already does today (`healthrayBilledConsultation`).
- Visits with a different consultant within 3 days pay the normal fee.
- Existing bills: nothing is repriced retroactively; drafts pick it up the next time their
  consultation line is chosen.

## Tests (e2e, test DB only)

New `e2e/billing/phase4/P4C-53-follow-up-within-3-days.spec.js`:

1. Completed visit with the same consultant 2 days ago → consultation line is
   "Follow-up within 3 days", ₹0.
2. Exactly 3 days ago → ₹0; 4 days ago → the normal Follow Up fee.
3. Completed visit with a **different** consultant yesterday → normal fee.
4. Booking says "New" but same consultant 1 day ago → ₹0.
5. A consultant with their own `Follow Up (3 days)` item uses that item instead of the default.
6. Settings → Consultant fees lists the new type and the default row.

Re-run: P4C-41 (bill consultant), P4C-43 (check in and bill), P4C-50, P1-29 (services page),
consultant-fee specs.

## Files

- `shared/billingVocab.js`: the new visit type.
- `server/migrations/2026-11-02_follow_up_within_3_days.sql`: CHECKs + default item + audit row.
- `server/services/billing/visitLines.js`: the recent-visit check in `consultationItem`.
- Production: the migration (one item, three constraints). No backfill.

## As built (differences from the plan above)

- **Vocabulary.** `CONSULTATION_VISIT_TYPES` stays `New / Follow Up` for the consultant export,
  the bulk import and the visit's own type. `CONSULTATION_ITEM_VISIT_TYPES` adds
  `Follow Up (3 days)` for consultation items: Settings → Services, and Settings → Consultant
  fees, where every priced consultant has a "Follow Up (3 days)" row to edit, and Not priced lists
  a missing one next to New and Follow Up. `VISIT_TYPES` and the rule tables are unchanged.
- **Per-consultant items.** `server/scripts/add-follow-up-3-days-per-consultant.mjs` gives each
  consultant who already has consultation fees their own ₹0 `Follow Up (3 days)` item
  (`CONS-<id>-FU3`), so the row exists to edit. The hospital default ₹0 item still covers anyone
  without their own.
- **Migration** widens only `service_items_visit_type_check`.
- **The ₹0 item** is created by `server/scripts/add-follow-up-3-days-item.mjs` through
  `createItem` (validation, subgroup, price history and `billing_audit`), not by SQL.
- **Pricing** treats the line as `Follow Up` when matching payment and discount rules
  (`priceLine.js` `ruleVisitType`); the price still comes from the ₹0 item.
- **No HealthRay wait.** The ₹0 line is added at check-in and at the counter without waiting for a
  HealthRay-billed consultation (`draftAtCheckIn`, `consultationForDesk`).
- **Hand-added guard.** Adding the 3-day item by hand is refused unless the patient saw that
  consultant in the last 3 days (`bills.js` `refuseOtherConsultation`).
