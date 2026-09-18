# 52 — Billing: OPD, Lab, Machine tests, ECHO, X-ray (and Pharmacy later)

Status: **PLAN, not built.** Written 2026-09-17 against the code as it stands.
Nothing in this document has been implemented or migrated yet.

Task list: `52-BILLING-TASKS.md`.

Builds on `28-LAB-PAYMENT-SPLIT-PLAN.md` (cash + claim split),
`33-PATIENT-SCHEME-PLAN.md` (schemes, scheme price tables),
`34-LAB-BILLING-STEP-PLAN.md` (pay before the lab) and
`51-BILL-DRIVEN-TEST-STEPS-PLAN.md` (test steps follow the HealthRay bill).

---

## 0. Summary

Scribe gets its own billing: bills are **made, discounted, paid and reported**
in Scribe. **HealthRay billing is not replaced**, and Scribe billing doesn't
read or compare against it at all.

**Nothing billing-related is hardcoded.** Groups, items, prices, categories,
sub-categories, who belongs to a category, discount codes, discount %, what each
code covers, stacking and pay-later are all created, updated and deleted by an
admin, in screens or by Excel upload.

The design has eight parts:

1. **Service master.** Every billable thing is its own **service item**, with
   its own price. Each item sits in a **group** and a **subgroup**, so revenue
   can be reported by OPD, Lab, Machines, ECHO, X-ray and Pharmacy, and below
   that by subgroup and by individual test. There is **no generic "lab test" or
   "machine test" item**; every test the hospital runs is listed by name. For
   example:
   - **OPD:** consultation with each named consultant, New and Follow Up.
   - **Lab:** each report separately, e.g. HbA1c, Fasting Blood Sugar, Lipid
     Profile, KFT, LFT, CBC, TSH, Vitamin D, C-Peptide, HOMA-IR, UACR, Urine R/M,
     and every other test in the lab catalogue.
   - **Machines:** each test separately, e.g. ABI, VPT, Fundus, ECG, TMT.
   - **ECHO:** e.g. 2D Echo, and any other echo study.
   - **X-ray:** each view or study separately, e.g. Chest X-ray PA, Knee AP/Lat.
   - **Pharmacy (later):** each medicine.
2. **Patient categories with sub-categories.** Examples are General, CGHS (and
   CGHS sub-categories), ECHS, Senior Citizen and insurance/TPA. Each category
   decides the **price list**, **who pays** (the patient, or a payer that
   reimburses later), and **how the item is named and coded on the bill**, for
   example "Consultant meet with Dr Banshali — CC02". The admin also defines
   **which patients fall into a category** (e.g. by age).
   The **actual price** and **what the patient pays** are stored separately.
   Admin payment rules decide the patient's part: e.g. CGHS Paid pays an amount
   the admin enters (₹700 in the example) for the consultation; CGHS Referral
   and Pensioner pay ₹0. The rest is claimed from CGHS.
   **Each doctor has his own fee in each category** (e.g. Pensioner / Referral
   bill ₹350 for Dr Rahul and Dr Beant, ₹700 for Dr Banshali), set by the admin
   on one Consultant fees screen.
3. **Discounts, two methods only:**
   - **Automatic** rules, e.g. an age rule the admin sets to 70.
   - **Codes** that reception types in, e.g. `CC50` = 50% off consultation.
     A code can be limited to certain doctors, with usage limits in total, per
     patient, **per day**, and per doctor per day.
   - **No manual discounts.** If a discount is not a rule or a code, it can't
     be given.
4. **Reception can never change a price.** Prices come only from the master.
   New items, categories and rates are added only by an admin or a new
   **reception admin** role.
5. **Payments** by cash, card or UPI, split across modes if needed. Cashless
   categories pay nothing (or only their share) at the counter.
   Cashless amounts become a **receivable** that is claimed from the payer.
   Pay-later is **off by default**; an admin can switch it on.
   A visit can have **several bills**, but an item already billed for that
   visit is **never added to a second bill** unless an admin approves that
   specific case. Reception can also ask the admin for a missing item from the
   Billing Counter screen.
6. **GST-ready.** Tax codes (SAC/HSN, rate) exist on every item and bill line
   from day one, but stay at 0% and switched off until the hospital needs them.
7. **CGHS pending register.** Every bill with an amount to be claimed from
   CGHS (Pensioner, CGHS Referral, and the CGHS part of CGHS Paid) is listed as
   **Pending** in a separate section for admin and reception admin. When CGHS
   pays into the bank, one or many bills are marked **Cleared** with the date,
   reference and amount (always the full amount).
8. **Bulk Excel upload** of groups, subgroups, items, categories, category rules,
   category rates, payment rules and discount codes. The upload is checked and previewed before anything is
   saved.

---

## 1. What was asked (2026-09-17)

| #   | Requirement                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Billing for OPD consultation, Lab, Machine tests, ECHO, X-ray. Everything is data managed by an admin, not hardcoded.                                                                                                                                                                          |
| R2  | Payment modes: cash, card, UPI, and **cashless** for some categories (e.g. CGHS). The cashless part is billed to the payer and goes for reimbursement.                                                                                                                                         |
| R3  | Categories have **sub-categories** (CGHS has several).                                                                                                                                                                                                                                         |
| R4  | **Service groups and subgroups**, so dashboards show revenue by OPD / Pharmacy / Lab / Machines etc., and discount decisions can be based on that.                                                                                                                                             |
| R5  | **Discount codes** at reception (e.g. `CC50` = consultant cost 50% off). Which code gives what % on which group (OPD, Lab, Machine…) is set by the admin. No manual discounts.                                                                                                                 |
| R6  | **Category price lists**: CGHS, Senior Citizen etc. can have a different price per item.                                                                                                                                                                                                       |
| R7  | **Automatic fixed discounts**: e.g. patient aged 70 or over gets a discount without anyone applying it.                                                                                                                                                                                        |
| R8  | Bill lines come from what the visit actually contains: consultation line for the consultant, lab lines for lab tests, machine lines for machine tests. Each line has a **quantity** and an amount.                                                                                             |
| R9  | **GST** is not charged today, but the feature must exist so it can be switched on later.                                                                                                                                                                                                       |
| R10 | Some categories need **their own item name and code on the bill**. Example: a CGHS patient seeing Dr Banshali gets "Consultant meet with Dr Banshali CC02" automatically, at the CGHS rate. The design does not have to copy HealthRay's way of doing this.                                    |
| R11 | **Bulk upload** from an Excel template, so a new category or insurer can be added in one go.                                                                                                                                                                                                   |
| R12 | **No price override at the desk.** In HealthRay reception can type a new price and that price gets added to the catalogue. That must not be possible here. New items and categories are added only by admin / super admin / a reception admin.                                                 |
| R13 | **Category payment rules**: the patient's payable amount is stored separately from the actual price and set per category (e.g. CGHS Paid pays ₹700 on a ₹1,500 or ₹1,000 consultation; CGHS Referral and Pensioner pay ₹0). Same rules for OPD, Lab, Machine, ECHO, X-ray.                     |
| R14 | **Consultant fee per doctor per category**: each doctor has his own consultation fee in each category and sub-category (e.g. Pensioner / CGHS Referral bill: ₹350 for Dr Rahul and Dr Beant, ₹700 for Dr Banshali), and the admin sets what the patient pays for that doctor in that category. |
| R15 | **Doctor coupons**: discount codes can be tied to specific doctors, with usage limits including **how many times a day** a code can be used.                                                                                                                                                   |
| R16 | **CGHS pending register**: a Pensioner / CGHS Referral bill is created, only a printout is given, and it shows as **Pending** until CGHS pays directly into the hospital account; then it is **Cleared**. A separate section, seen only by admin and reception admin.                          |

### Answers given on 2026-09-17

| Question                                   | Answer                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Replace HealthRay billing?                 | **No, not for now.** Both run.                                                                              |
| CGHS sub-categories and their rates        | **Fully dynamic.** Admin creates, updates and deletes them.                                                 |
| Discount %, stacking, rule on scheme rates | **Fully dynamic, per group** (Lab, Machine, OPD…). Admin decides which code covers what. Nothing hardcoded. |
| Senior Citizen and who is in a category    | **Admin-defined.** The admin sets the rules that decide which patients fall into a category.                |
| One bill or several per visit              | **Several bills**, but an item already on an earlier bill for the visit is **not added again**.             |
| Manual discounts                           | **Not allowed.**                                                                                            |
| Pay later                                  | **Not allowed by default**, with an admin toggle to allow it.                                               |

---

## 2. What exists today (re-checked in code)

| Piece                                                                     | Where                                                                                     | State                                                                                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Who makes the bill                                                        | HealthRay                                                                                 | Scribe only reads it (`healthray/billingExtractor.js`) and stores a copy in `giniflow_patient_bills` (51) |
| Scheme list (CGHS, ECHS, Himachal Govt, Senior Citizen, Special Discount) | `patient_schemes`, `/settings/schemes`                                                    | Built. One level only, no sub-categories. No "who pays" field                                             |
| Scheme on the patient and appointment                                     | `patients.scheme_code` / `scheme_ref` (encrypted), `appointments.patient_category`        | Built. Scheme is copied onto the appointment when it is created                                           |
| Test price list (lab, machine, ECHO, X-ray, offsite)                      | `giniflow_test_catalog` (`category`, `price`, `source`)                                   | Built. **Prices are placeholders.** The table also decides which station a test goes to                   |
| Scheme price tables                                                       | `scheme_test_prices`, `scheme_opd_fees`, `scheme_medicine_prices`                         | Built, **all empty**                                                                                      |
| Price lookup                                                              | `server/services/pricing.js`                                                              | Built: scheme price if one exists, otherwise the base price                                               |
| Lab/machine order money                                                   | `giniflow_lab_orders.amount_total / amount_paid / amount_claimed / claim_state / version` | Built. Arithmetic in paise via `shared/labPayment.js`                                                     |
| Pay-before-test gate                                                      | Lab Billing step (34), reception payment queue                                            | Built                                                                                                     |
| Normal OPD fee per consultant                                             | —                                                                                         | **Missing**                                                                                               |
| Discount codes / automatic rules / approvals                              | —                                                                                         | **Missing**                                                                                               |
| Invoices, bill numbers, receipts, payment modes, refunds, cash closing    | —                                                                                         | **Missing**                                                                                               |
| Receivables / reimbursement claims per payer                              | —                                                                                         | **Missing** (only a per-lab-order `claim_state`)                                                          |
| Tax                                                                       | —                                                                                         | **Missing**                                                                                               |
| Excel handling                                                            | `xlsx` already a dependency (client and server)                                           | Reuse                                                                                                     |
| Role pattern for a desk admin                                             | `lab_admin` in `shared/permissions.js`                                                    | Precedent for a `reception_admin` role                                                                    |

