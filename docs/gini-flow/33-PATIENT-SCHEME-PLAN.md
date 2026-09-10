# 33 — Patient schemes: CGHS / ECHS tagging, scheme pricing, daily caps

**Status 2026-09-17: steps 1, 2, 4, 5, 6 and 7 built. Step 3 is gated on D7 —
ask the desk first. Every price table ships EMPTY, so prices today are exactly
what they were before; the machinery is in place and waiting for the tariff.**

| Step                          | State               | Notes                                                                                                     |
| ----------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| 1 scheme list as data         | **built**           | `patient_schemes`, `SCHEME_ADMIN`, `/settings/schemes`. ECHS added. Both GHM smoke scripts pass untouched |
| 2 patient tag + inheritance   | **built**           | `patients.scheme_code` / `scheme_ref` (encrypted), snapshot-at-creation on all three insert paths         |
| 3 visible where money happens | **blocked (D7)**    | Reception badge and OPD fee shipped with step 6; the rest waits on why the tag has never been used        |
| 4 daily cap                   | **built**           | `SCHEME_CAP_ENFORCEMENT=off` by default. Ship in `warn`, watch a week, then `strict`                      |
| 5 scheme test pricing         | **built, unpriced** | `scheme_test_prices` + `pricing.js` + `giniflow_lab_orders.scheme_code`. Table empty                      |
| 6 OPD fee display             | **built, unpriced** | `scheme_opd_fees`, shown on the reception badge. Table empty                                              |
| 7 medicine tariff             | **built, unpriced** | `medicine_catalog` seeded with the top 200 by volume (80% of prescriptions), all `source='unpriced'`      |

To turn any of it on: enter rates in `/settings/schemes` and the price tables,
set a `daily_cap`, then set `SCHEME_CAP_ENFORCEMENT=warn`.

Plan, not built. Revised 2026-09-13 against the code as it stands; the first
version of this doc was written before the lab payment split (28) and the lab
billing step (34) landed, and several of its line references had drifted.

Extends `appointments.patient_category`
(`2026-08-21_appointment_patient_category.sql`).

## 0. What this revision changes

Six findings from re-reading the code changed the shape of the work:

1. **The tag has never been used.** 7,413 appointments in the last 60 days,
   **zero** carrying a `patient_category`. This is not "extend an existing
   tag" — it is "make a tag nobody uses carry money and capacity decisions".
   Adoption, not schema, is the risk.
2. **The tag's code surface is two files plus two smoke scripts.**
   `shared/patientCategories.js` is imported by `src/pages/GHMPage.jsx:39`,
   `server/routes/ghm-appointments.js:19`, and the two GHM smoke scripts.
   Nothing else. Turning the list into data is far cheaper than the original
   doc implied — and **nothing downstream reads the tag at all**: no pricing
   path, no capacity path, no station.
3. **Pharmacy has no money in it at all** — no price column, no tariff, and
   `16-PHARMACY-STATION-PLAN.md` never mentions one. Scheme pricing cannot
   reach the pharmacy because there is nothing there to price.
4. **The lab pricing machinery is real but unexercised**: 6 lab orders ever, 18
   order lines, 26 catalogue tests. Correct plumbing, no traffic. Scheme test
   pricing would be built on a road nobody drives yet.
5. **HealthRay bill data is never stored.** `billingExtractor.js` is read-only
   by design — bills are fetched live through `GET /flow/patient-billing`
   (`routes/flow.js:3552`) and rendered. There is no bill table anywhere in the
   migrations. This changes §4b: reconciliation needs somewhere to reconcile
   _against_, and that does not exist yet.
6. **The tag lives only on `appointments`.** Neither `giniflow_visits` nor
   `giniflow_lab_orders` carries it, so lab pricing cannot see a scheme without
   the order snapshotting it first (§4a).

## 1. What exists today

