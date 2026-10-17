# Home collection — where the sample was taken, and by whom

Status: **built 17 Oct 2026** (steps 1–5; see "As built" at the end). Not committed.

## Problem

Scribe knows which patients **opted** for home collection. It does not know whether the sample was
**actually** collected at home, at the hospital, or not yet, and it does not know who collected it.
The lab team (WhatsApp, 15 Oct) asked where the collector should mark "sample collected".

## Decisions (review, 16 Oct)

| Question                 | Decision                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home flow                | One step, on return: the collector marks it when back with the sample. No "patient at the bench" step.                                                                                                                                                                                                                                                                                         |
| Who collected            | Harwinder and Pratham get **their own lab logins**. "Who" = the logged-in user. No name picker.                                                                                                                                                                                                                                                                                                |
| Which patients are asked | **Only home-collection patients.** Every other sample behaves exactly as today.                                                                                                                                                                                                                                                                                                                |
| Where it shows           | Lab 1 header, Lab 2 and Flow Coordinator badge, Reports / monthly summary, GHM Ops page.                                                                                                                                                                                                                                                                                                       |
| Payment                  | The collector takes payment **physically at the home**. On return they tell reception, and reception records it on the Payments tab as today. If it was not taken at the home, reception contacts the patient and collects it. So a home sample **may be collected and sent before payment is cleared**; the **report is not released until it is paid** (same rule as samples-only patients). |
| No booking tick          | **Only ticked bookings.** Lab 1 never offers home collection for an unticked patient; reception/OBT must tick Home Collection on the booking first.                                                                                                                                                                                                                                            |
| No Scribe visit that day | **Book first, then mark.** The patient must be booked (samples-only / Hospital Admin) and tests ordered so they appear on Lab 1.                                                                                                                                                                                                                                                               |

## What the code does today (checked)

- Lab 1 = `/giniflow/station/lab/collection`. Steps: Payment → Collect → Send → Receive → Process →
  Upload (`shared/labStages.js`). "▶ Start collection" = `drawing_started`, then `sample_taken`.
- **Two recording paths**, both already store the actor:
  - Scribe floor orders → `POST /giniflow/stations/lab/:orderId/advance` →
    `giniflow_lab_order_events` (`actor_id`, `occurred_at`, `meta JSONB`).
  - HealthRay lab cases → `POST /giniflow/stations/lab/case/:caseNo/action` →
    `giniflow_lab_case_actions` (`actor_id`, `created_at`, `note`).
- **Two sources of "opted for home":**
  - `appointments.home_collection` (GHM booking tick).
  - `lab_test_requests.collection_type = 'home'` (Lab Requests page, with address).
- **Payment gate** (`labStation.js` rule 1, `shared/labPayment.js`): no sample may be collected until
  reception has cleared payment or an insurance claim. Samples-only (Hospital Admin) visits follow
  the rules from the samples-only work.
- A patient with several samples appears **once per case** on Lab 1.

## 0. Before any code — logins

An admin creates two staff accounts at **/staff-management**, role **lab**, for Harwinder and
Pratham. Until they exist, home collections are credited to the shared Lab 1 account (the screen
shows that name, so it is visible, not silent).

## 1. Data

| Path            | Change                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Floor orders    | No migration. The `sample_taken` event's `meta` gets `{ "site": "home", "collectedAt": "<ts>" }`.                                                                                                       |
| HealthRay cases | Migration `2026-12-xx_home_collection_site.sql`: add `collected_at_site TEXT CHECK (collected_at_site IN ('ghm','home'))` and `collected_at TIMESTAMPTZ` to `giniflow_lab_case_actions`. Both nullable. |

- Filled only on the `sample_taken` row of a home-collection patient. NULL everywhere else, so
  existing rows and screens are untouched. No backfill.
- `collected_at` / `collectedAt` = **when the sample was actually drawn at the home**. It defaults to
  now and can be set earlier, because the collector marks it on return. The row's own timestamp
  still records when it was marked, so both are kept for audit.