**Adoption warning, from plan 33:** in the last 60 days before that plan, 0 of
7,413 appointments had a category set. Category pricing and automatic discounts
only work if the category is set, so the billing screen must ask for it (§8.2).

---

## 3. Decisions

| #   | Decision                                                                                                                                                                                                                                                | Status             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| D1  | **Scribe makes its own bills alongside HealthRay. It does not replace HealthRay billing.** Scribe bills carry Scribe's prices, discounts, payment modes, receivables and bill codes.                                                                    | Decided 2026-09-17 |
| D2  | **Scribe billing ignores HealthRay billing completely**: no reading, comparing or copying. Plan 51 (test steps follow the HealthRay bill) is a separate feature and is left unchanged (§12).                                                            | Decided 2026-09-17 |
| D3  | **The server calculates every price.** The client sends only `service_item_id`, quantity and discount code/request. No endpoint accepts a rate from reception.                                                                                          | Fixed (R12)        |
| D4  | **Every bill line saves its price at the time of billing**: name, code, group, rate, discount, tax. Later master changes never alter an existing bill. This is the rule already used for lab orders.                                                    | Fixed              |
| D5  | Money is stored as `NUMERIC(12,2)` and calculated in **integer paise** with `shared/labPayment.js` helpers. No floating-point rupee arithmetic.                                                                                                         | Fixed              |
| D6  | **Bills are never deleted.** A cancelled bill keeps its number and lines, marked cancelled, with an audit record. Refunds and credit notes are on hold (Q14).                                                                                           | Fixed              |
| D7  | `patient_schemes.code` stays the join key for categories (plan 33 R1). Sub-categories are rows in the same table with a `parent_code`. No fourth "category" column is added anywhere.                                                                   | Fixed              |
| D8  | **Nothing is hardcoded.** No discount %, code, age limit, category rule, group or price exists in code. The migrations seed **no** business values; everything comes from admin screens or Excel.                                                       | Decided 2026-09-17 |
| D9  | **Master data has full create / update / delete.** Delete removes a row only if no bill, order or rule uses it; otherwise the admin is told where it is used and offered "deactivate" instead. Old bills still read correctly either way because of D4. | Decided 2026-09-17 |
| D10 | **Discounts come only from automatic rules and codes.** There is no manual discount anywhere: no field, no endpoint.                                                                                                                                    | Decided 2026-09-17 |
| D11 | **Pay later is off by default.** A setting, switched by admin, allows it (globally, and per category if needed).                                                                                                                                        | Decided 2026-09-17 |
| D12 | **Several bills per visit, no duplicate items.** An item already on a live bill for the visit is not added to a new bill (§7).                                                                                                                          | Decided 2026-09-17 |
| D13 | **Every task ships with an end-to-end test that has been run and passes** (§16). Tests run only against a local test database, never production.                                                                                                        | Decided 2026-09-17 |
| D14 | **Claims are tracked per bill as Pending → Cleared** (no claim batches, no deductions). A CGHS payment clears one or many bills; its amount must equal their total (§8.3).                                                                              | Decided 2026-09-17 |

---

## 4. Vocabulary

| Term                   | Meaning                                                                                       | Example                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Service group**      | Top-level revenue head used in dashboards                                                     | OPD, Lab, Machine, ECHO, X-ray, Pharmacy                                                       |
| **Service subgroup**   | Second level inside a group                                                                   | Lab › Biochemistry, Lab › Haematology, Lab › Hormones; Machine › Neuropathy, Machine › Cardiac |
| **Service item**       | One **named** billable thing with its own base price. Never a generic "lab test"              | "Consultant meet — Dr Banshali (Follow Up)", "HbA1c", "Lipid Profile", "ABI", "VPT", "2D Echo" |
| **Category**           | The patient's billing category (`patient_schemes`). Decides price list, payer and bill naming | General, CGHS, ECHS, Senior Citizen, Star Health                                               |
| **Sub-category**       | Child of a category. Uses the parent's rates and rules unless it has its own                  | CGHS › CGHS Paid, CGHS › CGHS Referral, CGHS › Pensioner                                       |
| **Actual amount**      | What the service costs (base price or category rate × quantity)                               | Consultation (New) ₹1,500                                                                      |
| **Patient payable**    | What the counter collects from the patient, stored separately from the actual amount          | CGHS Paid: ₹700                                                                                |
| **Payment rule**       | Admin rule per category (and group/item/visit type) that turns actual into patient payable    | `amount` (admin enters ₹, e.g. 700), `percent`, `nothing`, `full`                              |
| **Claim / adjustment** | Actual − patient payable: either claimed from the payer or written off by the hospital        | ₹800 claimed from CGHS                                                                         |
| **Category rate**      | A category's own price for one item, optionally with its **own bill name and item code**      | CGHS › Dr Banshali consult = ₹X, code `CC02`                                                   |
| **Category rule**      | An admin-defined condition that puts a patient into a category                                | "Age ≥ 60 → Senior Citizen"                                                                    |
| **Discount rule**      | An admin-defined rule that reduces a line's price: automatic, or by code                      | an age rule, `CC50`                                                                            |
| **Tax code**           | GST class for an item (SAC/HSN + rate). 0% today                                              | `EXEMPT-HC` 0%, `GST18` 18%                                                                    |

⚠️ **Naming trap: two things are both called "code".** `CC02` in R10 is a
**category item code** printed on the bill. `CC50` in R5 is a **discount code**
typed at the desk. They are different things in different tables. The admin UI
labels them "Bill code (for this category)" and "Discount code". The system
rejects a discount code that is identical to any category item code, so the
desk can never confuse them.

---

## 5. Data model

All tables are new except where marked **(extend)**. Every table has
`created_at`, `updated_at`, `created_by`, `updated_by` (omitted below for
brevity). Every table has RLS enabled and anon access revoked, the same as
`giniflow_patient_bills` (see the Supabase lockdown memory).

**Codes (decided 2026-09-18, P1-04 review):** on every new billing table with
a `code` column, the code is unique **ignoring case** (a unique index on
`lower(code)`, so `LAB` and `lab` can't both exist), can't be blank and has no
spaces. Every lookup compares `lower(code)`, and every "update if it exists"
matches on `lower(code)` (`ON CONFLICT ((lower(code)))`), never on plain
`code`. The code is stored as the admin typed it. The database does not set
`updated_at` / `updated_by` by itself: every update sets `updated_at = NOW()`
and `updated_by` to the signed-in user.

### 5.1 Service master

```sql
service_groups
  id            SERIAL PK
  code          TEXT UNIQUE NOT NULL        -- 'OPD','LAB','MACHINE','ECHO','XRAY','PHARMACY'
  name          TEXT NOT NULL
  sort_order    INT NOT NULL DEFAULT 0
  is_active     BOOLEAN NOT NULL DEFAULT TRUE

service_subgroups
  id            SERIAL PK
  group_id      INT NOT NULL REFERENCES service_groups
  code          TEXT UNIQUE NOT NULL        -- 'OPD_NEW','LAB_BIOCHEM','LAB_HAEM','LAB_HORMONE','MC_NEURO','MC_CARDIAC' ...
  name          TEXT NOT NULL
  sort_order, is_active

tax_codes
  id            SERIAL PK
  code          TEXT UNIQUE NOT NULL        -- 'EXEMPT','GST5','GST12','GST18'
  sac_hsn       TEXT                        -- 999312 etc.
  rate_pct      NUMERIC(5,2) NOT NULL DEFAULT 0
  is_active

service_items
  id               SERIAL PK
  code             TEXT UNIQUE NOT NULL     -- hospital's own item code, e.g. 'OPD-BANSHALI-FU'
  name             TEXT NOT NULL            -- printed on the bill for General patients
  subgroup_id      INT NOT NULL REFERENCES service_subgroups
  base_price       NUMERIC(12,2) NOT NULL CHECK (base_price >= 0)
  unit             TEXT NOT NULL DEFAULT 'each'
  allow_quantity   BOOLEAN NOT NULL DEFAULT FALSE  -- consultation = 1 only; e.g. dressings can be >1
  max_quantity     INT
  tax_code_id      INT REFERENCES tax_codes     -- NULL = exempt
  price_includes_tax BOOLEAN NOT NULL DEFAULT FALSE
  -- what the item is, so a visit can find it automatically (§7)
  kind             TEXT NOT NULL CHECK (kind IN ('consultation','test','procedure','medicine','other'))
  doctor_id        INT REFERENCES doctors        -- consultation items
  visit_type       TEXT                          -- consultation items: 'New' / 'Follow Up' only (no fee for Investigation visits)
  test_catalog_id  UUID REFERENCES giniflow_test_catalog  -- lab/machine/echo/xray items
  is_active        BOOLEAN NOT NULL DEFAULT TRUE

  UNIQUE (doctor_id, visit_type) WHERE kind = 'consultation' AND is_active
  UNIQUE (test_catalog_id)       WHERE test_catalog_id IS NOT NULL

service_item_price_history
  service_item_id, old_price, new_price, changed_by, changed_at, reason
```

**Relationship with `giniflow_test_catalog`.** The test catalogue keeps its job
of deciding which station runs a test (`category`: lab / machine / echo / xray /
offsite). The **price moves to `service_items`**, linked by `test_catalog_id`.
`pricing.testPricesFor` is changed to read `service_items.base_price` through
that link, so the MO ordering screen and the lab payment queue keep working. The
`giniflow_test_catalog.price` column stays for one release as a read-only copy,
then is dropped. The admin test-catalog page stops editing price and links to
the service master instead. This keeps **one price source**.

**Every test is its own item.** The service master lists each test by name,
with its own price. Lab tests come from the lab catalogue's reports (about 41
today: HbA1c, Lipid Profile, C-Peptide, Fasting Blood Sugar, HOMA-IR…), and
machine tests from the machine catalogue (ABI, VPT, Fundus, ECG, TMT, 2D Echo,
X-ray). A report that holds many values, such as Lipid Profile or CBC, is
**one** billable item; its individual values (HDL, LDL, haemoglobin…) are not
billed separately. A test that exists in the catalogue but has no service item
yet can't be billed. The admin screen lists those tests as "not priced" so none
are missed.