| Piece                          | Where                                                                                               | State                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The tag                        | `appointments.patient_category`, indexed `(appointment_date, patient_category)`                     | Exists. **0 of 7,413 rows tagged in 60 days**                                                                 |
| The vocabulary                 | `shared/patientCategories.js` — General / CGHS / Himachal Govt / Senior Citizen / Special Discount  | Hardcoded. **No ECHS.** Two app import sites + two smoke scripts                                              |
| Sheet UI                       | `GHMPage.jsx:453` filter pills, `:2231` per-day count badges, `:2976` the editable cell             | Works. The count badge is where a cap indicator belongs                                                       |
| Server validator               | `ghm-appointments.js:1617`                                                                          | Pure function over a constant array. PATCH allow-list at `:1606`                                              |
| Per-day counts                 | `GET /ghm-appointments/category-counts` (`ghm-appointments.js:762-766`)                             | Already grouped by category and zero-filled — the cap counter's data source                                   |
| Test prices                    | `giniflow_test_catalog` (26 rows) → copied per line to `giniflow_lab_order_tests.price`             | One price per test, no scheme dimension                                                                       |
| Pricing chokepoint             | `moStation.js:685-689` builds `priceOf`, `:717` totals it, `:719-732` writes order + lines          | **Single place an order is priced.** The hook for scheme pricing                                              |
| Money arithmetic               | `shared/labPayment.js` — `paise()`, `derivePaymentStatus`, `opensLabGate`                           | Integer-paise throughout. Scheme pricing must reuse it, not re-do rupee maths                                 |
| Test-price admin               | `/admin/test-catalog` → `TestCatalogPage.jsx`; `testCatalog.js:94-119` is the only price-write path | The screen and capability shape to copy for `/settings/schemes`                                               |
| Lab money                      | `giniflow_lab_orders.amount_total / amount_paid / amount_claimed / claim_state`                     | Modelled properly (28). 6 orders ever                                                                         |
| Pharmacy money                 | —                                                                                                   | **Does not exist.** No price anywhere in the pharmacy path                                                    |
| OPD consultation fee           | —                                                                                                   | **Does not exist.** HealthRay raises OPD bills; Gini only reads them back via `healthray/billingExtractor.js` |
| `appointments.insurance_taken` | column exists                                                                                       | **Dead** — null on all 11,318 rows. Do not build on it                                                        |
| Capacity                       | `availability.js:26` `ACTIVE_BOOKING_SQL` → `bookingGuard.js:14`                                    | Per doctor per slot, gated behind `SCHEDULE_ENFORCEMENT`, default `off`. Admin `force=true` escape at `:34`   |
| Encryption precedent           | `server/utils/aadhaarCrypt.js`, used at `routes/patients.js:9`                                      | Reuse verbatim for a card number                                                                              |
| Admin shell                    | `SettingsLayout.jsx:10` — "adding a section is two lines here and one route"                        | Reuse                                                                                                         |

Three properties that make this cheaper than it looks, each re-verified:

- **HealthRay never writes the tag.** `grep patient_category server/services/healthray/db.js` returns nothing, so a tag set in Gini survives every polling loop. `upsertAppointment` is at `db.js:710`.
- **The sheet already counts per category per day** (`GHMPage.jsx:2231`), so "CGHS 8/10 today" is a label change, not a new query.
- **Every journey template already has a `billing` step** (7th of 8, per doc 34), so a scheme has somewhere to be shown at the moment money is handled.

One naming trap, unchanged: `giniflow_visits.category` is the **triage colour**,
`appointments.category` is legacy free text, `appointments.patient_category` is
the scheme. Do not add a fourth `category`. New columns are named `scheme_*`.

## 2. The design: a tag is a dimension, not a list

The brief says more scheme options are coming. So the tag must be **data with a
stable key**, and everything priced or capped hangs off that key. Three rules:

**R1 — one vocabulary table, one code.** `patient_schemes.code` is the join key
for every future feature. Nothing else identifies a scheme.

```
patient_schemes
  code          TEXT PRIMARY KEY   -- 'cghs', 'echs', 'himachal_govt', …
  label         TEXT NOT NULL
  color         TEXT               -- reuses the existing pill colours
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
  requires_ref  BOOLEAN NOT NULL DEFAULT FALSE  -- prompt for a card number
  daily_cap     INT                -- NULL = unlimited
  sort_order    INT NOT NULL DEFAULT 0
```

Seeded with the five existing values at their existing `code`s, plus ECHS. No
data migration: `appointments.patient_category` keeps its name and meaning.

**R2 — one override table per priced domain, never a column per scheme.** A new
domain is a new table; a new scheme is a new row. Neither is a schema change to
anything that already works.

