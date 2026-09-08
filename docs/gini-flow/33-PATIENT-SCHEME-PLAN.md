# 33 — Patient schemes: CGHS / ECHS tagging, scheme fees, daily caps

Plan, not built. Extends `appointments.patient_category`
(`2026-08-21_appointment_patient_category.sql`), which today is a tally on the
GHM sheet and nothing else.

## Why

CGHS and ECHS patients are billed at a different rate from a private patient,
and the hospital agrees a ceiling on how many of them it will see in a day.
Neither fact is anywhere in the system. The desk works both out of somebody's
head, which means the wrong OPD fee gets keyed into HealthRay and the ceiling is
discovered only after it has been breached.

There is already a tag — `appointments.patient_category`, with CGHS in it. It is
a **tally, not a rule**: an editable dropdown on the GHM sheet, filter pills, and
a per-day count in `ghm-appointments.js:705`. Nothing reads it for money or for
capacity, and ECHS is not in the list.

The list is also hardcoded in `shared/patientCategories.js`, so adding ECHS today
is a code change and a deploy. The brief says more schemes are coming. That is
the first thing that has to change — everything else is built on top of it.

## What exists

| Piece                      | Where                                                                                              | State                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The tag                    | `appointments.patient_category`, indexed on `(appointment_date, patient_category)`                 | Exists. Per-appointment, GHM-sheet only                                                                       |
| The vocabulary             | `shared/patientCategories.js` — General / CGHS / Himachal Govt / Senior Citizen / Special Discount | Hardcoded JS. No ECHS, no fee, no cap                                                                         |
| Test prices                | `giniflow_test_catalog (test_name, price)`; copied per line to `giniflow_lab_order_tests.price`    | One price per test. Every row still `prototype_placeholder`                                                   |
| The one pricing chokepoint | `moStation.js:685–730` — builds `priceOf`, sums `amount_total`                                     | Single place an order is priced. Good                                                                         |
| OPD consultation fee       | —                                                                                                  | **Does not exist.** HealthRay raises OPD bills; Gini only reads them back via `healthray/billingExtractor.js` |
| Capacity                   | `appointment_slots.total_capacity` → `availability.js:isSlotAvailable` → `bookingGuard.js`         | Per doctor per 30-min slot. Gated behind `SCHEDULE_ENFORCEMENT`, which defaults to `off`                      |
| Admin-screen precedent     | `/admin/test-catalog`, `/settings/*` — both `CAP.ADMIN` in `src/config/routes.js:104–111`          | Reuse this shape                                                                                              |

Two things that make the work cheaper than it looks: the HealthRay appointment
upsert (`healthray/db.js:801`) never writes `patient_category`, so a tag set in
Gini survives the polling loops; and `ARRIVAL_SELECT` in `receptionStation.js:537`
already `LEFT JOIN`s `appointments` without reading a column from it, so the
reception desk can show a scheme badge for the cost of one column in a select.

One naming trap: `giniflow_visits.category` is the **triage colour** (red/green),
`appointments.category` is legacy free text, `appointments.patient_category` is
the scheme. Do not add a fourth `category`. New columns are named `scheme_*`.

## 1. The scheme list becomes data

```
patient_schemes
  code            TEXT PRIMARY KEY      -- 'cghs', 'echs', 'himachal_govt', ...
  label           TEXT NOT NULL         -- 'ECHS'
  color           TEXT                  -- reuses the existing pill colours
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
  requires_ref    BOOLEAN NOT NULL DEFAULT FALSE   -- prompt for a card number
  daily_cap       INT                   -- NULL = unlimited
  sort_order      INT NOT NULL DEFAULT 0
```

Seeded with the five values already in `shared/patientCategories.js`, at their
existing `code`s, plus ECHS. `appointments.patient_category` keeps its name and
its meaning — no data migration, no rewrite of the GHM sheet.

`shared/patientCategories.js` stays as the import surface and becomes a thin
cached client over `GET /api/patient-schemes`. `categoryLabel`, `categoryColor`
and `isValidCategory` keep their signatures, so `GHMPage.jsx`,
`smoke-ghm-categories.mjs` and `smoke-ghm-pill-filters.mjs` do not change.
**Those two smoke scripts passing untouched is the proof this step was
invisible** — run them before and after.

`isValidCategory` is the one behaviour change worth naming: it goes from a pure
function over a constant array to a lookup against a cache, and the server
validator at `ghm-appointments.js:1550` must read the table directly rather than
a possibly-cold cache.

