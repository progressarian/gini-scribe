# Follow-up windows — dynamic "Follow Up within N days" fees

Status: **built 2026-11-10, not deployed.** Step-1 migration and backfill not yet applied to
production. See "As built" at the end for where the build differs from this plan.

## Problem

The only reduced follow-up fee is hardcoded: `RECENT_FOLLOW_UP = "Follow Up (3 days)"` and
`FOLLOW_UP_WITHIN_DAYS = 3` in `shared/billingVocab.js`, plus a DB `CHECK` on
`service_items.visit_type`. Dr Bhansali needs a second tier — **₹1,000 if seen within 7 days**,
online and physical alike — and today every new window is a code change, migration and deploy.

## Decisions (agreed 2026-11-10)

1. The window lives **on the consultation item**: a `Follow Up` consultation item may carry
   `follow_up_within_days` (1–90). Admins add windows per doctor or as hospital default.
2. **Smallest window wins.** At an equal window the doctor's own item beats the hospital default.
   (Seen 2 days ago, default 3-day ₹0 + Dr Bhansali 7-day ₹1,000 → ₹0.)
3. **Same consultant only** — counted from this consultant's visits, as the 3-day fee is today.
4. **Count from the last full-fee visit** (no chaining) — see "Anchor visit".
5. **Closed days extend the deadline** — Sundays and `clinic_holidays` dates.
6. **Every window fee is added at check-in**, priced or not, without waiting for HealthRay's
   consultation bill (same as the 3-day fee today).
7. Max window **90 days**. Online vs physical is not a pricing dimension; one item covers both.

## Rules

### Anchor visit

The window counts from the **anchor**: this consultant's most recent completed appointment with
the patient, before the visit date, that was **not itself billed at a window fee**.

A past appointment is a non-anchor only when Scribe holds a live window consultation line for it:

```sql
EXISTS (SELECT 1 FROM bills b
          JOIN bill_lines l ON l.bill_id = b.id AND l.is_live
          JOIN service_items i ON i.id = l.service_item_id
         WHERE b.appointment_id = a.id AND b.status <> 'cancelled'
           AND i.follow_up_within_days IS NOT NULL)
```

Visits with no Scribe bill (HealthRay-only history) count as full-fee anchors. Example: full fee
day 0, 7-day fee day 5 → day 10 is 10 days from the anchor → normal Follow Up fee.

"Completed" and "same consultant" match today's `seenRecentlyBy`: `status = 'completed'` and
`doctor_id = $doctor` or the doctor-name fallback. Known limit (existing): an appointment frozen
at `in_visit` (see memory *completed-frozen-at-in-visit*) is not an anchor.

### Closed days extend the deadline

Last allowed day = `anchor + N`. If that day is closed — a weekday in `CLOSED_WEEKDAYS` (Sunday,
`shared/followUp.js`) or a `clinic_holidays` date — it moves to the next open day, repeating across
consecutive closed days. Closed days inside the window change nothing.

- 3 days: anchor Thu 5 Nov → Sun 8 Nov → Mon 9 Nov still gets the 3-day fee.
- 7 / 14 / 21 / 28 days fall on the anchor's weekday, so they move only for a Sunday anchor or a
  holiday deadline.
- Holidays only help if reception keeps `clinic_holidays` filled in.

New pure helper in `shared/followUp.js`, next to `skipSunday` and reusing `isClosedDay`:
`windowDeadline(anchorISO, days, holidaySet) → ISO date`.

### Choosing the fee

Load the anchor date once, load holidays for `[anchor, anchor + 120]` once, then take the first
active window item for this doctor or the hospital default, ordered
`follow_up_within_days ASC, doctor_id IS NULL, id`, whose deadline is `>= visitDate`. No window
fits → the plain item for the visit type, exactly as today.

"Window item" = `kind = 'consultation' AND follow_up_within_days IS NOT NULL`.
"Plain item" = the same with `IS NULL`. **Every lookup that today means "the doctor's Follow Up
fee" must add `follow_up_within_days IS NULL`**, otherwise it can pick a window by accident.