**No packages (Q24).** The hospital doesn't sell test bundles, so there is no
package item; each ordered test is always its own bill line.

Example layout (entered by the admin, not seeded):

| Group   | Subgroup                     | Items (examples)                                                   |
| ------- | ---------------------------- | ------------------------------------------------------------------ |
| OPD     | New consultation / Follow Up | Consultant meet — Dr Banshali (New), … (Follow Up), one per doctor |
| Lab     | Biochemistry                 | HbA1c, Fasting Blood Sugar, Lipid Profile, KFT, LFT                |
| Lab     | Haematology                  | CBC                                                                |
| Lab     | Hormones / Special           | TSH, Vitamin D, C-Peptide, HOMA-IR                                 |
| Lab     | Urine                        | Urine R/M, UACR                                                    |
| Machine | Neuropathy / Vascular        | ABI, VPT                                                           |
| Machine | Eye                          | Fundus                                                             |
| Machine | Cardiac                      | ECG, TMT                                                           |
| ECHO    | Echo                         | 2D Echo                                                            |
| X-ray   | X-ray                        | Chest X-ray PA, Knee AP/Lat, …                                     |

**Consultant fee.** One consultation item per consultant per visit type, e.g.
"Consultant meet — Dr Banshali (New)" and "… (Follow Up)". A hospital-default
consultation item (`doctor_id` NULL) covers consultants with no item of their
own. There is at most **one active default per visit type** (enforced by the
database, P1-06).

**A doctor's fee differs by category (R14).** The item's `base_price` is the
General fee. The fee for that doctor in any category or sub-category is a
`category_item_rates` row on that doctor's consultation item, and what the
patient pays is a `category_payment_rules` row on the same item. No new table
is needed; the **Consultant fees** screen (§8.1) shows and edits both as one
grid. Example the admin would enter (figures from the hospital, 2026-09-17):

| Doctor      | Visit type | General | CGHS › Pensioner  | CGHS › CGHS Referral |
| ----------- | ---------- | ------- | ----------------- | -------------------- |
| Dr Rahul    | any        | (base)  | fee ₹350, pays ₹0 | fee ₹350, pays ₹0    |
| Dr Beant    | any        | (base)  | fee ₹350, pays ₹0 | fee ₹350, pays ₹0    |
| Dr Banshali | any        | (base)  | fee ₹700, pays ₹0 | fee ₹700, pays ₹0    |

### 5.2 Categories (extend `patient_schemes`)

```sql
ALTER TABLE patient_schemes
  ADD parent_code   TEXT REFERENCES patient_schemes(code),   -- sub-category
  ADD payer_name    TEXT,          -- who claims are sent to: 'CGHS Wellness Centre Chandigarh', 'Star Health'
  ADD requires_referral BOOLEAN NOT NULL DEFAULT FALSE,  -- e.g. CGHS Referral: referral number recorded on the bill
  ADD requires_referral_doc BOOLEAN NOT NULL DEFAULT FALSE,  -- optional: a scan of the form is attached
  ADD print_category_on_bill BOOLEAN NOT NULL DEFAULT FALSE,
  ADD allow_pay_later BOOLEAN;     -- NULL = follow billing_settings.allow_pay_later

```

**Sub-categories and existing features (decided 2026-09-18, P1-08 review):**
a parent's daily cap counts the parent and all its sub-categories together; a
sub-category may have its own cap as well, and a booking must pass both.
Wherever categories are listed, a sub-category shows as "CGHS › Pensioner".
Only two levels exist; the database refuses a third, even under simultaneous
edits.

```sql
category_rules                     -- who falls into a category (admin-defined)
  id            SERIAL PK
  scheme_code   TEXT NOT NULL REFERENCES patient_schemes(code) ON DELETE CASCADE
  name          TEXT NOT NULL      -- 'Senior Citizen — 60 and over'
  min_age       INT
  max_age       INT
  gender        TEXT
  requires_card BOOLEAN NOT NULL DEFAULT FALSE  -- only if the patient has a card number saved
  mode          TEXT NOT NULL DEFAULT 'suggest' CHECK (mode IN ('suggest','auto'))
  priority      INT NOT NULL DEFAULT 100
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
  UNIQUE (scheme_code, name)
```

- Categories and sub-categories (CGHS › …) are fully managed by the admin:
  create, edit, delete (D9), deactivate, reorder. Only two levels: a
  sub-category may not itself have children. A trigger enforces this.
- **Senior Citizen stays a category** if the admin wants it to be one. It is
  given a category rule (e.g. age ≥ 60) and its own rates or discount rules,
  all set by the admin. Special Discount is handled the same way, or replaced by
  a discount code — the admin's choice.
- **Insurance / TPA** companies are categories too, with their own payment
  rules (§5.4). A new insurer is a row (or an Excel upload), not code.
- **CGHS structure (decided 2026-09-17).** CGHS is one category with three
  sub-categories. **Pensioner and CGHS Referral are sub-categories of CGHS,
  not separate categories.** The admin creates these rows (they are not
  seeded):
  - **CGHS**
    - **CGHS Paid:** patient pays an amount the admin sets; the rest is claimed
      from CGHS.
    - **CGHS Referral:** patient pays nothing, every visit; the full amount is
      claimed from CGHS.
    - **Pensioner:** patient pays nothing; the full amount is claimed from
      CGHS.
  - **ECHS**, **Senior Citizen**, insurers, … and **General** (no category).
- **A category with sub-categories is not billable on its own.** Once CGHS has
  sub-categories, a bill must be confirmed as CGHS Paid, CGHS Referral or
  Pensioner, never bare "CGHS". Screens show sub-categories under their parent,
  e.g. "CGHS › Pensioner".
- **Inheritance.** A sub-category uses the parent's payer name, category rates
  and payment rules unless it has its own. All three CGHS sub-categories claim
  from the same CGHS payer and appear together in the CGHS pending register.

**How a patient's category is decided at billing** (Q15, decided 2026-09-17:
the record wins):

1. A category set explicitly on the appointment or the patient record (e.g.
   CGHS with a card number) **always wins**, even when an automatic rule also
   matches. A 75-year-old recorded as General stays General; the desk sees the
   matching Senior Citizen rule only as a suggestion.
2. Otherwise, category rules are checked in `priority` order. The first `auto`
   rule that matches is applied. A matching `suggest` rule is shown to the desk
   as a one-tap suggestion.
3. Otherwise the patient is General.

The criteria a rule can use (age, gender, has a card) are fields in the table;
their **values** are always the admin's. A new kind of criterion (for example
"district") would be a small code change, the same as adding any new field.

### 5.3 Category rates and category bill codes (replaces the three empty `scheme_*_prices` tables)

```sql
category_item_rates
  scheme_code      TEXT NOT NULL REFERENCES patient_schemes(code)
  service_item_id  INT  NOT NULL REFERENCES service_items
  rate             NUMERIC(12,2) CHECK (rate >= 0)    -- NULL = use the base price, only rename/code
  -- rows for sub-categories override the parent's row for the same item
  bill_name        TEXT      -- 'Consultant meet with Dr Banshali CC02'; NULL = item's own name
  bill_code        TEXT      -- 'CC02'; printed on the bill and on the claim
  valid_from       DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date
  valid_to         DATE
  PRIMARY KEY (scheme_code, service_item_id, valid_from)
```

This covers R6 and R10 **without duplicate items**. HealthRay keeps two items,
"Consultant meet Dr Banshali" and "Consultant meet Dr Banshali CC02". Here there
is one item, plus a CGHS row that changes its **rate, bill name and bill code**.
When the patient is CGHS, the line is added under the CGHS name and code
automatically.

`scheme_test_prices`, `scheme_opd_fees` and `scheme_medicine_prices` are empty
(plan 33). `pricing.js` and the Reception station query are moved to
`category_item_rates` first (P1-24); the three tables are dropped by a
separate migration only after that code is live (P1-10, reordered
2026-09-18), because the current code still reads them. `medicine_catalog` stays as it is until Pharmacy
billing (Phase 6).

`valid_from` / `valid_to` exist because CGHS revises its rates. A new rate
card is loaded with a future `valid_from` and nobody has to switch it on at
midnight. Two rates for the same category and item never cover the same day:
when a new rate is saved, the current open-ended rate is ended automatically
on the day before the new one starts (decided 2026-09-18, P1-09 review).
Every date default uses the India date,
`(NOW() AT TIME ZONE 'Asia/Kolkata')::date`, never `CURRENT_DATE` (the
database clock is UTC).

### 5.3a Category payment rules: what the patient pays (added 2026-09-17)

The actual price of a service and the amount the patient pays are **two
different numbers**, stored separately. Example: CGHS Paid pays ₹700 whether
the consultation costs ₹1,500 or ₹1,000. A category rate (§5.3) changes the
actual price; a payment rule decides the patient's part of it.

```sql
category_payment_rules
  id               SERIAL PK
  scheme_code      TEXT NOT NULL REFERENCES patient_schemes(code) ON DELETE CASCADE
  name             TEXT NOT NULL            -- 'CGHS Paid — consultation, patient pays ₹700'
  -- scope: the most specific matching rule wins (item > subgroup > group > whole category)
  group_id         INT REFERENCES service_groups
  subgroup_id      INT REFERENCES service_subgroups
  service_item_id  INT REFERENCES service_items
  visit_types      TEXT[]                   -- NULL = any; {'New'} = 1st visit, {'Follow Up'} = later visits (Q21: visit type, decided)
  -- what the patient pays
  patient_pays     TEXT NOT NULL CHECK (patient_pays IN ('full','amount','percent','nothing'))
  patient_value    NUMERIC(12,2)            -- admin-entered: ₹ for amount, % for percent; NULL otherwise
  -- where the rest (actual − patient payable) goes
  remainder        TEXT NOT NULL DEFAULT 'claim' CHECK (remainder IN ('claim','adjustment'))
  valid_from       DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date
  valid_to         DATE
  priority         INT NOT NULL DEFAULT 100 -- tie-break between rules at the same level
  is_active        BOOLEAN NOT NULL DEFAULT TRUE

  UNIQUE (scheme_code, name)
  CHECK (at most one of group_id / subgroup_id / service_item_id is set)
  CHECK (patient_pays NOT IN ('amount','percent') OR patient_value IS NOT NULL)
```