```
scheme_test_prices (scheme_code, test_name, price)     -- v1, Gini owns this
scheme_opd_fees    (scheme_code, doctor_id NULL, visit_type, fee)  -- display only
scheme_<domain>_…  (scheme_code, …)                    -- the pattern for later
```

**R3 — resolution is always "override if present, else base".** One helper in a
new `server/services/pricing.js`, called from the single chokepoint in
`moStation.js`. Schemes differ on some items, not all, so an override table stays
small and onboarding a scheme is not forty rows of re-entry.

`shared/patientCategories.js` stays as the import surface and becomes a thin
cached client over `GET /api/patient-schemes`. `categoryLabel`, `categoryColor`
and `isValidCategory` keep their signatures, so `GHMPage.jsx` and the two GHM
smoke scripts do not change. **Those scripts passing untouched is the proof step
1 was invisible** — run `smoke:ghm-categories` and `smoke:ghm-pill-filters`
before and after.

`isValidCategory` is the one real behaviour change: from a pure function over a
constant to a cache lookup. The server validator must read the table directly
rather than a possibly-cold cache.

### Where the tag lives

A CGHS or ECHS entitlement is a card the **person** holds, so the master is on
the patient and falls onto each appointment:

```
patients
  scheme_code  TEXT REFERENCES patient_schemes(code)
  scheme_ref   TEXT   -- card / beneficiary number, encrypted via aadhaarCrypt.js
```

**The inheritance rule, stated once:** an appointment's scheme is its explicit
value if set, otherwise the patient's scheme **snapshotted at appointment
creation**. Never a live join — a card that lapses in March must not silently
rewrite February's counts, and the daily cap is counted off these rows.

The per-visit override stays: a CGHS patient may choose to come private today.

## 3. Where the tag is shown

Eight surfaces, in the order a patient meets the hospital. The first four are
where it is **set**; the rest are where it must be **visible** because someone is
about to make a decision with money or capacity in it.

| #   | Surface                                                                    | Shows                       | Why here                                                                                                               |
| --- | -------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | **Patient record** (`PatientPage.jsx` identity block, beside ABHA/Aadhaar) | scheme + card no., editable | The master. Set once, holds forever. `PUT /api/patients/:id` is already `COALESCE`-shaped, so two columns are additive |
| 2   | **GHM booking form + sheet cell** (`GHMPage.jsx:2976`)                     | existing dropdown           | Already works. On booking, prefill from the patient's `scheme_code`                                                    |
| 3   | **Reception check-in** (`ARRIVAL_SELECT` in `receptionStation.js`)         | badge + set-scheme action   | Closes the walk-in gap. Writes the appointment, and the patient too when they have none                                |
| 4   | **Sync-created appointments** (`healthray/db.js:710`)                      | —                           | Apply the patient default inside `upsertAppointment` so a synced booking for a tagged patient arrives tagged           |
| 5   | **GHM day counter** (`GHMPage.jsx:2231`)                                   | `ECHS 8/10 today`           | The cap has to be visible _before_ it is hit. The count badge already exists                                           |
| 6   | **MO test ordering** (`moStation.js`)                                      | scheme price per test       | The MO is choosing tests; the price shown must be the price that will be charged                                       |
| 7   | **Reception lab payment** (`getPaymentQueue` / `clearPayment`)             | scheme + expected total     | Where lab money is actually settled                                                                                    |
| 8   | **Billing step on the journey** (7th of 8, per doc 34)                     | scheme + expected OPD fee   | The one moment the OPD fee is keyed into HealthRay                                                                     |

Rendering is the existing pill: `categoryColor()` already returns the colour and
`ColorSelect` already renders it. A scheme badge is a `<span className="badge">`,
not a new component.

## 4. Billing, domain by domain

Four domains, and they differ in how much Gini can honestly control. Saying so
explicitly is the point of this section.

### 4a. Lab / investigations — **Gini owns this fully**

`scheme_test_prices (scheme_code, test_name, price)`, resolved override-else-base
by `pricing.js`, called from the single chokepoint at `moStation.js:685-689`.
`giniflow_test_catalog.test_name` is `UNIQUE`, so a scheme dimension cannot go on
that table — a companion table is the only shape available, which is what R2
already prescribes.

The existing rule that an order line snapshots its price into
`giniflow_lab_order_tests.price` is what stops a scheme change re-pricing a
quoted order — that already works and needs nothing.