## Data model and migration

Two steps so production never bills a 3-day patient at the full fee mid-deploy (old code finds the
3-day fee by `visit_type = 'Follow Up (3 days)'`).

**Step 1 — migration `server/migrations/2026-11-10_follow_up_windows.sql`** (DDL only, safe with
the old code because it ignores the new column; it also rebuilds the
`service_items_consultation_key` unique index so plain items stay unique per (doctor, visit type)
and window items per (doctor, days)):

```sql
ALTER TABLE service_items ADD COLUMN IF NOT EXISTS follow_up_within_days SMALLINT
  CHECK (follow_up_within_days BETWEEN 1 AND 90);
ALTER TABLE service_items ADD CONSTRAINT service_items_follow_up_window_check
  CHECK (follow_up_within_days IS NULL
         OR (kind = 'consultation' AND visit_type IN ('Follow Up', 'Follow Up (3 days)')));
```

**Step 1b — script `server/scripts/backfill-follow-up-windows.mjs`**: sets
`follow_up_within_days = 3` on `visit_type = 'Follow Up (3 days)'` items, with dry run (rolled
back, prints count), skip-if-done, `writeAuditMany` rows. A few dozen rows → one batch. (A plain
SQL migration cannot write `billing_audit` through `writeAuditMany`, hence a script.)

**Deploy the new code.** It recognises windows by the column, never by the visit-type string, so
it works on both old (`Follow Up (3 days)` + 3) and new (`Follow Up` + N) rows.
`CONSULTATION_ITEM_VISIT_TYPES` keeps `Follow Up (3 days)` only so existing rows stay editable;
new windows are always created as `Follow Up` + days.

**Step 2 — after a day of normal billing**, script `server/scripts/finish-follow-up-windows.mjs`
(dry run, audit) renames `Follow Up (3 days)` → `Follow Up`; then migration
`2026-11-YY_follow_up_windows_tighten.sql` tightens both CHECKs back to `('New', 'Follow Up')`,
and a code cleanup removes `RECENT_FOLLOW_UP`, `FOLLOW_UP_WITHIN_DAYS`, `ruleVisitType` and the
two `add-follow-up-3-days-*.mjs` one-off scripts.

## Server changes (every touch point)