- A category with **no rule** for a line means the patient pays in full. That
  is how General works, and how an item a scheme doesn't cover is expressed.
- Rules on a sub-category (CGHS Paid) are checked before rules on its parent
  (CGHS), so a parent can hold defaults that sub-categories override.
- **Referral categories** (Q22, decided 2026-09-17): a CGHS department
  referral patient is **billed every visit, and nothing is collected**. The full
  amount is always claimed from CGHS. The referral has **no visit count and no
  expiry** to track. If `requires_referral` is set, the desk records the
  referral number (plus a scan when `requires_referral_doc` is set). Without
  them, the bill can't be finalised under that category. They are saved on the
  bill (§5.5).
- A rule with `remainder = claim` can only be saved when the category (or its
  parent) has a `payer_name`, so every claimed rupee has someone to claim it
  from.
- The same table covers every group: OPD, Lab, Machine, ECHO, X-ray, and later
  Pharmacy. Nothing about CGHS is written in code.

### 5.4 Discounts

```sql
discount_rules
  id               SERIAL PK
  code             TEXT UNIQUE            -- 'CC50'; NULL for automatic rules that have no code
  name             TEXT NOT NULL UNIQUE   -- 'Consultation 50% off'
  method           TEXT NOT NULL CHECK (method IN ('auto','code'))   -- no manual (D10)
  kind             TEXT NOT NULL CHECK (kind IN ('percent','flat','fixed_price'))
  value            NUMERIC(12,2) NOT NULL CHECK (value >= 0)
  max_discount     NUMERIC(12,2)          -- cap for percent rules
  -- WHAT it applies to (all NULL = everything)
  group_ids        INT[]
  subgroup_ids     INT[]
  service_item_ids INT[]
  doctor_ids       INT[]
  visit_types      TEXT[]
  -- WHO it applies to
  scheme_codes     TEXT[]                 -- NULL = any category; 'general' in the list = patients with no category
  min_age          INT                    -- e.g. the admin enters 70 for an age rule
  max_age          INT
  gender           TEXT
  -- WHEN / HOW MUCH
  valid_from       DATE
  valid_to         DATE
  max_uses_total   INT
  max_uses_per_patient INT
  max_uses_per_day INT                    -- across the hospital, per calendar day (IST)
  max_uses_per_doctor_per_day INT         -- per doctor on the line, per calendar day
  applies_per      TEXT NOT NULL DEFAULT 'line' CHECK (applies_per IN ('line','bill'))
  -- CONTROL
  priority         INT NOT NULL DEFAULT 100
  stackable        BOOLEAN NOT NULL DEFAULT FALSE  -- used when stacking is 'per_rule'
  applies_on_scheme_rate BOOLEAN NOT NULL DEFAULT FALSE  -- also on lines under a payment rule (reduces patient payable)
  allowed_roles    TEXT[]                 -- who may apply this code; NULL = any billing desk role
  is_active        BOOLEAN NOT NULL DEFAULT TRUE

billing_settings                          -- one row, admin-managed
  discount_stacking   TEXT NOT NULL DEFAULT 'best_only'
                      CHECK (discount_stacking IN ('best_only','per_rule'))
  allow_pay_later     BOOLEAN NOT NULL DEFAULT FALSE     -- D11
  max_codes_per_bill  INT                                -- NULL = no limit
  gst_enabled, gstin, state_code, legal_name             -- §11
  bill_footer         -- terms / note printed at the bottom
  -- the hospital name, address and logo are NOT stored here: the printed bill
  -- reuses the identity and letterhead already kept in /settings/prescription
```

**None of these rows ship with the code** (D8). The table below only shows what
an admin could enter:

| code    | method | kind    | value | applies to    | who                           |
| ------- | ------ | ------- | ----- | ------------- | ----------------------------- |
| `CC50`  | code   | percent | 50    | group OPD     | categories chosen by admin    |
| `LAB20` | code   | percent | 20    | group LAB     | —                             |
| `MC10`  | code   | percent | 10    | group MACHINE | —                             |
| —       | auto   | percent | x     | groups chosen | `min_age` chosen by the admin |

**Doctor coupons (R15).** A coupon is a `code` rule with `doctor_ids` set:
it applies only to lines for those doctors (their consultation lines, and test
lines they ordered if the admin also picks test groups). Usage is counted from
`bill_line_discounts` on **final, non-cancelled** bills:

- `max_uses_total`, `max_uses_per_patient` — as before;
- `max_uses_per_day` — all uses of the code on one calendar day;
- `max_uses_per_doctor_per_day` — uses for each doctor on one calendar day.

The count is checked when the code is entered (so the desk sees "Daily limit
reached — 10 of 10 used today") and again inside the finalise transaction with
the rule row locked, so two desks can't both take the last use. A cancelled
bill gives its use back. The Discounts screen shows today's use against each
limit.

### 5.5 Bills, lines, discounts, payments, claims

```sql
bill_series                                   -- numbering, one row per financial year (Q12: one series)
  series  TEXT, fy TEXT, prefix TEXT, number_width INT DEFAULT 6, next_no BIGINT, PRIMARY KEY (series, fy)
  -- e.g. ('MAIN','2026-27','GAC/26-27/', 1) → GAC/26-27/000001
  -- receipts use their own series ('RCPT'); credit notes, if and when built, get 'CN'

bills
  id               UUID PK
  bill_no          TEXT UNIQUE            -- NULL while draft; assigned on finalise, never reused
  series, fy
  bill_type        TEXT NOT NULL CHECK (bill_type IN ('invoice','credit_note'))
  original_bill_id UUID REFERENCES bills  -- for credit notes
  patient_id       INT NOT NULL REFERENCES patients
  visit_id         UUID NOT NULL REFERENCES giniflow_visits  -- every bill belongs to a visit
  appointment_id   INT REFERENCES appointments
  bill_date        DATE NOT NULL
  status           TEXT NOT NULL CHECK (status IN ('draft','final','cancelled'))
  -- snapshots (D4)
  scheme_code      TEXT, scheme_label TEXT, payer_name TEXT
  scheme_ref_enc   TEXT                   -- card number, encrypted (aadhaarCrypt.js)
  referral_no_enc  TEXT                   -- CGHS referral / form number, encrypted
  referral_doc_id  UUID                   -- scanned form, when the category requires one
  patient_age      INT                    -- age used for the age rule, frozen
  pay_later        BOOLEAN NOT NULL DEFAULT FALSE  -- only possible when allowed (D11)
  -- totals (derived from lines, stored for reports)
  actual_amount    NUMERIC(12,2)          -- Σ actual line amounts (the real price of the services)
  discount_amount  NUMERIC(12,2)
  tax_amount       NUMERIC(12,2)
  patient_payable  NUMERIC(12,2)          -- what the counter must collect
  claim_amount     NUMERIC(12,2)          -- to be claimed from the payer
  adjustment_amount NUMERIC(12,2)         -- written off under the category rule
  round_off        NUMERIC(6,2)
  paid_amount      NUMERIC(12,2)          -- Σ patient payments
  claim_status     TEXT NOT NULL DEFAULT 'none'
                   CHECK (claim_status IN ('none','pending','cleared'))  -- R16
  claim_settlement_id UUID                -- set when cleared
  version          INT NOT NULL DEFAULT 0 -- optimistic lock, same as lab orders
  finalised_by, finalised_at, cancelled_by, cancelled_at, cancel_reason

bill_lines
  id               UUID PK
  bill_id          UUID NOT NULL REFERENCES bills
  visit_id         UUID NOT NULL          -- copied from the bill, for the duplicate check
  line_no          INT
  service_item_id  INT NOT NULL REFERENCES service_items
  source           TEXT CHECK (source IN ('visit','lab_order','added'))
  lab_order_id     UUID REFERENCES giniflow_lab_orders
  doctor_id        INT
  is_live          BOOLEAN NOT NULL DEFAULT TRUE  -- FALSE once cancelled
  repeat_request_id UUID REFERENCES billing_requests  -- set only when an admin approved a repeat
  -- snapshots
  group_code, subgroup_code, item_code, bill_code, bill_name
  quantity         NUMERIC(8,2) NOT NULL CHECK (quantity > 0)
  base_rate        NUMERIC(12,2)          -- master price at the time
  rate             NUMERIC(12,2)          -- after category rate
  actual_amount    NUMERIC(12,2)          -- quantity × rate: the real price, always stored
  discount         NUMERIC(12,2)
  tax_code, sac_hsn, tax_rate_pct
  taxable          NUMERIC(12,2)
  cgst, sgst       NUMERIC(12,2)          -- no IGST (Q9)
  -- the payment rule used, and its result (snapshot)
  payment_rule_id  INT                    -- NULL = no rule, patient pays in full
  payment_rule     TEXT                   -- snapshot of the rule as applied, e.g. 'amount ₹700', 'nothing'
  patient_payable  NUMERIC(12,2)          -- what the patient pays for this line
  claim_amount     NUMERIC(12,2)
  adjustment_amount NUMERIC(12,2)

  CHECK (actual_amount - discount + cgst + sgst
         = patient_payable + claim_amount + adjustment_amount)

  -- D12: the same item cannot be live twice on one visit, unless an admin approved it
  UNIQUE (visit_id, service_item_id)
    WHERE is_live AND repeat_request_id IS NULL

bill_line_discounts                       -- every discount applied, and by whom
  id, bill_line_id, rule_id, code, method ('auto'|'code'), amount, applied_by

billing_requests                          -- the desk asks, an admin decides (Q11, Q17)
  id               UUID PK
  kind             TEXT NOT NULL CHECK (kind IN ('new_item','repeat_item'))
  patient_id, visit_id, bill_id           -- where the request came from
  service_item_id  INT REFERENCES service_items   -- repeat_item: the item to bill again
  proposed_name    TEXT                   -- new_item: what the desk needs
  proposed_group   TEXT                   -- new_item: which group it belongs to (a hint)
  reason           TEXT NOT NULL          -- e.g. "second X-ray, other knee, per Dr …"
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','used'))
  requested_by, requested_at
  decided_by, decided_at, decision_note
  created_item_id  INT REFERENCES service_items   -- new_item: the item the admin created

payments
  id               UUID PK
  bill_id          UUID NOT NULL REFERENCES bills
  direction        TEXT CHECK (direction IN ('in'))   -- refunds on hold (Q14)
  mode             TEXT CHECK (mode IN ('cash','card','upi'))   -- the three the desk takes
  amount           NUMERIC(12,2) CHECK (amount > 0)
  reference        TEXT                   -- UPI txn id, card last 4 + approval code
  received_by, received_at
  shift_id         UUID REFERENCES cash_shifts
  receipt_no       TEXT UNIQUE            -- from the 'RCPT' series
  -- a pay-later bill (D11) takes payments later, on any day; its balance shows as "due"

cash_shifts                               -- end-of-day / end-of-shift closing
  id, user_id, opened_at, closed_at, opening_cash, expected_cash, counted_cash, difference, note

claim_settlements                         -- one payment received from CGHS (R16)
  id               UUID PK
  payer_name       TEXT NOT NULL          -- the payer of the bills it clears
  received_on      DATE NOT NULL          -- date the money reached the bank
  reference        TEXT NOT NULL          -- UTR / transaction reference
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0)
  note             TEXT
  voided_at, voided_by, void_reason       -- "undo clear", admin only
  cleared_by, cleared_at
  -- amount must equal the sum of the claim amounts of the bills it clears:
  -- CGHS always pays the full amount (Q29), so there is no deduction

claim_settlement_bills
  settlement_id    UUID NOT NULL REFERENCES claim_settlements
  bill_id          UUID NOT NULL REFERENCES bills
  amount           NUMERIC(12,2) NOT NULL
  -- a bill is in at most one non-voided settlement

billing_audit
  id, entity, entity_id, action, before JSONB, after JSONB, actor_id, at, ip
```

**How the existing lab order money fits in.** A lab/machine/ECHO/X-ray order
still has `amount_total / amount_paid / amount_claimed`. They become **derived
from the Scribe bill lines** that reference the order (`bill_lines.lab_order_id`).
The lab gate (`opensLabGate`) and `derivePaymentStatus` keep working unchanged.
A Scribe bill payment writes through to the order's `amount_paid` (and
`amount_claimed` for claim lines), so the existing gate sees it with no change
to the gate code. Reception's existing collect-on-the-order path ("Clear
payment") stays untouched until the hospital asks to remove it (Q23). If both
paths are used for the same order, the existing `amounts_within_total` check
and version lock stop it from being collected twice.