⚠️ **The order must snapshot the scheme, not look it up.** Today the tag lives
only on `appointments`; `giniflow_lab_orders` has no scheme column. Add
`giniflow_lab_orders.scheme_code`, written at order time from the appointment,
for the same reason the price is snapshotted: a scheme corrected next week must
not silently re-price last week's settled order. `pricing.js` reads that column,
never a live join back to the patient.

All arithmetic goes through `shared/labPayment.js` `paise()` — the money path is
integer paise end to end, and a scheme discount computed in floating-point rupees
would break the `amounts_within_total` CHECK for the sake of a rounding error.

⚠️ The base catalogue is 26 rows of placeholder figures and reception's warning
about it must stay up until the hospital's real tariff lands. **Scheme overrides
on fictional base prices are still fictional.**

### 4b. OPD consultation fee — **display and reconcile only**

`scheme_opd_fees (scheme_code, doctor_id NULL, visit_type, fee)`, where
`visit_type` is the `New` / `Follow Up` / `Investigation` vocabulary the sheet
already uses.

⚠️ **Gini cannot make HealthRay charge this.** HealthRay raises the bill and
exposes no write path; nothing in this repo suggests one exists. What Gini can
honestly do:

- **Display** — "ECHS · OPD ₹X · card 1234" at check-in and at the billing step,
  so the right number is keyed in by the person keying it.
- **Reconcile** — `billingExtractor.js` already classifies each bill line as
  `consultation` / `lab` / `imaging` / `procedure`. With the scheme and expected
  rate known, flag bills whose consultation line disagrees. A report, not a
  control.

⚠️ **Reconciliation needs a bill table first, and there isn't one.** Bills are
fetched live from HealthRay per request (`routes/flow.js:3552` →
`transactionsToBilling`) and never stored — no migration anywhere defines a bill,
invoice or charge table. So §4b is really two pieces of work: persist the bill
lines Gini already fetches, then compare them to the expected scheme rate. The
first is the larger half and is not scheme-specific.

(`parseBillingPdfWithAi` in the same file has no caller anywhere — it is dead
code, not a second path to build on.)

This is the one place the plan stops short of the brief, deliberately.

### 4c. Pharmacy — **in scope, but a medicine tariff comes first** (D6)

There is no price, cost or tariff anywhere in the pharmacy path, and the
pharmacy station plan never proposed one. The station dispenses and counsels; it
counts stock warnings, not rupees. A scheme discount on medicines therefore
needs a **medicine tariff first** — a separate piece of work of similar size to
the test catalogue, not a scheme feature.

What v1 _can_ do at the pharmacy is show the scheme badge, so the counter knows
which rate card the patient is on when HealthRay raises the medicines bill.

### 4d. Procedures / imaging — **out of scope for v1**

Classified by the bill extractor, but has no catalogue in Gini at all. Named
here so it is not mistaken for an oversight.

## 5. The daily cap

**Dimension: per scheme, per calendar day, hospital-wide.** Not per doctor, not
per slot — a CGHS ceiling is a reimbursement-volume agreement, not a scheduling
matter for one consultant. A per-doctor override can be added later as a
nullable column; it should not shape v1.

Counted with the existing `ACTIVE_BOOKING_SQL` from `availability.js` so the
number agrees with every other screen:

```sql
SELECT COUNT(*) FROM appointments
 WHERE appointment_date = $1 AND patient_category = $2
   AND status NOT IN ('cancelled','no_show')
```

Enforced in `bookingGuard.js` as a new refusal reason alongside `full`. Three
things it must get right:

1. **Sync-created appointments count but cannot be blocked.** HealthRay is
   authoritative; rejecting its rows would only desync the two systems. They
   increment the count and never fail. The cap binds the two guarded booking
   paths and advises everywhere else.
2. **It must not inherit a disabled guard.** `SCHEDULE_ENFORCEMENT` is `off` in
   production. The cap gets its own `SCHEME_CAP_ENFORCEMENT` with the same
   `off` / `warn` / `strict` shape, and ships in `warn`.
3. **Count inside the booking transaction.** Two bookings racing at 9/10 both
   pass an unlocked count.

## 6. Who can change what

Three different powers; collapsing them is the mistake to avoid — a receptionist
who can raise the ECHS cap from 10 to 30 has defeated the cap.