- Report indexes: `giniflow_lab_case_actions (created_at) WHERE action = 'sample_taken'`, and an
  expression index on `giniflow_lab_order_events ((meta->>'site'), occurred_at) WHERE
status = 'collected'`. Created `IF NOT EXISTS`, small tables, safe on prod.

## 2. Server

**Home flag.** One shared SQL helper `homeCollectionFor(visitAlias)` in
`server/services/giniflow/homeCollection.js`. It is true when the visit's appointment has
`home_collection` or the patient has an approved `lab_test_requests` row with
`collection_type = 'home'` for that date. Every screen and report uses this one helper, so they
cannot disagree.

**Actions.** Both existing endpoints accept an optional body
`{ site: "home" | "ghm", collectedAt?: ISO }`, validated by Zod in `server/schemas`:

- Home patient + `site: "home"` → write `sample_taken` directly (no `drawing_started`), with site and
  collectedAt, actor = logged-in user. The sample then continues Send → Receive → … as today.
- Home patient + `site: "ghm"` (came in after all) → today's bench flow, stamped `ghm`.
- Non-home patient → `site` rejected with 400 ("This patient did not opt for home collection").
- `collectedAt`: not in the future, not before the visit date; 400 otherwise with a clear message.
- **Payment gate, home exception.** For a home-collection patient, `site: "home"` is allowed while
  the order is unpaid; Send → Receive → Process are allowed too. **Upload / result release stays
  blocked until paid** (409 "Payment pending — reception must record the home-collection payment
  before the report is released"). Every other sample keeps today's rule: nothing until paid.
  The exception lives in one function in `shared/labPayment.js` (`opensLabGate` gains a
  `homeCollected` case for the collect/send steps only), so the rule is in one place.
- Undo of `sample_taken` (existing path) removes the site with the row.
- Every change writes the realtime event the lab screens already listen to, so Lab 1, Lab 2 and the
  Flow Coordinator update within a second.

**Queue.** The Lab 1 and Lab 2 queue responses add per card: `homeCollection`, `collectedAtSite`,
`collectedBy` (staff name) and `collectedAt`, from the existing queue query (one extra join, no
extra request). The header counts are added to the existing `counts` object:

- `homeCollected`: home samples collected today.
- `homePending`: home-collection patients with a paid lab order or case today and no sample yet.

**Report API.** `GET /giniflow/stations/lab/home-collections` with params
`from, to, site, collectorId, q, page, pageSize (≤100), sort`. Server-side filter, search
(name / UHID / phone), sort and pagination. Returns `{ rows, total, page, pageSize, summary:
{ home, ghm, pending, byCollector[] } }`. Capability: lab staff and admin
(`GINIFLOW_STATION_LAB_COLLECT` or `OPD_SUMMARY`), declared in `shared/permissions.js`. Excel
export reuses the monthly-summary exporter.

**GHM Ops.** The existing `/ghm` list query adds `home_sample_status`
(`not_collected | home | ghm`), `home_collected_by` and `home_collected_at` for bookings that
opted for home. Read-only, filterable (`home_sample=pending|collected`). No new endpoint.

## 3. Lab 1 screen

- Home-collection cards show a **🏠 Home collection** tag beside the name.
- On those cards **▶ Start collection** opens a small dialog:
  - Patient name, UHID, age/sex and the tests in this case (identity check).
  - **Collected at** time, prefilled with now and editable (earlier only).
  - **🏠 Collected at home** (primary) · **🏥 Patient came to GHM** (secondary) · Cancel.
  - If the patient has other uncollected cases today: a checked box, **"Also mark the other N
    samples for this patient"**, so one visit to the home is one tap, not one per case.
  - While saving: "Saving…", buttons disabled. Errors (unpaid, already collected) are shown in the
    dialog in plain words, never raw server text.
- On an unpaid home card, Start collection is **not** hidden: the dialog shows "Payment pending —
  collect ₹N at the home and tell reception", and "Collected at home" still works. "Patient came to
  GHM" follows today's rule (payment first).
- After saving, the card shows **🏠 Home · Harwinder · 10:42** (plus **Payment pending ₹N** while
  unpaid) and moves to "Sample collected — send to the lab", like any collected sample.
- Header: two new tiles after the existing ones — **Home collected today N** and **Home pending N**.
  Tapping "Home pending" filters the list to those patients.
- Non-home cards: no dialog, no change.
- Lab 2 and the Flow Coordinator card show the same 🏠/🏥 badge with the collector, so the person
  receiving the tube knows it came from a home visit.

## 3a. Reception — Payments tab

- Home-collected, unpaid orders show on the Payments tab with a **🏠 Collected at home · Harwinder
  10:42 · ₹N pending** tag, so reception knows to confirm with the collector whether cash was taken
  and record it, or to call the patient.
- A filter chip **"Home collection — payment pending"** lists only these.
- Recording the payment is the existing Payments flow; nothing new to learn.

## 4. Reports

- **Monthly summary (`/reports/monthly`)**: a tile "Home collections: N collected · M pending", split
  by collector.
- **Home collections table** (new section on the reports page, server-side throughout): date range,
  site (Home / GHM / Pending), collector, search; columns date · patient · UHID · tests · site ·
  collected by · collected at · current lab status; paginated; Excel export.

## 5. GHM Ops page

For bookings with Home Collection ticked, a chip in the row: **Not collected yet** ·
**🏠 Collected · Harwinder 10:42** · **🏥 Came to GHM**, plus a filter "Home sample: pending /
collected". OBT can call the patients still pending.

## 6. Responsive UI and accessibility

Follows the existing Gini Flow station styles and tokens (`giniflow-station.css`); no new UI library.

| Width             | Behaviour                                                                                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop ≥ 1024px  | Dialog centred, ~420px wide. Header tiles in one row. Report as a table.                                                                                                                                                                                                                                               |
| Tablet 640–1023px | Header tiles wrap to two rows. Report table scrolls sideways; patient and site columns stay pinned.                                                                                                                                                                                                                    |
| Phone < 640px     | Dialog becomes a bottom sheet at full width; buttons stacked, at least 44px tall. The collector can mark from a phone on return. Cards keep name, UHID, badge and the action button with no sideways scroll. The report becomes a card list (patient, site badge, collector, time). The GHM chip wraps under the name. |

- The dialog is a real `role="dialog"` with a label; focus moves into it and returns to the button.
  Esc and Cancel close it. All controls are `<button>`/`<input>` with visible labels.
- The site is shown as icon **and** text (🏠 Home / 🏥 GHM), never colour alone.
- Long names and test lists wrap; nothing is cut without a way to see it.

## 7. Testing

All in Playwright against the e2e Docker DB (`npm run test:e2e:setup` after the migration).

**New spec `e2e/giniflow/G98-home-collection.spec.js`:**

- Service / API
  1. Home patient (booking tick), paid, `site: "home"` → one `sample_taken`, no `drawing_started`,
     site `home`, actor = the logged-in lab user, collectedAt saved; then Send/Receive work.
  2. Same through a `lab_test_requests` home request (second source).
  3. Floor order and HealthRay case paths both record site and collector.
  4. `site: "ghm"` on a home patient → bench flow, stamped `ghm`.
  5. `site` on a non-home (unticked) patient → 400; the dialog is never shown for them; the normal
     flow stays unchanged (regression).
  6. Unpaid home patient → "Collected at home", Send and Receive are allowed; Upload is refused (409)
     until reception records the payment, then succeeds. Unpaid non-home patient → still refused at
     collect (regression of the payment rule).
  7. `collectedAt` in the future or before the visit date → 400.
  8. "Also mark the other samples" marks every uncollected case for that patient, in one transaction.
  9. Undo `sample_taken` clears site and collectedAt.
  10. Reception, OBT and guest roles → 403 on the action and report endpoints.
  11. Counts: `homeCollected` and `homePending` are correct before and after marking.
- Report API 12. Date range, site, collector and search filters; pagination totals; page-size cap; sort. 13. Summary numbers match the rows.
- Reception
  14a. A home-collected unpaid order shows the 🏠 tag and appears under the "Home collection — payment
  pending" filter; after the payment is recorded it leaves the filter.
- GHM 14. The booking chip goes Not collected → Collected · name · time; the filter returns the right rows.
- UI (desktop 1280px) 15. The home card shows the tag; Start collection opens the dialog with the patient identity; "Collected
  at home" moves the card and shows the badge; the header counts update without reload. 16. Lab 2 shows the same badge in realtime. 17. Keyboard: Tab order, Esc closes and returns focus.
- UI (phone 390px and tablet 768px viewports) 18. Bottom-sheet dialog, stacked 44px buttons, no horizontal page scroll on Lab 1, the report and
  the GHM page.

**Regression — must still pass unchanged:** G73, G79, G85, G86 (payment before Rx), G87, G88, G89,
G91, G92 (lab and samples-only), the reception Payments specs, G05 and G09 (GHM), and the monthly-summary specs.

**Manual check before release:** one real home patient on local, on a phone and a desktop.

## 8. Build order (small, tested steps)

1. Migration + `homeCollection.js` helper + service/API changes + tests 1–11.
2. Lab 1 dialog, badge, header counts + UI tests 15, 17, 18.
3. Lab 2 / Flow Coordinator badge, Reception Payments tag + tests 14a, 16.
4. Report API + table + monthly tile + tests 12–13, 18.
5. GHM chip and filter + test 14.
6. Full regression run, then hand over for review. No commit or push without asking.

## Open points

None. All three were answered on 16 Oct (see Decisions).

## As built (17 Oct 2026)

Where the build differs from the text above, this section wins.

- **Second home source.** `lab_test_requests` has no collection date, so an approved home request
  counts for visits on the day it was raised and the 7 days after (`HOME_REQUEST_DAYS` in
  `server/services/giniflow/homeCollection.js`).
- **Event names.** A Scribe order's collection is the `sample_collected` event (not
  `sample_taken`); its `meta` carries `{ site, collectedAt }`. A home patient collected through the
  bench is stamped `{ site: "ghm" }` automatically, on orders and on HealthRay cases, so reports
  never miss one.