The unique index is the database's own guard against a duplicate. The service
also checks first, so the desk gets a clear message instead of an error (§7).

---

## 6. Pricing: the fixed order of steps

One function, `server/services/billing/priceLine.js`, is the only place a line
is priced. The same function is used for the preview and for the saved bill.

Every line keeps **two separate amounts**: the **actual amount** (what the
service costs) and the **patient payable** (what the counter collects). Whatever
lies between them is either **claimed** from the payer or written off as a
**category adjustment**.

For each line:

1. **Base rate** = `service_items.base_price`.
2. **Category rate.** Look up `category_item_rates` for the patient's
   sub-category, then its parent category, valid on the bill date. If a row is
   found, use its `rate` (when set), `bill_name` and `bill_code`.
3. **Actual amount** = quantity × rate.
4. **Discounts on full-pay lines** (only two kinds, D10). This applies to lines
   where no payment rule sets the patient's amount (General patients, or items
   the category doesn't cover):
   1. **Automatic** rules that match (age, category, group, consultant, dates).
   2. **Code** rules the desk entered (`CC50`). Codes are checked for validity,
      date, usage limits and whether this role may use them.

   Lines under a payment rule get their discount in step 8 instead.

   How rules combine is the admin's setting `billing_settings.discount_stacking`:
   - `best_only`: **only the single largest discount applies** to a line. Ties
     go to the lower `priority` number.
   - `per_rule`: rules marked `stackable` are added one after another, each on
     the amount left after the previous one. The largest non-stackable rule is
     applied first.

   The total discount is never more than the actual amount.

5. **Tax.** If GST is switched on and the item has a non-zero tax code, apply
   it:
   - taxable = actual − discount (or back-calculated when `price_includes_tax`);
   - always CGST + SGST, half each; no IGST (Q9).
   - While switched off, or when the item has no tax code, the line is saved
     with **no tax code**, a 0% rate and 0 tax (decided in the P1-05 review:
     no exempt code is seeded or hardcoded; an admin may still create 0% codes).
     With GST on, tax is worked out on the line's net actual amount. The same
     payment rule then decides who pays the tax-inclusive total.
6. **Patient payable.** Find the most specific **category payment rule**
   (§5.3a) for this line: item, then subgroup, then group, then the whole
   category, for the visit's type, valid on the bill date. Sub-category rules come before
   the parent category's.
   - `full`: patient pays the whole net amount. This is also the result when no
     rule matches (General).
   - `amount`: patient pays the rupee amount the **admin entered on the rule**
     (e.g. ₹700 in the example below; any value, changeable at any time),
     **whatever the actual amount is**. An `amount` rule only covers the items
     the admin chose for it (e.g. the consultation items), and other services
     get their own rules (Q19, decided 2026-09-17).
     - When saving an `amount` rule, the admin screen **refuses** it if any item
       it covers costs less than the amount, and lists those items.
     - Lowering an item's price below an existing rule's amount is refused the
       same way.
     - As a last safety net only, if it still happens, the patient pays the
       actual amount and nothing is claimed.
   - `percent`: patient pays that % of the net amount.
   - `nothing`: patient pays ₹0.
7. **The rest** = net − patient payable. The rule's `remainder` says where it
   goes:
   - `claim`: onto a claim to the category's payer (§8.3).
   - `adjustment`: written off by the hospital as a category adjustment.
8. **Discounts on payment-rule lines.** A discount rule applies here only if it
   has `applies_on_scheme_rate` switched on. It reduces the **patient payable**
   (never below ₹0), and the claim is unchanged. The same stacking setting
   applies.
9. **Round.** All arithmetic is in paise. The bill total is rounded to the
   nearest rupee, and the difference is recorded in `round_off`.

The invariant checked on every line:
**actual − discount + tax = patient payable + claim + adjustment**.

**Worked example: the CGHS rules given on 2026-09-17.** Every figure below
(₹1,500, ₹1,000, ₹700) is **an example the admin would enter**. None of them is
in code, and the admin can change any of them at any time. The rest is
**claimed from CGHS** (Q20, decided 2026-09-17), which is the default for every
payment rule.

Admin setup:

| Sub-category (under CGHS) | Payment rule (consultation items only)    | Needs referral |
| ------------------------- | ----------------------------------------- | -------------- |
| CGHS › CGHS Paid          | `amount` ₹700, for visit types New and FU | no             |
| CGHS › CGHS Referral      | `nothing`                                 | **yes**        |
| CGHS › Pensioner          | `nothing`                                 | no             |

Consultant items: "Consultation (New)" ₹1,500 and "Consultation (Follow Up)"
₹1,000 (General fee). For Pensioner and CGHS Referral, each doctor's
consultation has its own category fee (§5.1): ₹350 for Dr Rahul and Dr Beant,
₹700 for Dr Banshali. The rules above cover **only these consultation items**. A dressing, a
lab test or an X-ray for the same patient follows its own rule, or the patient
pays in full if the admin has made none.

| Patient                             | Line                     | Actual | Patient pays | Rest (claimed from CGHS)                        |
| ----------------------------------- | ------------------------ | ------ | ------------ | ----------------------------------------------- |
| CGHS Paid, 1st visit                | Consultation (New)       | 1,500  | **700**      | 800                                             |
| CGHS Paid, 2nd visit                | Consultation (Follow Up) | 1,000  | **700**      | 300                                             |
| CGHS Referral, Dr Rahul or Dr Beant | Consultation             | 350    | **0**        | 350 — bill printed, **Pending** until CGHS pays |
| CGHS Referral, Dr Banshali          | Consultation             | 700    | **0**        | 700 — bill printed, **Pending** until CGHS pays |
| Pensioner, Dr Rahul or Dr Beant     | Consultation             | 350    | **0**        | 350 — bill printed, **Pending** until CGHS pays |
| Pensioner, Dr Banshali              | Consultation             | 700    | **0**        | 700 — bill printed, **Pending** until CGHS pays |
| CGHS Referral, any later visit      | any                      | fee    | **0**        | fee: no limit on visits, no expiry              |

The same mechanism works for Lab, Machine, ECHO and X-ray. The admin adds a
payment rule for that group (e.g. CGHS Paid › group LAB › `percent` 20), or for
one item. The item-level rule wins over the group-level one. Where a category has no rule for a group, the patient pays in full.

**Discount example (made-up rule):** the admin has set up an age rule "10% off
OPD, age 70+" with `applies_on_scheme_rate` off, and stacking set to
`best_only`. A General patient, age 72, sees Dr Banshali for a Follow Up, and
the desk also enters `CC50`:

| Line                               | Base | Rate | Discount                   | Net | Patient |
| ---------------------------------- | ---- | ---- | -------------------------- | --- | ------- |
| Consultant meet — Dr Banshali (FU) | 1000 | 1000 | CC50 −500 (beats age −100) | 500 | 500     |
| HbA1c                              | 250  | 250  | —                          | 250 | 250     |

---

## 7. How a bill is built from the visit

The desk does not choose items from a blank list. The bill starts filled in
from what the visit already contains:

| Source                               | Line added                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appointment: consultant + visit type | The consultation item for that doctor and visit type (or the hospital default). New and Follow Up only: an Investigation visit has no consultation line |
| Lab orders                           | One line **per ordered test**, each its own item (HbA1c, Lipid Profile, …)                                                                              |
| Machine orders                       | One line per test: ABI, VPT, Fundus, ECG, TMT                                                                                                           |
| ECHO / X-ray orders                  | One line per study: 2D Echo, Chest X-ray PA, …                                                                                                          |
| Pharmacy (Phase 6)                   | Medicine items from the dispense                                                                                                                        |