| Power                                             | Who                                | How                                                                                                           |
| ------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Tag a patient / an appointment                    | reception, coordinator, OBT, admin | Existing `RECEPTION_OPS` / `OBT_OPS`. No new capability                                                       |
| Add or retire a scheme, set `daily_cap`, set fees | **admin only**                     | New `SCHEME_ADMIN`, granted to `ROLES.ADMIN` alone. Route `/settings/schemes`, following `GINIFLOW_SLA_ADMIN` |
| Override the cap for one booking                  | admin                              | Reuse `bookingGuard.js`'s existing `force=true` pattern verbatim                                              |

One new capability, not three. **Every override writes an audit row** — who,
when, which scheme, which date, what the count was. Without it the cap is
theatre: it will be forced, and nobody will be able to say how often or by whom.

## 7. Order of work (superseded by §9)

Six steps, each shippable and testable alone.

1. **Scheme list becomes data.** `patient_schemes` + `SCHEME_ADMIN` +
   `/settings/schemes`. Seed the existing five, add ECHS. Gate: both GHM smoke
   scripts pass unchanged.
2. **Patient tag + inheritance.** `patients.scheme_code` / `scheme_ref`, the four
   entry points, snapshot-at-creation. Gate: a walk-in tagged at the desk, and
   their next HealthRay-synced booking arrives tagged.
3. **Make the tag visible where money happens.** Surfaces 5–8. No behaviour
   change, no pricing yet — this is what drives adoption, and adoption is the
   real risk given 0/7,413.
4. **Daily cap.** `daily_cap`, the guard, the GHM counter, the override audit.
   Ship in `warn`, watch a week, then `strict`.
5. **Scheme test pricing.** `scheme_test_prices`, `pricing.js`, wired into
   `moStation.js`. Gate: a tagged patient's order prices at the override and an
   untagged one is unchanged to the rupee. **Blocked on a real tariff.**
6. **OPD fee display.** `scheme_opd_fees` shown at check-in and at the billing
   step, so the right number is keyed into HealthRay.
7. **Bill reconciliation.** Persist the bill lines Gini already fetches, then
   compare against the expected scheme rate. Split from step 6 because the
   storage half is the larger one and is not scheme-specific.

Steps 1–4 answer the capacity requirement and cost nothing in accuracy. Steps
5–7 answer billing, with the limits in §4b and §4c understood.

Step 3 is new in this revision and deliberately precedes the cap: a tag that
nobody sets cannot cap anything, and today nobody sets it.

## 8. Decisions

Answered 2026-09-13. Each states the verdict and what it settles in the sections
above.

### D1 — cap dimension. **Per scheme, per calendar day, hospital-wide.**

One `daily_cap` integer on the scheme row. Not per doctor: a reimbursement
ceiling is an agreement with the scheme, not a scheduling matter for one
consultant. §5 stands as written. A per-doctor cap, if it is ever wanted, is a
nullable `doctor_id` on a companion table — it must not shape v1.

### D2 — the tariff exists. **Steps 5–7 are buildable.**

The hospital has CGHS/ECHS rates and will supply them. This unblocks the whole
pricing half, and makes the admin screen in step 1 load-bearing rather than
decorative: it is where the rates get keyed in.

Two consequences worth stating:

- The 26 placeholder rows in `giniflow_test_catalog` are still placeholders
  until the **base** tariff lands too. Scheme overrides sit on top of base
  prices; a correct CGHS rate over a fictional general rate is still half
  fictional, and reception's placeholder warning stays up until both are real.
- Entering rates is data entry at hospital scale, not a migration. The screen
  must support it: search, bulk paste, and "which of these still have no rate".

### D3 — OPD fee. **Display only, at check-in and at the billing step.**

Gini shows `ECHS · OPD ₹X · card 1234` so the right number is keyed into
HealthRay by the person keying it. **Reconciliation is not in scope**, which
removes step 7 and the bill-storage work behind it. §4b's warning about there
being no bill table stops being a blocker and becomes a note: nothing is stored,
and nothing needs to be.

If reconciliation is wanted later it returns as its own plan, because persisting
HealthRay's bill lines is the larger half and is not scheme-specific.

### D4 — at the cap. **Refuse, and suggest the next day with room.**