- **Home step.** `site: "home"` is accepted only with `to: "sample_collected"` (orders) or
  `action: "sample_taken"` (cases); the route sends it to `collectAtHome()` in `labStation.js`, one
  transaction for the sample and, with `alsoOthers`, the patient's other uncollected samples.
- **Payment.** `opensLabGateFor()` in `shared/labPayment.js`: a home-collected order may move to
  every step except `uploaded` while unpaid. A home-collected HealthRay case may not be marked
  `report_uploaded` until reception has cleared Lab Billing.
- **Counts.** The queue returns `homeCounts: { homeCollected, homePending }` as its own object.
  Adding them to `counts` would have broken the "All" chip, which sums every value in it.
- **Report.** `GET /giniflow/stations/lab/home-collections` and `…/export.xlsx` (lab collection
  room or `OPD_SUMMARY`). The table and tiles are a "Home collections" section on the Monthly
  summary page, covering the month on screen.
- **GHM.** `home_sample=pending|collected` extends the existing home filter, offered in the
  Filters panel as "Home sample — not collected yet / collected". The chip sits under the
  patient's name.
- **Tests.** `e2e/giniflow/G98-home-collection.spec.js`, 21 tests.
- **Still to do by hand.** Section 0 (Harwinder's and Pratham's lab logins). Run the migration
  `2026-12-03_home_collection_site.sql` on production before deploying.