**Visit type on the appointment → billing visit type (decided 2026-09-18, P1-06
review).** Appointments carry HealthRay's spellings (`New Patient`,
`Follow-Up`, `OPD`, `Tele`, `Investigation`) and reception's (`New`,
`Follow-up`); billing uses `New` / `Follow Up`. One shared function in
`shared/` converts them: **Investigation → no consultation fee**; a type that
`isNewVisitType` (`shared/patientLists.js`) calls new → **New**; everything
else, including **Tele** and **OPD** → **Follow Up**.
| Desk adds manually | Any **active** service item from the master, by search. Never free text |

- The draft bill is created at check-in, holding the consultation line. If
  the visit has no consultant yet (a walk-in, or a lab-only patient), the draft
  starts empty and the desk adds items by search.
- Test lines from orders are added when the order is raised. That includes the
  orders plan 51 raises from the HealthRay bill; those are just orders to this
  plan (§12).
- **A visit can have several bills (D12).** Tests ordered later by an MO or
  doctor go onto the open draft if there is one, or onto a new bill if the
  earlier bills are already final.
- **Never twice (Q17, decided 2026-09-17).** Before a line is added, the
  service checks every live line on every bill of the same visit (drafts
  included). If the same service item is already there, it is **not added
  again** and the desk sees "already billed on bill GAC/…". For a test order,
  the check is per test on the order. There is no per-item setting that allows
  repeats. The only ways an item can appear again are:
  - **An admin approves it for this one case.** The desk presses "Ask admin to
    bill again" and must give a reason. That creates a `repeat_item` request
    (§10). Once an admin approves it, the desk can add that item once, and the
    line records the request id. The request is then marked `used`, so one
    approval allows exactly one extra line.
  - **The earlier line was cancelled.** Cancelling frees the item to be billed
    again.

  The check runs inside the transaction, with the visit's bills locked, so two
  desks billing at the same moment can't both add it.

- **Quantity** can only be changed on items with `allow_quantity = TRUE`, up to
  `max_quantity`.
- Removing a line from a **draft** needs a reason. A final bill with **no
  payment** on it can be cancelled with a reason. Anything that means giving
  money back (cancelling a paid bill, credit notes, refunds) is **on hold**
  until the refund method is decided (Q14).
- **Claim status (R16).** When a bill with a claim amount is finalised, its
  `claim_status` becomes `pending` and it appears in the CGHS pending register
  (§8.3). A ₹0-payable bill (Pensioner, CGHS Referral) takes no payment: the
  desk finalises it and prints it, and that printout is all the patient gets.
  Cancelling a pending bill removes it from the register; a cleared bill can't
  be cancelled.
- Nothing on the bill has a price box.
- **Test gate (Q23).** Paying a test line's **patient payable** on the Scribe
  bill opens the gate for that test (lab, machine, ECHO, X-ray). A line with
  patient payable ₹0 (e.g. CGHS Referral) opens it as soon as the bill is
  finalised.
  - **The existing "Clear payment"** on reception's payment queue
    (`receptionStation.clearPayment`, `getPaymentQueue`) is **left exactly as it
    is** and keeps opening the gate too.
  - A test is cleared when **either** path says so. This plan changes nothing
    in that screen or its code.
  - Removing the old button is a later, separate change, made only when the
    hospital asks for it.

---

## 8. Screens

### 8.1 Admin (admin / reception_admin)

All under `/settings/billing/*`, using the existing `SettingsLayout.jsx` shell.

Every list below has **add, edit, delete and deactivate** (delete follows D9).

1. **Service groups & subgroups:** list, add, rename, delete, deactivate,
   reorder.
2. **Service items:** search, filter by group/subgroup/kind/active. Edit base
   price (the reason is saved to the price history), tax code, quantity rules,
   and the consultant or test link. Shows every category rate for the item.
3. **Categories and sub-categories:** the existing `/settings/schemes` page,
   extended with:
   - sub-categories (CGHS › …);
   - payer name, "needs referral", "needs referral scan";
   - "print on bill" and the pay-later override;
   - the **category rules** that decide who belongs (age range, gender, has a
     card, suggest or auto, priority);
   - the **payment rules** that decide what the patient pays: a grid of group /
     subgroup / item × visit type → full / amount ₹ / % / nothing, and claim or
     adjustment. A preview shows, for a chosen item, actual amount → patient
     pays → rest.
     Payment rules are built in Phase 3; the rest of this screen in Phase 1.
     **Consultant fees (R14)** — a dedicated screen: rows are doctors (and visit
     types), columns are General and every category / sub-category. Each cell
     holds that doctor's fee in that category and what the patient pays
     (full / amount / % / nothing, claim or adjustment). Editing a cell writes
     the doctor's `category_item_rates` row and item-level payment rule. Filter
     by doctor or category; copy a column (e.g. Pensioner → CGHS Referral); a
     doctor with no consultation item is flagged "not priced".
4. **Category rates:** pick a category, get a grid of every item with base
   price, category rate, bill name and bill code. Edit inline. Supports future
   `valid_from`.
5. **Discount rules & codes:** list, add, edit, delete, deactivate, with a usage
   count. Each rule sets:
   - automatic or code, and % / flat / fixed price, with its value and cap;
   - what it covers: groups (OPD, Lab, Machine, ECHO, X-ray…), subgroups,
     items, consultants, visit types;
   - who it covers: categories, age range, gender;
   - dates, usage limits (total, per patient, per day, per doctor per day),
     priority, stackable, "also on scheme rates", and which roles may use the
     code;
   - today's usage against each limit, shown in the list.

   A "test this rule" box: pick patient age, category and items, and see the
   result.

6. **Billing settings:** discount stacking (`best_only` / `per_rule`), pay-later
   toggle (off by default), maximum codes per bill, printed bill footer. The hospital name, address and logo come from the existing Prescription settings.