| Where | Today | Change |
|---|---|---|
| `shared/billingVocab.js` | 3-day constants | Add `FOLLOW_UP_WINDOW_MAX_DAYS = 90`; constants removed in step 2. |
| `shared/followUp.js` | `skipSunday` | Add `windowDeadline`. |
| `serviceItems.js` cleaners / `checkShape` | visit type only | New `follow_up_within_days` field: whole number 1–90; only on consultation + `Follow Up`; clearing it or changing visit type away from Follow Up handled with a field error, never the raw CHECK error. Included in `EDITABLE` and item audit. |
| `serviceItems.js checkConsultationFree` | unique per `(doctor, visit_type)` | Plain: unique per `(doctor, visit_type)` among plain items. Window: unique per `(doctor, days)` among window items regardless of visit-type string. Message: "Dr Bhansali already has a 7-day follow-up fee: …". |
| `serviceItems.js seenRecentlyBy` | `EXISTS` within 3 days | Replaced by `followUpAnchor(patientId, visitDate, doctorId, db)` → anchor date or null. |
| `serviceItems.js searchDeskItems` | `shown` = visit type matches | Window items `shown` only when they apply to this visit (same chooser); otherwise listed but greyed like other wrong-type consultations. |
| `visitLines.js consultationItem` | 3-day lookup then plain | Window chooser above, then plain lookup with `IS NULL`. Callers: `draftAtCheckIn`, `arrivalConsultationIn`, `consultationForDesk`, `consultationSuggestion`, `arrivalQuote.js`. |
| `visitLines.js draftAtCheckIn` / `consultationForDesk` | `=== RECENT_FOLLOW_UP` skips the HealthRay wait | "is a window item" skips it (decision 6). |
| `visitLines.js doctorConsultations` | other doctors' items of the visit type | Add `IS NULL` — the counter suggestion list must not offer other doctors' window fees. |
| `bills.js refuseOtherConsultation` | 3-day check | Window item → refused unless it is a window the chooser allows for this visit and consultant; message names the window. |
| `bills.js consultationItemFor` (`setConsultant`) | first item of visit type | Re-run the chooser for the **new** consultant (a window applies only if the patient's anchor is with them), else plain with `IS NULL`. |
| `consultantChange.js consultItemFor` + `visitTypeOf` | first item of visit type; may fall back to an old line's `Follow Up (3 days)` | Same as `setConsultant`: chooser for the new consultant, plain with `IS NULL`; `visitTypeOf` maps a window line's type to `Follow Up`. |
| `priceLine.js ruleVisitType` | maps 3-day → Follow Up | Maps any window visit type → Follow Up until step 2, then removed. Payment/discount rules see windows as `Follow Up`. |
| `consultantFees.js` grid | rows keyed by `(doctor, visit_type)`; `defaults` Map keyed by visit type | Rows keyed by item id; per doctor: New, Follow Up, then window rows by days. Defaults keyed by `visit_type + days`. Rows carry `follow_up_within_days`. |
| `consultantFees.js` missing / not-priced (`pricedDoctors`, `consultantFeeNotPriced`) | doctor × every visit type | Doctor × New/Follow Up only, joined to **plain** items. Windows are optional and never flagged. |
| `consultantFees.js` rule preview (line ~69) | item visit type vs rule | Uses `ruleVisitType(item)` so the grid shows the same rules pricing applies. |
| `consultantFees.js copyConsultantFees` | per item id | No change needed — already copies every active consultation item. |
| `importValidate.js` | consultation index / clash keyed `doctor|visit_type` | Item shape gains `followUpDays` from the DB; index and "already an active … item" clash use plain items only. Window items keep round-tripping by code; days are not editable through Excel (unchanged column set). |
| `importColumns.js` / `importReadme.js` / `consultantListExport.js` | New / Follow Up | No change; README gets one line: "Follow-up window fees are managed on Consultant Fees". |
| `routes/billing*.js`, `schemas/index.js` | — | Pass `follow_up_within_days` through the existing item create/update endpoints. No new endpoint, no new capability. |

## UI

### Settings → Consultant Fees (`ConsultantFeesPage.jsx`)

```text
Dr Bhansali
  New                         ₹1,500   …category cells…
  Follow Up                   ₹1,200
  Follow Up · within 3 days       ₹0   (hospital default, greyed)
  Follow Up · within 7 days   ₹1,000
  [+ Add follow-up window]
```

- Window rows sit under the doctor's Follow Up row; text label `Follow Up · within N days`.
- Row keys / `createRefs` move from `${doctor_id}-${visit_type}` to item id (window rows would
  collide otherwise).
- `+ Add follow-up window` (secondary button per doctor and for Hospital default) opens
  `ConsultantFeeCreateItem` with an extra required field **Within how many days of the last visit**
  (1–90; helper: "Counted from this consultant's last full-fee visit. If the last day is a Sunday or
  clinic holiday, the next open day still counts."). Suggested name
  `Follow-up within 7 days — Dr Bhansali`, code `CONS-<doctorId>-FU7`.
- Field errors from the server shown inline; button shows "Saving…".
- Deactivate/reactivate uses the existing row actions.
- `ConsultantFeeEditor` dialog title shows the window (`Dr Bhansali (Follow Up · within 7 days)`).
- Intro text drops the hardcoded "Follow-up within 3 days".

### Settings → Services (`ItemDialog.jsx`, `ServicesSettingsPage.jsx`)

- Consultation items with visit type Follow Up show the same optional **Within how many days**
  field, so window items can be edited there too and changing visit type can't hit a raw DB error.
- List label: `Dr Bhansali · Follow Up · within 7 days`.

### Counter

- Bill line shows the item name, which carries the window, so staff see why ₹1,000 was charged.
- Suggestion list (`ConsultationSuggestion.jsx`) no longer offers other doctors' window fees.

No new page, route or capability: `/settings/consultant-fees` stays on `CAP.BILLING_MASTER`.

## Risks

- **Auto-add before HealthRay (decision 6).** A ₹1,000 window lands on the Scribe bill at
  check-in. If HealthRay bills the visit at a different amount, the bills disagree (see memory
  *scribe-bill-over-healthray-correction*). **HealthRay must be set to charge the same window
  fee.**
- Anchor depends on `appointments.status = 'completed'` and on Scribe bills for the no-chaining
  rule; visits billed only in HealthRay always count as full-fee anchors.
- `clinic_holidays` must be maintained for holiday extension to work.

## Tests (e2e, local test DB only)

Update `P4C-53-follow-up-within-3-days.spec.js` to create its item with
`follow_up_within_days = 3`; every existing assertion must still pass.

New `P4C-5x-follow-up-windows.spec.js`:

1. 3-day ₹0 + 7-day ₹1,000 for one doctor: anchor 2 days ago → 3-day; 5 → 7-day; 7 → 7-day;
   8 → plain Follow Up; never seen → booked visit type.
2. Default 3-day + doctor 7-day: 2 days → default 3-day; 5 days → doctor 7-day.
3. Equal window doctor + default → doctor's own.
4. Deactivated window ignored.
5. No chaining: full fee day 0, window bill day 5, visit day 10 → plain Follow Up. Cancelled
   window bill on day 5 → day 5 is an anchor again.
6. Other consultant's visit is not an anchor.
7. Closed days: Thu anchor, 3-day, Mon visit → 3-day; Tue → plain; holiday deadline → next open
   day; holiday Sat + Sun → Mon; closed day mid-window doesn't extend.
8. `windowDeadline` unit cases (Sunday, holiday, consecutive closed days, open day, 90 days).
9. Check-in: priced window line added without a HealthRay bill.
10. Manual add outside the window → 409 naming the window.
11. `setConsultant` to a doctor the patient never saw → that doctor's plain Follow Up, not a window.
12. Validation: second 7-day for same doctor → 409; days 0 / 91 / 2.5 → 400; window on New /
    test item → 400; Follow Up window changed to New → field error.
13. Grid: window rows in day order; not-priced list ignores windows; suggestion list excludes
    other doctors' windows.
14. Import: a sheet with the doctor's plain Follow Up fee doesn't clash with their window item.
15. Step 1 + backfill on a `Follow Up (3 days)` item → days 3, chooser picks it; step 2 rename →
    same choice and price.

## Rollout

1. Review this plan.
2. Build + e2e on the local test DB.
3. Production, each step asked for separately: step 1 migration → backfill dry run (counts) →
   apply → deploy (you) → admin adds Dr Bhansali's 7-day ₹1,000 → set HealthRay's fee to match.
4. Next day: step 2 dry run → apply → tighten migration → cleanup deploy.

## As built (2026-11-10)

- **Legacy visit type.** The server accepts `Follow Up (3 days)` on create/update and saves it as
  `Follow Up` with a 3-day window; `CONSULTATION_ITEM_VISIT_TYPES` is now only New / Follow Up.
  The fee dialogs open old rows as Follow Up + 3 days. Step 2 is therefore just a data rename plus
  removing the legacy constant — no behaviour depends on the string after the backfill.
- **Backfill must run before the deploy.** New code finds windows only by
  `follow_up_within_days`; an un-backfilled `Follow Up (3 days)` row is ignored.
- **Unique index rebuilt** in the step-1 migration (same name, so the old code's error mapping
  still works).
- **Manual add** (`refuseOtherConsultation`) accepts any window whose own deadline covers the visit
  (`windowCovers`), not only the smallest one — staff may choose a longer window deliberately.
- **Anchor** ignores window lines on cancelled bills and on removed (not live) lines.
- **Desk search** hides window items that don't apply to the visit instead of greying them.
- **Tests:** `P4C-53` updated (weekday-safe gaps), new `P4C-59-follow-up-windows.spec.js`
  (16 cases). Import (`importValidate`) and the backfill script are not covered by e2e — the
  script reads the `.env` database, which is production.