`bookingGuard.js` gains a `scheme_cap_full` refusal carrying the next dates under
the cap, reusing the `findAvailableDoctors` shape in `availability.js:228` — same
resolver idea, different axis (dates rather than doctors). The admin
`force=true` override at `bookingGuard.js:34` still applies and still writes an
audit row.

The desk is never left at a dead end, which is the difference between a cap that
gets respected and a cap that gets forced.

### D5 — card expiry. **No expiry date. `scheme_ref` is the number, and nothing more.**

Encrypted with `aadhaarCrypt.js` exactly as Aadhaar is. Gini never claims a card
is valid — the desk checks the card, as they do today. This drops
`scheme_valid_to` from §2 entirely.

The reasoning is that a wrong expiry is worse than no expiry: auto-dropping a
renewed card to General bills a entitled patient privately, and a warning nobody
can act on is noise.

### D6 — pharmacy. **In scope. A medicine tariff is a prerequisite.**

This is the largest single decision here, and §4c is rewritten by it. The work
does not exist today in any form:

|                                                   |                                                      |
| ------------------------------------------------- | ---------------------------------------------------- |
| Distinct canonical medicines ever prescribed      | **9,964**                                            |
| Distinct medicines prescribed in the last 60 days | **2,129**                                            |
| `medicine_db.json` price data                     | **none** — keys are `raw, brand, form, dose, search` |
| `medicine_collections` rows                       | 263, and no price column                             |

A flat 9,964-row tariff is not the way in. Prescribing is heavily concentrated,
so the tariff should be built by volume:

| Tariff size | Covers                 |
| ----------- | ---------------------- |
| 50 items    | 56.5% of prescriptions |
| 100 items   | 69.3%                  |
| 200 items   | **80.0%**              |
| 500 items   | 89.9%                  |
| 1,000 items | 94.8%                  |

**200 items covers four prescriptions in five.** So: price the top 200 by volume
first, show "no rate yet" honestly for the rest, and let the list grow as the
pharmacy meets them. The same `source` marker the test catalogue uses
(`prototype_placeholder` / `priced_by_admin`) tells everyone which is which.

Shape follows the test catalogue exactly — `medicine_catalog (name, price,
is_active, source)` keyed on the canonical `pharmacy_match`, plus
`scheme_medicine_prices (scheme_code, medicine_name, price)` per R2. Dispensing
then writes a priced line, which `medicine_collections` does not do today.

This is a phase of its own, sequenced after the lab pricing that proves the
pattern.

### D7 — why the tag has never been used. **Unknown; ask the desk before step 3.**

0 of 7,413 is unexplained. Step 3 assumes the answer is "nobody sees it" and
fixes visibility; if the real answer is "it was never anyone's job", the fix is a
required field at check-in and a word with the desk, not more screens.

**Do not build step 3 until someone has asked.** It is one conversation, and it
decides whether step 3 is the right work at all.

## 9. Revised order of work

1. **Scheme list becomes data** — `patient_schemes`, `SCHEME_ADMIN`,
   `/settings/schemes`, seed the five + ECHS. Gate: both GHM smoke scripts pass
   untouched.
2. **Patient tag + inheritance** — `patients.scheme_code` / `scheme_ref`, four
   entry points, snapshot-at-creation. Gate: a walk-in tagged at the desk, and
   their next synced booking arrives tagged.
3. **Ask the desk (D7), then make the tag visible where money happens** —
   surfaces 5–8. Blocked on one conversation, not on code.
4. **Daily cap** — `daily_cap`, the guard with next-day suggestions (D4), the GHM
   counter, the override audit. Ship in `warn`, watch a week, then `strict`.
5. **Base test tariff, then scheme test pricing** — real prices into
   `giniflow_test_catalog`, then `scheme_test_prices` + `pricing.js` +
   `giniflow_lab_orders.scheme_code`. Gate: a tagged patient's order prices at
   the override, an untagged one is unchanged to the rupee.
6. **OPD fee display** — `scheme_opd_fees`, shown at check-in and at the billing
   step. No reconciliation (D3).
7. **Medicine tariff, then scheme pharmacy pricing** (D6) — `medicine_catalog`
   seeded with the top 200 by volume, priced dispensing lines, then
   `scheme_medicine_prices`. The largest phase; sequenced last because the lab
   work proves the pattern first.