## 2. Getting the tag onto patients

Today `patient_category` is settable in exactly one place: `PATCH
/ghm-appointments/:id` from the sheet. That covers the OBT day list and nothing
else — a walk-in or a HealthRay-booked patient is never tagged, and a patient who
IS tagged has to be re-tagged by hand at every visit.

A CGHS or ECHS entitlement is a card the **person** holds. So the master tag
moves onto the patient and falls onto each appointment:

```
patients
  scheme_code   TEXT REFERENCES patient_schemes(code)
  scheme_ref    TEXT      -- card / beneficiary number, encrypted like aadhaar
```

Four entry points, in the order a patient meets the hospital:

1. **Patient record** — the master. Identity block on `PatientPage.jsx`, written
   through `PUT /api/patients/:id`, which is already `COALESCE`-shaped
   (`patients.js:605`), so two more columns are additive. Set once, holds
   forever.
2. **GHM booking form and sheet cell** — already exists, keeps working. On
   booking, prefill the appointment's `patient_category` from the patient's
   `scheme_code`.
3. **Reception check-in** — the catch-all, and the one that closes the walk-in
   gap. Show the scheme as a badge on the arrivals card (one column added to
   `ARRIVAL_SELECT`), with a set-scheme action that writes the appointment and,
   when the patient has none, the patient too.
4. **Sync-created appointments** — HealthRay and Sheets insert appointments
   without ever passing a booking route. Apply the patient default inside
   `upsertAppointment` in `healthray/db.js`, so a synced booking for a tagged
   patient arrives already tagged.

**The inheritance rule, stated once:** the appointment's value is the explicit
one if set, otherwise the patient's scheme **snapshotted at appointment
creation**. Never a live join. A card that lapses in March must not silently
rewrite February's counts, and the daily cap is counted off these rows.

The per-visit override stays, because it is a real case: a CGHS patient who
chooses to come private today.

## 3. Who can change what

Three different powers, and collapsing them into one capability is the mistake to
avoid — a receptionist who can raise the ECHS cap from 10 to 30 has defeated the
cap.

| Power                                                     | Who                                | How                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Tag a patient / an appointment                            | reception, coordinator, OBT, admin | Existing `RECEPTION_OPS` / `OBT_OPS`. OBT already patches `patient_category` today; no new capability                                   |
| Add or retire a scheme, set its `daily_cap`, set its fees | **admin only**                     | New `SCHEME_ADMIN` capability, granted to `ROLES.ADMIN` alone. Route `/settings/schemes`, following `/admin/test-catalog`               |
| Override the cap for one booking                          | admin                              | Reuse the existing pattern in `bookingGuard.js:34` verbatim — `force=true` honoured only when `hasCapability(role, CAPABILITIES.ADMIN)` |

One new capability, not three. Caps and fees are commercial decisions and belong
with whoever already manages the test catalogue and the doctor roster.

**Every override writes an audit row** — who, when, which scheme, which date,
what the count was. Without it the cap is theatre: it will be forced, and nobody
will be able to say how often or by whom.

## 4. Which fee, and how it resolves

There are three fees on an OPD bill and they behave differently. Say so
explicitly, because "the fee" hides the one we cannot control.

**a. OPD consultation fee** — varies by scheme × doctor tier × visit type
(`New` / `Follow Up` / `Investigation`, the values `GHMPage.jsx:801` and `:2957`
already use).

```
scheme_opd_fees (scheme_code, doctor_id NULL, visit_type, fee)
```

⚠️ **Gini cannot make HealthRay charge this.** HealthRay raises the bill and
exposes no write path. What Gini can honestly do:

- **Display** — reception sees "ECHS · OPD ₹X · card 1234" at check-in, so the
  right number is keyed into HealthRay by the person keying it.
- **Reconcile** — `billingExtractor.js` already classifies every bill line as
  `consultation` / `lab` / `imaging` / `procedure`. Once the patient's scheme and
  the expected rate are known, flag bills whose consultation line disagrees. A
  report, not a control.

Anything beyond that needs a HealthRay write API that does not exist. This is the
one place the plan stops short of the brief, deliberately.

**b. Test / investigation fee** — varies by scheme × test. This one Gini fully
owns.

```
scheme_test_prices (scheme_code, test_name, price)
```