7. **Tax codes and the GST switch** (with the hospital's GSTIN and state).
8. **Bill series:** one series; the admin sets the prefix per financial year.
9. **Bulk import** (§9).
10. **Desk requests inbox:** every pending request from the billing counter,
    newest first, with a count badge in the settings menu.
    - **New item request:** the admin opens the service item form pre-filled
      with the requested name, sets group, price and codes, and saves. That
      approves the request, and the desk can now add the item. Or the admin
      rejects it with a note.
    - **Repeat request:** the admin sees the patient, the visit, the earlier bill
      line and the reason, then approves or rejects it.
    - The desk sees the answer on its screen without refreshing, through the
      existing realtime bus.

### 8.2 Billing Counter (reception) — its own page (Q8)

A new page, **"Billing Counter"**, at `/giniflow/station/billing`, with its own
menu entry, the same as the other stations. The reception check-in screen gets
a **"Bill"** button on each patient that opens this page for that patient.

- **Patient header:** name, UHID, age, and a **category badge**.
  - The category is filled in from §5.2 (explicit, then auto rule), with any
    `suggest` rule shown as a one-tap suggestion.
  - The category **must be confirmed** before a bill can be finalised;
    "General" is a valid answer.
  - Card number is asked for when the category needs it. For a referral
    category, the referral number and (if required) a scan
    are asked for.
- **Previous bills of this visit** are listed above, so the desk can see what is
  already billed.
- **Lines:** the lines built in §7. Each shows bill name, bill code, quantity,
  **actual amount**, discount, the payment rule used, and **patient pays** as
  separate columns. Search to add another active item.
  - Items already billed on this visit are greyed out with "already billed" and
    an **"Ask admin to bill again"** button (reason required).
  - If the search finds nothing, a **"Request new item"** button sends the name
    and a reason to the admin (Q11). The desk can never type a price.
  - The desk's own pending and answered requests are listed in a small panel.
- **Discount code box:** the only discount input. The code is checked straight
  away and applied, or rejected with the reason (unknown, expired, not for this
  category, not for these items, limit reached). Automatic discounts are shown
  as already applied, with their name. There is no manual discount field.
- **Totals:** actual amount, discount, tax (hidden while GST is off),
  **patient payable**, claim amount, adjustment, round-off.
- **Payment:** one or more rows of mode + amount + reference. Finalise is only
  allowed when patient payments equal the patient payable. When that is ₹0,
  no payment row is needed: the desk presses **Finalise & print**, gives the
  patient the printout, and the bill goes to the CGHS pending register. A "pay later" option
  appears **only** when the admin has allowed it, globally or for this category.
  A pay-later bill stays on a "Dues" list at the counter until it is fully
  paid.
- **Actions:** Save draft · Finalise & print · Print receipt · Cancel an unpaid
  bill (reason). Refunds and credit notes are on hold (Q14).
- The bill and receipt are rendered as a PDF with the existing Puppeteer pipeline (`renderHtmlToPdf`), the same as prescriptions, using the prescription letterhead and logo. The bill shows bill codes and category
  when the category has `print_category_on_bill`.

### 8.3 CGHS pending register (admin / reception_admin only) — R16

A separate section, **not** on the Billing Counter, visible only to admin and
reception admin (`BILLING_CLAIMS`).

- **Pending tab:** every final, non-cancelled bill with `claim_status =
pending`: bill number, bill date, patient, UHID, sub-category (CGHS Paid /
  CGHS Referral / Pensioner), doctor, bill codes, referral number (masked),
  claim amount, days pending. Filters: date range, sub-category, doctor,
  payer. Totals at the top: count and amount pending.
- **Clear one bill:** "Mark cleared" on a row → date received, reference (UTR),
  note. The amount is the bill's claim amount (Q29: always full).
- **Clear many bills (Q28):** tick several rows (or "select all filtered") →
  "Clear selected" → date received, reference, and the amount received. The
  amount must equal the total of the selected bills; otherwise the screen
  shows the difference and refuses. One `claim_settlements` row is written for
  the payment, linked to every bill it clears.
- **Cleared tab:** cleared bills with date received, reference and who cleared
  them; search by reference to see everything one payment cleared.
- **Undo clear:** admin only, with a reason, for a wrong entry; the bills go
  back to Pending and the settlement is voided (audited).
- **Export:** Pending and Cleared lists to Excel, and a printable pending list
  (e.g. to send to CGHS).
- The bill itself (from the Billing Counter or here) shows **Pending** or
  **Cleared on <date>**.

### 8.4 Cash closing

At the end of a shift, the user sees expected cash, card and UPI totals from
their payments, enters counted cash, and the difference is recorded.
Reception_admin sees all shifts.

### 8.5 Dashboards (`/billing/reports`)

All read from `bill_lines` (saved group/subgroup), final bills only:

- **Revenue** by group → subgroup → item, by day / week / month.
- **Revenue by consultant** (consultation lines and tests they ordered).
- **Revenue by category and sub-category**, with four columns side by side:
  actual amount, collected from patients, to be claimed, adjusted (written
  off).
- **Collections by payment mode** (cash / card / UPI) and by user or shift.
- **Dues:** pay-later bills not yet fully paid (only when pay-later is on).
- **Discounts** by rule, code, method (auto / code), category, group, consultant,
  and the user who applied them. Discount as a % of the actual amount per group; this is the
  number that shows where discounts can be offered (R4).
- **CGHS receivables:** pending amount by sub-category and doctor, ageing
  (0–30 / 31–60 / 61–90 / 90+ days), and amount cleared per month.
- **Coupon usage:** uses per code per day and per doctor, against the limits.
- **Cancellations**, with reasons.
- **Desk requests:** new-item and repeat requests by user, approved vs
  rejected.
- Export to Excel with the existing `xlsx` library.

---

## 9. Bulk import from Excel

**Template:** a downloadable `.xlsx` with one sheet per table and a header row
of fixed column names, plus a "Read me" sheet.

| Sheet             | Key (used to update existing rows)           | Columns                                                                                                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Groups`          | `group_code`                                 | name, sort_order, active                                                                                                                                                                                                                                                                                           |
| `Subgroups`       | `subgroup_code`                              | group_code, name, sort_order, active                                                                                                                                                                                                                                                                               |
| `Items`           | `item_code`                                  | name, subgroup_code, base_price, unit, allow_quantity, max_quantity, tax_code, kind, doctor (name or id), visit_type, test_name, active                                                                                                                                                                            |
| `Categories`      | `category_code`                              | label, parent_code, payer_name, requires_ref, requires_referral, requires_referral_doc, print_on_bill, allow_pay_later, daily_cap, active                                                                                                                                                                          |
| `Category rules`  | `category_code` + `rule_name`                | min_age, max_age, gender, requires_card, mode (suggest/auto), priority, active                                                                                                                                                                                                                                     |
| `Category rates`  | `category_code` + `item_code` + `valid_from` | rate, bill_name, bill_code, valid_to                                                                                                                                                                                                                                                                               |
| `Payment rules`   | `category_code` + `rule_name`                | group_code / subgroup_code / item_code (one or none), visit_types, patient_pays (full/amount/percent/nothing), patient_value, remainder (claim/adjustment), valid_from, valid_to, priority, active                                                                                                                 |
| `Discounts`       | `rule_name` (+ `code` when method = code)    | method (auto/code), kind, value, max_discount, groups, subgroups, items, doctors, visit_types, categories, min_age, max_age, gender, valid_from, valid_to, max_uses_total, max_uses_per_patient, max_uses_per_day, max_uses_per_doctor_per_day, priority, stackable, applies_on_scheme_rate, allowed_roles, active |
| `Consultant fees` | `doctor` + `visit_type` + `category_code`    | fee, patient_pays (full/amount/percent/nothing), patient_value, remainder (claim/adjustment), bill_name, bill_code, valid_from, valid_to — a convenience sheet: each row is saved as the doctor's category rate plus an item-level payment rule; a blank `visit_type` means every visit type for that doctor       |

**Fixed value lists in the template** (drop-downs): `visit_type` = New /
Follow Up / Investigation (consultation fees: New / Follow Up only); `gender` = Male / Female / Other (as patients are
stored); `kind`, `patient_pays`, `remainder`, `method`, `mode` as above; every
yes/no column = yes / no. Multi-value columns (`visit_types`, `groups`,
`doctors`, …) are comma-separated text.

**Flow:**

1. Upload. The server parses the file with `xlsx`.
2. **Check without saving.** Each row gets a status: new / update / unchanged /
   error. Errors include an unknown group code, a negative price, a duplicate
   key, an unknown doctor, or a discount code that equals a bill code.
3. The admin sees a preview with counts and the error rows. The error list can
   be downloaded as Excel.
4. Import is allowed only when there are no errors. Everything is saved in
   **one transaction**, so a file is either fully imported or not at all.
5. `billing_imports` records the file name, who imported it, when, and the
   counts. Each changed row is written to `billing_audit`. Price changes also
   go to `service_item_price_history`.
6. An import only **adds and updates**; it never deletes. To retire a row, set
   `active = no` in the sheet, or delete it from the admin screen (D9).

A new insurer or CGHS rate card is therefore: add a `Categories` row, its
`Payment rules` rows and (if its prices or bill codes differ) its
`Category rates` rows, then upload. The same save-time checks as the screens
apply, e.g. an `amount` above an item's price is an error row.

---

## 10. Roles and permissions (`shared/permissions.js`, both sides)

New role **`reception_admin`**, following the existing `lab_admin` pattern. **No
accounts role for now** (Q7): claims and reports sit with admin and
reception_admin.

| Capability         | What it allows                                                                                                                                                            | admin | reception_admin | reception |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------- | --------- |
| `BILLING_DESK`     | Billing Counter: create/finalise bills, take payments, enter discount codes, cancel an unpaid bill, send new-item and repeat requests                                     | ✓     | ✓               | ✓         |
| `BILLING_MASTER`   | Create/edit/delete groups, items, prices, categories, category rules, rates and payment rules, discount rules and codes; bulk import; **approve or reject desk requests** | ✓     | ✓               |           |
| `BILLING_SETTINGS` | Stacking mode, pay-later toggle, GST switch and GSTIN, tax codes, bill series                                                                                             | ✓     |                 |           |
| `BILLING_CLAIMS`   | CGHS pending register: view, clear one or many bills, export (undo clear: admin only)                                                                                     | ✓     | ✓               |           |
| `BILLING_REPORTS`  | Dashboards and exports                                                                                                                                                    | ✓     | ✓               |           |

**Only these three roles for now** (Q18, decided 2026-09-17). The coordinator
and other roles get no billing access; access can be widened later.
Refund and credit-note permissions will be added when refunds are designed
(Q14).

**Where the endpoints live (decided 2026-09-18):** every billing endpoint is
under `/api/billing`, which is staff-only (a patient-app login is refused) and
gated in `server/middleware/auth.js`:

| Path                               | Needs              |
| ---------------------------------- | ------------------ |
| `/api/billing/master`              | `BILLING_MASTER`   |
| `/api/billing/import`              | `BILLING_MASTER`   |
| `/api/billing/settings`            | `BILLING_SETTINGS` |
| `/api/billing/claims`              | `BILLING_CLAIMS`   |
| `/api/billing/reports`             | `BILLING_REPORTS`  |
| anything else under `/api/billing` | `BILLING_DESK`     |

The server lets any logged-in account reach an address missing from its
permission map, so no billing endpoint is ever added outside `/api/billing`.
Actions stricter than their path (approving desk requests, undo clear) also
check their permission on the route itself. Category create/update/delete
lives at `/api/billing/master/categories`; the existing
`/api/patient-schemes` write routes need `SCHEME_ADMIN` (admin only) and stay
as they are.

**R12 enforcement:**

- No endpoint used by the desk accepts `rate`, `price`, `bill_name`,
  `bill_code` or any discount amount. The Zod schemas in
  `server/schemas/index.js` reject them.
- A desk request carries only `service_item_id`, quantity and discount codes.
- Adding a service item or category needs `BILLING_MASTER`. The desk has no
  "add new item" action; it can only send a **request** from the Billing
  Counter, which an admin or reception_admin approves or rejects (Q11). A
  request carries a name and a reason, **never a price**. The price is set by
  the admin when creating the item.
- Every price change is logged, with who changed it and why.

---

## 11. GST-ready

- `tax_codes`, `service_items.tax_code_id`, the tax columns on `bill_lines` and
  `bills`, and a `billing_settings` row (`gst_enabled`, `gstin`, `state_code`,
  `legal_name`) exist from Phase 1.
- While `gst_enabled = FALSE`, every line is saved with no tax code, a 0% rate
  and 0 tax; an item with no tax code is treated the same way when GST is on.
  No exempt code is seeded or hardcoded. The bill layout hides tax columns.
- When switched on, only **new** bills are taxed. Old bills keep their saved
  values (D4).
- The hospital **has a GSTIN** (Q9). The admin enters it in billing settings,
  and it is printed on the bill once GST is switched on.
- **Always CGST + SGST** (half each). IGST is not supported (Q9).
- A GST summary report (by SAC/HSN and rate) is part of the Phase 5 reports and
  stays hidden until GST is on.
- Most healthcare services are exempt. Which items (if any) become taxable is a
  decision for the hospital's accountant, not for this plan.

---

## 12. HealthRay (D1, D2)

HealthRay billing **stays**, and **Scribe billing does not look at it** (Q16,
decided 2026-09-17).

1. **Scribe billing is independent.** It never reads, compares or copies
   HealthRay bills. Whatever is or isn't billed in HealthRay has no effect on a
   Scribe bill, and there is no comparison report or item-mapping table.
2. **Nothing is written to HealthRay.**
3. **Plan 51 is left as it is.** It is a separate feature: test steps on the
   floor still follow the HealthRay bill. This plan doesn't touch it.
4. Orders plan 51 raises from the HealthRay bill are ordinary orders to this
   plan. They get Scribe bill lines like any other order. The test gate opens on
   the Scribe bill payment or on today's "Clear payment", whichever comes first
   (Q23).
5. If the hospital later wants test steps to follow the Scribe bill instead,
   that is a separate plan. Nothing here blocks it.

---

## 13. Compliance and safety

- Card, beneficiary and referral numbers are encrypted with
  `server/utils/aadhaarCrypt.js`. Only the last 4 digits are shown in lists.
- Every billing table has RLS enabled and anon access revoked.
- Every create/update/delete/cancel is written to `billing_audit`, including
  master-data deletes (the deleted row is kept in `before`).
- Bill numbers are gap-free per series and year: taken inside the finalise
  transaction with `SELECT … FOR UPDATE` on `bill_series`.
- Double collection is prevented by the bill `version` lock, the same pattern
  as lab orders.
- Reports only show patient names to roles that already see patients.
- ⚠️ `DATABASE_URL` is production. Migrations are additive and idempotent. Seed
  data (groups, subgroups, tax codes) uses `ON CONFLICT DO NOTHING`. No backfill
  touches existing bills or orders without a dry-run script in `server/scripts/`
  first.

---

## 14. Phases

Each phase ships on its own and is checked before the next one starts. Phase T comes before Phase 1, and every task in every phase ends with its e2e test passing (§16).

| Phase  | Scope                                                                                                                                                                                                                                                                                                                                                                                              | Check                                                                                                                                                                                                                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0**  | The admin team prepares its data in the Excel template: price list, categories and sub-categories, category rules, payment rules (what each category's patient pays), CGHS/ECHS rate cards with bill codes, discount codes. Answer §15.                                                                                                                                                            | Template filled                                                                                                                                                                                                                                                                                                                                         |
| **T**  | Test setup (§16): local test database, schema build, production guard, test environment with outside services off, Playwright, reset and fixtures, helpers, scripts, how-to.                                                                                                                                                                                                                       | A fresh test database builds; the guard refuses production; an empty spec runs green; no outbound calls                                                                                                                                                                                                                                                 |
| **1**  | Master data with full create/edit/delete: groups, subgroups, tax codes, service items (link tests, consultation item per consultant), category extensions, category rules, category rates, `billing_settings`, `reception_admin` role + capabilities, admin screens 8.1 (1–4 without payment rules, 6–8; the desk requests inbox, 10, comes in Phase 4). Move test price reads to `service_items`. | `smoke:billing-master`; MO ordering and lab payment queue show the same prices as before; delete of a used row is refused                                                                                                                                                                                                                               |
| **2**  | Bulk Excel import (§9) with template download, check, preview, all-or-nothing save.                                                                                                                                                                                                                                                                                                                | `smoke:billing-import` with a good and a bad file                                                                                                                                                                                                                                                                                                       |
| **3**  | Category payment rules (§5.3a), discount rules (auto + code), category resolution, `priceLine` engine, preview endpoint, admin screens for payment rules and discounts, "test this rule".                                                                                                                                                                                                          | `smoke:billing-pricing`: the CGHS table in §6 (₹1,500→₹700, ₹1,000→₹700, referral ₹0 on every visit, pensioner ₹0, referral number required when the category asks for it), `amount` above an item's price refused at save, rule specificity, age boundaries, both stacking modes, scheme-rate switch, caps, invalid/expired codes, category rule order |
| **4**  | Bills, lines, several bills per visit with the never-twice check, desk requests (new item + repeat) and the admin inbox, payments (cash/card/UPI, split), actual vs patient payable vs claim vs adjustment on every line, referral capture, pay-later toggle, one bill series, finalise, PDF bill + receipt, Billing Counter page 8.2, cancel unpaid bill, cash closing, audit.                    | `smoke:billing-bill`: finalise twice, pay twice, same item on a second bill (refused), repeat after approval (allowed once), new-item request → item created, ₹0-payable bill finalises without payment, line invariant holds, pay later off/on, cancel unpaid                                                                                          |
| **4b** | Refunds and credit notes — **on hold** until the refund method is decided (Q14).                                                                                                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                       |
| **5**  | Cashless/receivables: payer claims 8.3. Dashboards 8.5.                                                                                                                                                                                                                                                                                                                                            | Reports match the sum of final bills                                                                                                                                                                                                                                                                                                                    |
| **6**  | Pharmacy billing: `medicine_catalog` becomes medicine service items (group Pharmacy), batch/stock if needed.                                                                                                                                                                                                                                                                                       | Separate plan                                                                                                                                                                                                                                                                                                                                           |
| **7**  | GST switched on, if and when the hospital decides.                                                                                                                                                                                                                                                                                                                                                 | GST summary report                                                                                                                                                                                                                                                                                                                                      |

---

## 15. Open questions

Answered on 2026-09-17 (see §1): Q1 (not replacing HealthRay), Q2 (sub-categories
dynamic), Q4 (category membership admin-defined), Q5 (discount scope and
stacking admin-defined), Q6 (several bills, no duplicates), Q10 (pay later off,
admin toggle), Q13 (no manual discounts), Q15 (the category on the record wins),
Q16 (Scribe billing ignores HealthRay billing).

Answered on 2026-09-17, second round:

| #   | Answer                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q3  | **Yes**, and more: category payment rules (amount ₹, %, nothing, full) are needed from day one (§5.3a).                                                                                                                                                        |
| Q7  | **No accounts role** for now.                                                                                                                                                                                                                                  |
| Q8  | **Its own page**, "Billing Counter".                                                                                                                                                                                                                           |
| Q9  | **The hospital has a GSTIN. No IGST**; always CGST + SGST.                                                                                                                                                                                                     |
| Q11 | **Yes.** The desk sends new-item requests to the admin from the screen.                                                                                                                                                                                        |
| Q12 | **One series** for all bills.                                                                                                                                                                                                                                  |
| Q17 | **Never twice.** A repeat happens only when an admin approves that specific case; there is no per-item repeat setting.                                                                                                                                         |
| Q18 | **Reception, reception_admin and admin only** for now; widen later if needed.                                                                                                                                                                                  |
| Q20 | **Claimed from CGHS.** The rest (₹800 / ₹300, and the full amount for Referral and Pensioner) is a CGHS claim. `claim` is the default remainder.                                                                                                               |
| Q21 | **Visit type**: 1st visit = New, 2nd visit = Follow Up.                                                                                                                                                                                                        |
| Q22 | **Every visit is covered.** Referral patients are always billed and never charged at the counter; CGHS is claimed each time. No visit count or expiry.                                                                                                         |
| Q19 | **Rules are per service.** The CGHS Paid amount is for the consultation only; dressing and other services get their own rules. The admin screen refuses a rule whose amount is higher than the price of an item it covers.                                     |
| Q23 | **Yes**, paying the Scribe bill opens the test gate. **But today's "Clear payment" on reception's payment queue is not touched**: it stays and keeps working. It is removed only when the hospital says so.                                                    |
| Q24 | **No test packages.** Every test is always billed on its own line at its own price.                                                                                                                                                                            |
| Q25 | **Pensioner and CGHS Referral are sub-categories of CGHS**, together with CGHS Paid; not separate categories.                                                                                                                                                  |
| Q26 | **Consultant fees and coupons per doctor** are admin-managed: a fee and patient-pays per doctor per category, and coupons tied to doctors with total, per-patient, per-day and per-doctor-per-day limits.                                                      |
| Q27 | **Pensioner / CGHS Referral:** bill created (₹350 Dr Rahul and Dr Beant, ₹700 Dr Banshali in today's figures), printout only, **Pending** until CGHS pays into the bank, then **Cleared**. Shown in a **separate section** for admin and reception admin only. |
| Q28 | **CGHS pays both ways**: sometimes one payment per bill, sometimes one payment for many bills. Both are supported.                                                                                                                                             |
| Q29 | **CGHS always pays the full amount.** No deductions.                                                                                                                                                                                                           |
| Q30 | **Investigation visits have no consultation fee.** Consultation items and consultant fees exist only for New and Follow Up; an Investigation visit's bill has no consultation line.                                                                            |

Still open:

| #   | Question                                                                                                                            | Why it matters       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Q14 | **On hold.** How refunds work (same mode as payment, cash only, or chosen each time). Until decided, paid bills can't be cancelled. | Phase 4b, `payments` |

---

## 16. Testing: end-to-end tests for every task (decided 2026-09-17)

**Rule.** No task is done until its e2e test is written, run and passing, and
the whole billing suite still passes. If a test fails, the code (or a wrong
test) is fixed and the test is run again until it passes. Failing, skipped or
commented-out tests are never accepted. The full loop is in the task list
("Definition of done").

**Why a separate database.** `.env` points at production, and there is no
staging database. E2E tests create bills, patients and payments, so they must
never run against it. Tests use their own database:

- the local Postgres in `docker-compose.yml` (now Postgres 17, matching
  production; port 5435), database `gini_scribe_test`;
- built from a structure-only copy of production's `public` schema
  (`e2e/setup/schema-baseline.sql`, no rows), then every repo migration except
  a short skip list of old ones that can't be replayed. `schema.sql` plus the
  migrations can't build a database on their own: several core tables were
  created directly in Supabase;
- reset before every run, with **test-only** fixtures (one user per role, test
  patients including General, 72-year-old, CGHS Paid, CGHS Referral and
  Pensioner, two consultants, a few catalogue tests). Production is still
  never seeded (D8);
- a **guard** stops the run if `DATABASE_URL` is anything other than that
  local test database;
- all outside services (HealthRay, lab API, Genie, Google Sheets, MSG91,
  Anthropic, Deepgram) are switched off in the test environment, and the setup
  test fails if any outbound call is made.

**Tool.** Playwright (`@playwright/test`, a new dev dependency), using the
installed Google Chrome. Its own API runs on port 3101 and Vite on 3100. It starts the
API and Vite itself, drives real browser pages for screen tasks, and calls the
API directly for server tasks. Screenshots and traces are kept on failure.

**Layout.**

```
e2e/
  playwright.config.js
  .env.e2e                  test environment, no secrets
  README.md                 how to run
  setup/                    guard, schema build, reset, fixtures, setup specs
  helpers/                  loginAs, apiAs, db, money, builders
  fixtures/                 test-only users, patients, consultants, tests
  billing/phase0 … phase7/  one spec file per task, named <task-id>-<title>.spec.js
```

**Scripts.** `npm run test:e2e` (all, or one file), `npm run test:e2e:billing`
(the billing suite), `npm run test:e2e:setup` (rebuild and reset the test
database).

**Relationship with smoke scripts.** Smoke scripts stay as quick database-level
checks. The e2e suite covers the same scenarios end to end through the API and
the screens.