Resolution is **override if present, else the base catalogue price** — one helper
in a new `server/services/pricing.js`, called from the single chokepoint at
`moStation.js:685`. Schemes differ on some tests, not all; an override table
stays small, and onboarding a scheme does not mean re-entering forty prices. The
existing rule that the order line snapshots its price (`giniflow_lab_order_tests.price`)
is what keeps a scheme change from re-pricing a quoted order, and it already
works — nothing to add.

⚠️ The base catalogue is still entirely placeholder figures stamped
`prototype_placeholder`, and reception's warning about it
(`receptionStation.js:141`) must stay up until the hospital's real tariff lands.
Scheme overrides on top of fictional base prices are still fictional.

**c. Procedure / imaging** — classified by the bill extractor, but has no
catalogue in Gini at all. Out of scope for v1; named here so it is not mistaken
for an oversight.

## 5. The daily cap

**Dimension: per scheme, per calendar day, hospital-wide.** Not per doctor and
not per slot — a CGHS ceiling is a reimbursement-volume agreement with the
scheme, not a scheduling matter for one consultant. A per-doctor override can be
added later as a nullable column; it should not shape v1.

Counted with the existing `ACTIVE_BOOKING_SQL` from `availability.js:25`
(`status NOT IN ('cancelled','no_show')`) so the number agrees with every other
screen in the app:

```sql
SELECT COUNT(*) FROM appointments
 WHERE appointment_date = $1 AND patient_category = $2
   AND status NOT IN ('cancelled','no_show')
```

Enforced in `bookingGuard.js` as a new refusal reason alongside `full`. Three
things it has to get right:

1. **Sync-created appointments count but cannot be blocked.** HealthRay is
   authoritative; rejecting its rows would only desync the two systems. So they
   increment the count and never fail. The cap binds the two guarded booking
   paths (`ghm-appointments.js:1309`, `appointments.js`) and advises everywhere
   else. The GHM sheet grows an "ECHS 8/10 today" counter so OBT sees the ceiling
   before it is hit, not after.
2. **`SCHEDULE_ENFORCEMENT` is `off` in production.** The cap must not inherit a
   disabled guard. It gets its own switch — `SCHEME_CAP_ENFORCEMENT`, with the
   same `off` / `warn` / `strict` shape — and ships in `warn`.
3. **Count inside the booking transaction.** Two OBT bookings racing at 9/10 both
   pass an unlocked count. Take it in the same transaction as the insert.

## 6. Order of work

Five steps, each shippable and testable on its own.

1. **Scheme list becomes data.** `patient_schemes` + `SCHEME_ADMIN` +
   `/settings/schemes`. Seed the existing five, add ECHS. Gate: both GHM smoke
   scripts pass unchanged.
2. **Patient tag + inheritance.** `patients.scheme_code` / `scheme_ref`, the four
   entry points, the snapshot-at-creation rule. Gate: a walk-in can be tagged at
   the desk, and their next HealthRay-synced booking arrives tagged.
3. **Daily cap.** `daily_cap`, the guard, the GHM counter, the override audit.
   Ship in `warn`; watch a week of real bookings; then `strict`.
4. **Scheme test pricing.** `scheme_test_prices`, `pricing.js`, wired into
   `moStation.js`. Gate: an order for a tagged patient prices at the override and
   an untagged one is unchanged to the rupee.
5. **OPD fee display + bill reconciliation.** `scheme_opd_fees`, shown at
   check-in; the reconciliation report over `billingExtractor` output.

Steps 1–3 answer the capacity requirement. Steps 4–5 answer billing, with the
limit in §4a understood.

## 7. Open questions

1. **Cap dimension.** Confirmed as per scheme per day hospital-wide? A
   per-doctor cap is a different table shape and is cheaper to decide now than to
   retrofit.
2. **The real tariff.** Is there a CGHS/ECHS rate card — OPD fee and test rates?
   Steps 4 and 5 cannot ship against placeholder numbers.
3. **OPD billing.** Display + reconcile, as scoped in §4a? If Gini is expected to
   push the fee into HealthRay, that is a separate investigation into whether any
   HealthRay write path exists at all — nothing in this repo suggests one does.
4. **What happens at the cap.** Hard refuse, or offer the next day with free
   capacity? `availability.js:226` already has a suggest-alternative resolver
   that could be reused.
5. **Card expiry.** Does `scheme_ref` need a validity date, and should an expired
   card drop the patient to General automatically or just warn the desk?
