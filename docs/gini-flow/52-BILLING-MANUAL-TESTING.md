# 52 — Billing: manual testing guide

How to test by hand everything built so far for billing: Phase T (test setup),
Phase 1 (master data, categories, rates, settings, permissions) and Phase 2 tasks
P2-01 and P2-02.

Every step is a tick-box. Where you have to type something, a small table gives
the **exact value to type in each box**, and **Expect** says what you should see.
The example data carries through the guide — what you create in one section is
used by the next — so go through the sections in order.

Plan: `52-BILLING-PLAN.md` · Tasks: `52-BILLING-TASKS.md`

> ⚠️ **Never test with `npm run dev`.** It uses `.env`, which points at the
> **production** database — anything you create while testing would land in live
> data. Always use the local test copy in section 0. It runs on ports 3100 / 3101
> with every production setting switched off, so it can't touch live data or call
> HealthRay.

**Contents**

0. Setup, logins and PINs
1. Roles and permissions — P1-01, P1-02, P1-03, P1-28, P1-38
2. Categories — P1-08, P1-19, P1-20, P1-21, P1-31
3. Services — P1-04 – P1-07, P1-15, P1-16, P1-17, P1-29
4. Not priced — P1-18, P1-30
5. Category rates — P1-09, P1-12, P1-22, P1-32
6. Billing settings — P1-11, P1-23, P1-27, P1-33
7. Test catalogue — P1-24, P1-34
8. Floor prices — P1-24, P1-36
9. Scripts and the database — P1-13, P1-14, P1-35, P1-36, P2-01, P2-02
10. Automated tests — Phase T, the whole suite
11. Not testable yet

**Rules for codes you type**

- Category codes: **lower case** letters, digits and `_` only, 2–32 characters
  (e.g. `demo_cghs`).
- All other codes (groups, subgroups, items, tax codes, bill codes): no spaces, at
  most 40 characters (e.g. `LAB-HBA1C`).
- Prices: plain numbers — `1500` or `175.50`, never `₹1,500`.
- Dates: `YYYY-MM-DD` — e.g. `2026-09-22`. Where the guide says _tomorrow_, type
  tomorrow's date in that form.

---

## 0. Setup, logins and PINs

Needs Docker running.

```bash
cd /home/anshul/Desktop/Ankit/Gurjot/gini-scribe
npm run test:e2e:setup              # builds the test database and loads test data
```

- [ ] **Expect:** `Test database rebuilt from … files and reset with fixtures`.

Start the test API and app in two terminals:

```bash
node e2e/setup/startApi.mjs         # terminal 1 → API  http://localhost:3101
node e2e/setup/startWeb.mjs         # terminal 2 → app  http://localhost:3100
```

- [ ] Open **http://localhost:3100** — the login screen appears.

The API starts with every `.env` setting blanked and outside calls blocked, so
HealthRay sync, WhatsApp, Genie etc. are off.

**Test logins — roles and PINs**

On the login screen pick the name from the list (grouped by role), then type the
PIN.

| Login name          | User id | Role            | PIN    | Billing — what it may do                                                                           |
| ------------------- | ------- | --------------- | ------ | -------------------------------------------------------------------------------------------------- |
| E2E Admin           | 9001    | admin           | `4321` | Everything: all Settings tabs, all billing APIs, the patients-per-day limit, Billing settings      |
| E2E Reception Admin | 9002    | reception_admin | `4321` | Categories, Services, Category rates; **not** Billing settings, **not** the patients-per-day limit |
| E2E Reception       | 9003    | reception       | `4321` | No Settings tab; billing admin pages and APIs refused (the future Billing desk only)               |
| E2E Coordinator     | 9004    | coordinator     | `4321` | No Settings tab; every billing page and API refused                                                |
| E2E Lab             | 9005    | lab             | `4321` | No Settings tab; every billing page and API refused                                                |
| Dr E2E Banshali     | 9101    | consultant      | `4321` | No billing access; used as a consultant for fees (Endocrinology)                                   |
| Dr E2E Rahul        | 9102    | consultant      | `4321` | No billing access; used as a consultant for fees (Diabetology)                                     |
| Dr E2E Beant        | 9103    | consultant      | `4321` | No billing access; used as a consultant for fees (Internal Medicine)                               |

These users exist only in the local test database (`e2e/fixtures/data.mjs`) —
they are not production accounts.

**Test data you start with:** patients General adult, Senior 72, CGHS Paid, CGHS
Referral, Pensioner · catalogue tests HbA1c, Lipid Profile, Fasting Blood Sugar
(lab), ABI, VPT (machine) · categories CGHS, ECHS, Himachal Government, Senior
Citizen, Special Discount.

**Start clean again:** stop both terminals and run `npm run test:e2e:setup` again.

**Look inside the test database:**

```bash
docker exec -it gini_scribe_db psql -U user -d gini_scribe_test
```

---

## 1. Roles and permissions

Tasks: P1-01 (reception_admin role), P1-02 (billing capabilities), P1-03 (API
gate), P1-28 (billing tabs in Settings), P1-38 (permission check).

| Role (login)                          | Settings tab | Billing pages                                          | Billing APIs                |
| ------------------------------------- | ------------ | ------------------------------------------------------ | --------------------------- |
| admin (E2E Admin)                     | yes          | Categories, Services, Category rates, Billing settings | all                         |
| reception_admin (E2E Reception Admin) | yes          | Categories, Services, Category rates                   | all except billing settings |
| reception (E2E Reception)             | no           | none                                                   | none of master / settings   |
| coordinator (E2E Coordinator)         | no           | none                                                   | none                        |
| lab, consultant (E2E Lab, Dr E2E …)   | no           | none                                                   | none                        |

**1.1 Login screen**

- [ ] Open the user list on the login screen.
- **Expect:** a **"Reception Admin"** group containing _E2E Reception Admin_.

**1.2 Admin sees every tab**

- [ ] Log in as **E2E Admin**, PIN `4321`, then click **⚙️ Settings**.
- **Expect:** tabs Patient Flow, Prescription, Test catalogue, **Categories,
  Services, Category rates, Billing settings**.

**1.3 Reception Admin sees only its tabs**

- [ ] Log out, log in as **E2E Reception Admin**, PIN `4321`, click **⚙️ Settings**.
- **Expect:** it opens on **Categories**; only Categories, Services and Category
  rates are shown.

**1.4 Reception Admin is sent away from admin pages**

- [ ] Still as Reception Admin, type each address in the browser bar and press
      Enter:

  | Type in the address bar                  |
  | ---------------------------------------- |
  | `http://localhost:3100/settings/billing` |
  | `http://localhost:3100/settings/flow`    |
  | `http://localhost:3100/settings/tests`   |

- **Expect:** each time you land back on the home page with "You don't have
  access".

**1.5 Reception, Coordinator and Lab are locked out**

- [ ] Log in as **E2E Reception**, PIN `4321`. Then type each address:

  | Type in the address bar                         |
  | ----------------------------------------------- |
  | `http://localhost:3100/settings/services`       |
  | `http://localhost:3100/settings/schemes`        |
  | `http://localhost:3100/settings/category-rates` |
  | `http://localhost:3100/settings/billing`        |

- **Expect:** no ⚙️ Settings tab at all; every address sends you back home.
- [ ] Repeat with **E2E Coordinator** and **E2E Lab** (PIN `4321`).

**1.6 Optional — check the API directly**

- [ ] While logged in, open DevTools (F12) → Application → Local Storage →
      `http://localhost:3100` → copy the value of `gini_auth_token`. Then in a
      terminal:

```bash
T="paste-the-token-here"
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $T" http://localhost:3101/api/billing/master/groups
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $T" http://localhost:3101/api/billing/settings
```

| Logged in as                | First line | Second line |
| --------------------------- | ---------- | ----------- |
| Reception, Coordinator, Lab | `403`      | `403`       |
| Reception Admin             | `200`      | `403`       |
| Admin                       | `200`      | `200`       |

---

## 2. Categories

Tasks: P1-08, P1-19 (categories and sub-categories), P1-20 (rules), P1-21
(resolver), P1-31 (Categories page) and its review fixes.

Log in as **E2E Reception Admin** (PIN `4321`) → **⚙️ Settings → Categories**.

**2.1 The tree**

- [ ] Look at the left side.
- **Expect:** CGHS, ECHS, Himachal Government, Senior Citizen, Special Discount;
  each has a small **"+ Sub-category"** button under it.

**2.2 Create a category**

- [ ] At the bottom, under **Add category**, type:

  | Box   | Type this   |
  | ----- | ----------- |
  | Code  | `demo_cghs` |
  | Label | `Demo CGHS` |

  and click **+ Add**.

- **Expect:** _Demo CGHS_ appears in the tree and its details open on the right.

**2.3 Add three sub-categories**

- [ ] Under **Demo CGHS** click **+ Sub-category**, type the first row, click
      **+ Add**; repeat for the other two:

  | Code        | Label           |
  | ----------- | --------------- |
  | `demo_paid` | `CGHS Paid`     |
  | `demo_ref`  | `CGHS Referral` |
  | `demo_pen`  | `Pensioner`     |

- **Expect:** all three appear indented under Demo CGHS; the sub-categories have
  **no** "+ Sub-category" button (only two levels are allowed).

**2.4 Fill in the details**

- [ ] Click **Demo CGHS** in the tree and set:

  | Box / tick                     | Set to                    |
  | ------------------------------ | ------------------------- |
  | Label                          | `Demo CGHS` (leave as is) |
  | Colour                         | `blue`                    |
  | Payer name                     | `Govt of India`           |
  | Pay later                      | `Don't allow pay later`   |
  | Card number required           | tick ✓                    |
  | Needs a referral               | tick ✓                    |
  | Needs the referral scanned     | leave empty               |
  | Print the category on the bill | tick ✓                    |

  then click **Save**.

- **Expect:** a "Saved" message; the Save button greys out.

**2.5 Sub-category shows the inherited payer**

- [ ] Click **Pensioner**.
- **Expect:** the Payer name box is empty with the grey hint _"Same as Demo CGHS:
  Govt of India"_.

**2.6 Only an admin can change the daily limit**

- [ ] Still as Reception Admin, click **Demo CGHS** and look at **Patients per
      day**.
- **Expect:** you can't type in it; the note says _"Only an admin can change the
  patients-per-day limit"_.
- [ ] Log in as **E2E Admin** (PIN `4321`) → Settings → Categories → **Demo
      CGHS**, type:

  | Box              | Type this |
  | ---------------- | --------- |
  | Patients per day | `30`      |

  then **Save**.

- **Expect:** saved; the tree shows `demo_cghs · 30/day`.
- [ ] Log back in as **E2E Reception Admin** for the rest of this section.

**2.7 Unsaved changes are not lost**

- [ ] Click **Demo CGHS**, type in Payer name:

  | Box        | Type this              |
  | ---------- | ---------------------- |
  | Payer name | `Govt of India (test)` |

  then, without saving, click **ECHS** in the tree.

- **Expect:** a box _"Discard your changes to Demo CGHS?"_. Click **Keep
  editing** → your text is still there. Click ECHS again → **Discard** → ECHS
  opens and Demo CGHS still has `Govt of India`.

**2.8 Add a "who belongs" rule**

- [ ] Click **Pensioner**. In **Who belongs** at the bottom type:

  | Box / tick     | Set to            |
  | -------------- | ----------------- |
  | Rule name      | `Retired 60+`     |
  | From age       | `60`              |
  | To age         | leave empty (any) |
  | Gender         | `Any`             |
  | How it applies | `Automatic`       |
  | Priority       | leave empty (100) |
  | Has a card     | tick ✓            |

  then click **+ Add rule**.

- **Expect:** a row _Retired 60+ · 60+ · Any · Yes · Automatic · 100_.

**What priority means:** when a patient matches more than one rule, the rule
with the **smaller** priority number is used first. Empty counts as `100`. Give
a special rule `5` to make it win over the ordinary ones.

**2.8b Only digits in ages and priority**

- [ ] In the add form type these, one at a time:

  | Box      | Type this | Box shows |
  | -------- | --------- | --------- |
  | From age | `6a0-`    | `60`      |
  | To age   | `7e0.`    | `70`      |
  | Priority | `1x0`     | `10`      |

- **Expect:** letters, dots and signs are never typed in; the ages take at most 3
  digits. Clear the three boxes afterwards.

**2.9 Edit, switch off and on**

- [ ] Click **Edit** on the rule, change:

  | Box      | Type this |
  | -------- | --------- |
  | Priority | `5`       |

  then **Save rule**.

- **Expect:** Priority shows 5.
- [ ] Click **Deactivate** (row greys out), then **Activate**.
- [ ] Click **Delete**, then **Cancel**.
- **Expect:** the row goes back to Edit / Deactivate / Delete and the rule is
  kept.

**2.10 A rule must have a condition**

- [ ] In the add form type only:

  | Box       | Type this  |
  | --------- | ---------- |
  | Rule name | `Everyone` |

  and click **+ Add rule**.

- **Expect:** red message _"A rule needs at least one condition (an age, a
  gender or a card)…"_; nothing is added.

**2.11 A parent category takes no rules**

- [ ] Click **Demo CGHS**.
- **Expect:** _"Demo CGHS has sub-categories, so a patient is billed under one of
  them. Put rules on a sub-category."_ and no add-rule form.

**2.12 Moving rules when the first sub-category is added**

- [ ] Under **Add category** type Code `demo_lone`, Label `Demo Lone` →
      **+ Add**.
- [ ] In its **Who belongs** add:

  | Box       | Set to   |
  | --------- | -------- |
  | Rule name | `Women`  |
  | Gender    | `Female` |

  → **+ Add rule**.

- [ ] Click **+ Sub-category** under Demo Lone, type Code `demo_lone_sub`, Label
      `Lone Sub` → **+ Add**.
- **Expect:** a message that Demo Lone has rules to move, and under Who belongs a
  **"Move to…"** list next to _Women_.
- [ ] Pick **Lone Sub** in "Move to…" → **Move**.
- **Expect:** the list disappears; click **Lone Sub** → the _Women_ rule is there.

**2.13 A category in use can't be deleted**

- [ ] Click **Demo CGHS** → **Delete** → **Confirm delete**.
- **Expect:** a box _"Demo CGHS can't be deleted"_ listing _"3 sub-categories
  under Demo CGHS"_.
- [ ] Click **Retire instead**.
- **Expect:** a red message inside the box: it still has active sub-categories.
  Click **Close**.

**2.14 Retire, bring back, delete**

- [ ] Click **CGHS Referral** → **Retire**.
- **Expect:** the tree shows `demo_ref · retired`.
- [ ] Click **Bring back** → "retired" disappears.
- [ ] Click **Delete** → **Confirm delete**.
- **Expect:** CGHS Referral is gone from the tree.

**2.15 The patient's Billing scheme drop-down**

This is the drop-down reception uses to put a patient on a scheme. It lives on
the patient page (`/patient`), not in Settings.

- [ ] Log in as **E2E Admin** (PIN `4321`) and press F5 once, so the app loads
      the categories you just created.
- [ ] Click **🔍 Find** at the top (or **Search Patient** on the home page).
- [ ] In the search box type:

  | Box    | Type this       |
  | ------ | --------------- |
  | Search | `E2E Pensioner` |

  and click the patient in the results.

- [ ] Click the **👤** icon in the top bar to open the patient page.
- [ ] Find the row of ID boxes — **ABHA ID**, **Health ID**, **Billing scheme** —
      and open the **Billing scheme** drop-down.
- **Expect:** `— General` first, then every active category; sub-categories are
  indented under their parent and read `Demo CGHS › CGHS Paid`, `Demo CGHS ›
Pensioner`. A retired category is not in the list.

---

## 3. Services (groups, subgroups, items)

Tasks: P1-04 – P1-07, P1-15 (groups/subgroups), P1-16 (tax codes), P1-17
(items), P1-29 (Services page) and its review fixes.

Log in as **E2E Reception Admin** (PIN `4321`) → **⚙️ Settings → Services**.

**3.1 Create three groups**

- [ ] Under **Add group** (bottom left) type each row and click **+ Add**:

  | Code   | Name         |
  | ------ | ------------ |
  | `LAB`  | `Lab`        |
  | `OPD`  | `OPD`        |
  | `PROC` | `Procedures` |

- **Expect:** all three groups appear on the left.

**3.2 Rename a group**

- [ ] Click **Rename** under _Lab_, type:

  | Box      | Type this    |
  | -------- | ------------ |
  | New name | `Laboratory` |

  → **Save**.

- **Expect:** the group now reads _Laboratory_.

**3.3 Create subgroups**

- [ ] Under each group's add row (the Code / Name boxes below the group) type and
      click **+ Add**:

  | Under group | Code          | Name            |
  | ----------- | ------------- | --------------- |
  | Laboratory  | `BIOCHEM`     | `Biochemistry`  |
  | Laboratory  | `HAEM`        | `Haematology`   |
  | OPD         | `OPD_CONSULT` | `Consultations` |
  | Procedures  | `DRESSING`    | `Dressings`     |

**3.4 Reorder**

- [ ] Click **↓** on _Biochemistry_.
- **Expect:** Haematology moves above Biochemistry; the arrows grey out for a
  moment while it saves.

**3.5 Add a test item**

- [ ] Click the subgroup **Biochemistry** (the "+ Add item" button becomes
      active), then **+ Add item** and fill in:

  | Box            | Type / choose |
  | -------------- | ------------- |
  | Name           | `HbA1c`       |
  | Code           | `LAB-HBA1C`   |
  | Subgroup       | Biochemistry  |
  | Kind           | `test`        |
  | Price (₹)      | `500`         |
  | Unit           | `each`        |
  | Catalogue test | `HbA1c`       |

  → **Add item**.

- **Expect:** the row _LAB-HBA1C · HbA1c · test · ₹500 · each · HbA1c_.

**3.6 Add a procedure with quantity**

- [ ] Click subgroup **Dressings** → **+ Add item**:

  | Box                         | Type / choose      |
  | --------------------------- | ------------------ |
  | Name                        | `Dressing - small` |
  | Code                        | `PROC-DRS-S`       |
  | Kind                        | `procedure`        |
  | Price (₹)                   | `150`              |
  | Unit                        | `each`             |
  | Quantity can be more than 1 | tick ✓             |
  | Max quantity                | `5`                |
  | Tax code                    | `No tax`           |

  → **Add item**.

- **Expect:** _PROC-DRS-S · Dressing - small · procedure · ₹150 · each · up to 5_.

**3.7 Add a consultation fee**

- [ ] Click subgroup **Consultations** → **+ Add item**:

  | Box        | Type / choose                       |
  | ---------- | ----------------------------------- |
  | Name       | `Consultation - Dr E2E Rahul (New)` |
  | Code       | `OPD-RAHUL-NEW`                     |
  | Kind       | `consultation`                      |
  | Price (₹)  | `900`                               |
  | Consultant | `Dr E2E Rahul`                      |
  | Visit type | `New`                               |

  → **Add item**.

- **Expect:** the row shows _Dr E2E Rahul · New_.

**3.8 A second New fee for the same doctor is refused**

- [ ] **+ Add item** again in Consultations:

  | Box        | Type / choose                |
  | ---------- | ---------------------------- |
  | Name       | `Consultation - Rahul again` |
  | Code       | `OPD-RAHUL-NEW2`             |
  | Kind       | `consultation`               |
  | Price (₹)  | `800`                        |
  | Consultant | `Dr E2E Rahul`               |
  | Visit type | `New`                        |

  → **Add item**.

- **Expect:** red message _"There is already an active New consultation item
  for this doctor: Consultation - Dr E2E Rahul (New) (OPD-RAHUL-NEW)"_. Click
  **Cancel**.

**3.9 The price box takes only an amount**

- [ ] **+ Add item** in Dressings, and type each value below into **Price (₹)**
      (clear the box between tries):

  | Type this      | Box shows |
  | -------------- | --------- |
  | `₹1,200`       | `1200`    |
  | `12.345`       | `12.34`   |
  | `-50`          | `50`      |
  | `1e fgjdfhk00` | `100`     |

- **Expect:** letters, `₹`, commas and minus signs never go in; only one dot
  and at most 2 digits after it. Then **Cancel** → **Discard**.

**3.10 A price change needs a reason**

- [ ] Click **Dressings** → **Edit** on _Dressing - small_ and change:

  | Box       | Type this |
  | --------- | --------- |
  | Price (₹) | `175.50`  |

- **Expect:** a new box **"Reason for the price change"** appears.
- [ ] Click **Save** with the reason empty.
- **Expect:** the form stays open with _"Give a reason for the price change"_.
- [ ] Type:

  | Box                         | Type this               |
  | --------------------------- | ----------------------- |
  | Reason for the price change | `Supplier rate went up` |

  → **Save**.

- **Expect:** the row shows **₹175.50**.

**3.11 Price history**

- [ ] Click **History** on _Dressing - small_.
- **Expect:** two rows — `₹150 → ₹175.50 · Supplier rate went up · E2E Reception
Admin` and `₹150 · Created`. Click **Close**.

**3.12 No reason without a price change**

- [ ] **Edit** _Dressing - small_ and change only:

  | Box  | Type this |
  | ---- | --------- |
  | Unit | `roll`    |

  → **Save**.

- **Expect:** no reason asked; the unit shows `roll`; History still has two rows.

**3.13 The form asks before throwing work away**

- [ ] **Edit** _Dressing - small_, type Unit `box`, then click the grey area
      outside the form (or press Escape).
- **Expect:** _"Discard your changes?"_ — **Keep editing** keeps `box`;
  **Discard** closes without saving.
- [ ] **Edit** again without changing anything and press Escape.
- **Expect:** the form just closes.

**3.14 Search and filters**

- [ ] Click **All items** (top left), then type in the search box:

  | Box                 | Type this   |
  | ------------------- | ----------- |
  | Search name or code | `LAB-HBA1C` |

- **Expect:** only HbA1c is listed.
- [ ] Clear the search; set the Kind filter to `consultation`.
- **Expect:** only the consultation item is listed.

**3.15 Switch off and protect — on a throw-away group**

Use a separate group so the items above stay for later sections.

- [ ] Create group Code `TEMP`, Name `Temporary`; under it subgroup Code
      `TMP_SUB`, Name `Temp sub`; click **Temp sub** → **+ Add item**: Name
      `Temp item`, Code `TMP-1`, Kind `other`, Price `10` → **Add item**.
- [ ] Click **Deactivate** on _Temp item_ → then **Activate**.
- **Expect:** the row greys out, then comes back.
- [ ] Click **Deactivate** under the _Temp sub_ subgroup (left side).
- **Expect:** refused — _"Temp sub still has 1 active item: Temp item.
  Deactivate it first."_
- [ ] **Delete** _Temp sub_ → **Confirm delete**.
- **Expect:** _"Temp sub can't be deleted"_ with _"1 item in Temp sub"_. Click
  **Close**.
- [ ] Delete _Temp item_ (Delete → Confirm delete), then _Temp sub_, then the
      _Temporary_ group.
- **Expect:** each disappears.

---

## 4. Not priced

Tasks: P1-18 (not-priced list), P1-30 (Not priced tab).

Log in as **E2E Reception Admin** → **Settings → Services** → click **Not priced
· N** (next to "Items").

**4.1 The three lists**

- **Expect:**
  - **Tests without an item** — Lipid Profile, Fasting Blood Sugar, ABI, VPT
    (HbA1c is gone — it got an item in 3.5), each with its catalogue price and
    **Create item**.
  - **Consultants without a fee** — Dr E2E Banshali and Dr E2E Beant for New and
    Follow Up, Dr E2E Rahul for Follow Up only.
  - **Lab reports not in the catalogue** — with "possibly the same as"; no
    buttons.

**4.2 Create a test item from the list**

- [ ] Click **Create item** on **Lipid Profile**.
- **Expect:** the form is already filled: Name `Lipid Profile`, Kind `test`,
  Catalogue test `Lipid Profile`, the catalogue price.
- [ ] Fill in the rest:

  | Box      | Type / choose  |
  | -------- | -------------- |
  | Code     | `LAB-LIPID`    |
  | Subgroup | `Biochemistry` |

  → **Add item**.

- **Expect:** Lipid Profile leaves the list and N goes down by one.

**4.3 Create a consultant fee from the list**

- [ ] Click **Create item** on **Dr E2E Banshali (New)**.
- **Expect:** Kind `consultation`, Consultant `Dr E2E Banshali`, Visit type `New`
  and a name are filled in.
- [ ] Fill in:

  | Box       | Type / choose      |
  | --------- | ------------------ |
  | Code      | `OPD-BANSHALI-NEW` |
  | Subgroup  | `Consultations`    |
  | Price (₹) | `1000`             |

  → **Add item**.

- **Expect:** that row leaves the list.

**4.4 A switched-off item offers "Activate"**

- [ ] Click **Items**, find _Lipid Profile_ (search `LAB-LIPID`) → **Deactivate**.
- [ ] Click **Not priced** again.
- **Expect:** Lipid Profile is back, but with **"Activate LAB-LIPID"** instead of
  Create item. Click it → the row disappears.

---

## 5. Category rates

Tasks: P1-09 / P1-12 (rates table), P1-22 (rates service), P1-32 (Category rates
page) and its review fixes.

Uses Demo CGHS (section 2) and _Consultation - Dr E2E Rahul (New)_ (section 3).

Log in as **E2E Reception Admin** → **Settings → Category rates**.

**5.1 Pick the category**

- [ ] In **Category** choose `Demo CGHS`.
- **Expect:** a grid of every active item; each Rate shows its base price with a
  **Base price** tag.

**5.2 Set the CGHS rate with bill code CC02**

- [ ] Click **Edit** on _Consultation - Dr E2E Rahul (New)_ and type:

  | Box       | Type this              |
  | --------- | ---------------------- |
  | Rate      | `800`                  |
  | Bill name | `CGHS Consultation`    |
  | Bill code | `CC02`                 |
  | From      | today (already filled) |
  | To        | leave empty            |

  → **Save**.

- **Expect:** **₹800 · Own**, Bill name _CGHS Consultation_, Bill code `CC02`,
  Valid _today → no end_.

**5.3 Sub-categories inherit it**

- [ ] Change **Category** to `Demo CGHS › CGHS Paid`, then to `Demo CGHS ›
Pensioner`.
- **Expect:** the same item shows **₹800 "From Demo CGHS"**, `CC02 "From Demo
CGHS"`, Valid _Inherited_, and no Clear button.

**5.4 Pensioner gets its own rate**

- [ ] With `Demo CGHS › Pensioner` chosen, **Edit** the item:

  | Box  | Type this |
  | ---- | --------- |
  | Rate | `600`     |

  → **Save**.

- **Expect:** Pensioner shows ₹600 **Own**, bill code still CC02 from Demo CGHS.
  Switch to CGHS Paid → still ₹800.

**5.5 Only a bill code for CGHS Paid**

- [ ] Choose `Demo CGHS › CGHS Paid`, **Edit** the item.
- **Expect:** the Rate box is empty with the hint _₹800 (inherited)_.
- [ ] Type only:

  | Box       | Type this |
  | --------- | --------- |
  | Bill code | `CC03`    |

  → **Save**.

- **Expect:** Bill code `CC03` (own); Rate still **₹800 From Demo CGHS**.

**5.6 A price change from tomorrow**

- [ ] Choose `Demo CGHS`, **Edit** the item:

  | Box  | Type this                                        |
  | ---- | ------------------------------------------------ |
  | Rate | `900`                                            |
  | From | tomorrow, e.g. `2026-09-22` if today is the 21st |

  → **Save**.

- **Expect:** today still shows ₹800 with _"Changes on 2026-09-22"_.
- [ ] Set **As of** to tomorrow (`2026-09-22`).
- **Expect:** the item shows ₹900.

**5.7 Looking at an old date never backdates a price**

- [ ] Set **As of** to yesterday (e.g. `2026-09-20`) and click **Edit**.
- **Expect:** the **From** box shows **today**, not yesterday. Click **Cancel**.

**5.8 Clear the future price and go back**

- [ ] Set **As of** to tomorrow and click **Clear** on the item.
- **Expect:** "Checking…" for a moment, then three buttons: **Clear**, **Clear and
  go back to ₹800**, **Keep**.
- [ ] Click **Clear and go back to ₹800**.
- **Expect:** ₹800, valid _today → no end_.

**5.9 History**

- [ ] Click **History** on the item.
- **Expect:** every Demo CGHS rate for this item with From, To, Rate, Bill code;
  each has **Clear** → **Confirm clear**. Click **Close**.

**5.10 Clear a sub-category's own rate**

- [ ] Choose `Demo CGHS › Pensioner`, click **Clear** → **Clear**.
- **Expect:** back to **₹800 From Demo CGHS**.

**5.11 Search and group filter**

- [ ] Type in **Search**:

  | Box    | Type this   |
  | ------ | ----------- |
  | Search | `LAB-HBA1C` |

- **Expect:** only HbA1c. Clear it; choose **Group** `OPD` → only consultation
  items.

**5.12 A refused save**

- [ ] **Edit** any item and type:

  | Box       | Type this |
  | --------- | --------- |
  | Bill code | `CC 02`   |

  → **Save**.

- **Expect:** a red message in the row: **Bill code can't contain spaces**
  (never just "Validation failed").

**5.13 The rate box takes only an amount**

- [ ] **Edit** any item and type into **Rate**:

  | Type this      | Box shows |
  | -------------- | --------- |
  | `1e fgjdfhk00` | `100`     |
  | `₹-1,250.555`  | `1250.55` |

  then **Cancel**.

**5.14 A rate can be higher than the base price**

- [ ] With `Demo CGHS` chosen, **Edit** _Consultation - Dr E2E Rahul (New)_
      (base price ₹900) and type Rate `1000` → **Save**.
- **Expect:** saved — the row shows Base price ₹900 and Rate **₹1,000 Own**. A
  category's rate is its own price list and may be lower or higher than the
  base price.

---

## 6. Billing settings

Tasks: P1-11 (settings, bill series, audit tables), P1-23 (services), P1-27
(routes), P1-33 (Billing settings page) and its review fixes.

Log in as **E2E Admin** (PIN `4321`) → **Settings → Billing settings**.

**6.1 Bills card**

- [ ] Set:

  | Box / tick                   | Set to                                        |
  | ---------------------------- | --------------------------------------------- |
  | When several discounts apply | `Each rule's discount, one after another`     |
  | Most codes on one bill       | `5`                                           |
  | Allow pay later              | tick ✓                                        |
  | Bill footer                  | `Thank you for visiting Gini. Get well soon.` |

  → **Save**.

- [ ] Press F5 to reload.
- **Expect:** all four values are still there; the note links to **Prescription
  settings** for the logo and letterhead.

**6.2 GST can't be switched on empty**

- [ ] In the **GST** card tick only **Charge GST on bills** → **Save**.
- **Expect:** _"GST can't be switched on until the GSTIN, state code, legal name
  are filled in"_.

**6.3 A mistyped GSTIN is caught**

- [ ] Type:

  | Box        | Type this                     |
  | ---------- | ----------------------------- |
  | GSTIN      | `27AAPFU0939F1ZX`             |
  | State code | leave empty                   |
  | Legal name | `Gini Advanced Care Hospital` |

  → **Save**.

- **Expect:** _"That GSTIN's last character doesn't match — check it for a typing
  mistake"_.

**6.4 A correct GSTIN (lower case is fine)**

- [ ] Change:

  | Box   | Type this         |
  | ----- | ----------------- |
  | GSTIN | `27aapfu0939f1zv` |

  → **Save**.

- **Expect:** saved as `27AAPFU0939F1ZV`, **State code** filled in as `27`, GST
  ticked.

**6.5 Details can't be cleared while GST is on**

- [ ] Empty the **Legal name** box → **Save**.
- **Expect:** _"GST is switched on, so the legal name can't be cleared"_. Type
  `Gini Advanced Care Hospital` back and Save.

**6.6 Tax codes**

- [ ] Under **Add tax code** type:

  | Box     | Type this |
  | ------- | --------- |
  | Code    | `GST18`   |
  | SAC/HSN | `999312`  |
  | Rate %  | `18`      |

  → **+ Add tax code**.

- **Expect:** a row _GST18 · 999312 · 18% · 0 items · Yes_.
- [ ] Add another with Code `GST120`, Rate % `120`.
- **Expect:** red message under the form (rate must be 0–100); nothing added.
- [ ] **Edit** GST18:

  | Box    | Type this |
  | ------ | --------- |
  | Rate % | `12.5`    |

  → **Save**. **Expect:** 12.5%.

- [ ] **Deactivate** → **Activate**.
- [ ] **Delete** → **Keep** (back to Delete). **Delete** → **Confirm delete**.
- **Expect:** GST18 is gone.

**6.7 A tax code in use can't be deleted**

- [ ] Add tax code Code `GST5`, Rate % `5`.
- [ ] Go to **Services** → Dressings → **Edit** _Dressing - small_ → **Tax code**
      `GST5 · 5%` → **Save**.
- [ ] Back in **Billing settings**, **Delete** GST5 → **Confirm delete**.
- **Expect:** _"GST5 can't be deleted"_ listing _1 item_. Click **Close**.

**6.8 Number series**

- [ ] In **Number series** (current financial year selected), type:

  | Row      | Prefix      | Digits | Next number |
  | -------- | ----------- | ------ | ----------- |
  | Bills    | `GH/26-27/` | `5`    | `41`        |
  | Receipts | `RC/26-27/` | `6`    | `1`         |

  and click **Set up** on each row.

- **Expect:** Bills preview **GH/26-27/00041**, Receipts **RC/26-27/000001**;
  "Not set up yet" disappears.
- [ ] Reload (F5). **Expect:** the values are kept.
- [ ] On Bills type Next number `7` → **Save**.
- **Expect:** _"The next number can only go up (it is 41)…"_.
- [ ] Change **Financial year** to next year, and on Bills type Prefix
      `GH/27-28/` → **Set up**.
- **Expect:** saved for next year; this year is untouched.

**6.9 Two admins at once**

- [ ] Open this page in two browser tabs (both as E2E Admin).
- [ ] Tab A — Bill footer `Footer from tab A` → **Save**.
- [ ] Tab B — without reloading, Most codes on one bill `9` → **Save**.
- [ ] Reload both.
- **Expect:** footer is `Footer from tab A` **and** most codes is `9` — tab B did
  not undo tab A.

**6.10 Reception Admin can't open it**

- [ ] Log in as **E2E Reception Admin**, type
      `http://localhost:3100/settings/billing`.
- **Expect:** sent back home.

---

## 7. Test catalogue

Tasks: P1-24 (prices move to billing items), P1-34 (catalogue stops editing
price).

Log in as **E2E Admin** → **Settings → Test catalogue**.

**7.1 No price box**

- **Expect:** no price input on any row, and none in "Add a test to the clinic
  list".

**7.2 Where each price comes from**

- **Expect:**
  - **HbA1c** — `₹500` and the link `LAB-HBA1C` (it has an item from 3.5). Click
    it → Services opens with `LAB-HBA1C` in the search box.
  - **Fasting Blood Sugar** — its old catalogue price in grey and **Create item**.
  - The warning _"N active tests have no active billing item — reception charges
    the old catalogue price…"_.

**7.2b Search by name or code**

- [ ] Type each value into the search box (**Search name or code…**):

  | Type this   | Expect                                      |
  | ----------- | ------------------------------------------- |
  | `hba1c`     | HbA1c (by name)                             |
  | `LAB-HBA1C` | only HbA1c (by its billing item code)       |
  | `lab-lipid` | only Lipid Profile (small letters work too) |

  Clear the box afterwards.

**7.3 Create an item from the catalogue**

- [ ] Click **Create item** on **Fasting Blood Sugar**.
- **Expect:** Services opens with the item form filled (name, kind test, the
  catalogue test, its price).
- [ ] Type:

  | Box      | Type / choose  |
  | -------- | -------------- |
  | Code     | `LAB-FBS`      |
  | Subgroup | `Biochemistry` |

  → **Add item**. Go back to Test catalogue.

- **Expect:** Fasting Blood Sugar now shows its price and the link `LAB-FBS`.

**7.4 An item switched off**

- [ ] In Services deactivate `LAB-FBS`, return to Test catalogue.
- **Expect:** _"LAB-FBS is off"_. (Activate it again afterwards.)

**7.5 Add a new test**

- [ ] In **Add a test to the clinic list** type:

  | Box                                  | Type this    |
  | ------------------------------------ | ------------ |
  | Test name — offered to every patient | `Vitamin D3` |
  | Station                              | `🩸 Lab`     |

  → **+ Add**.

- **Expect:** _Vitamin D3_ appears at ₹0 with **Create item**.

**7.6 Retired tests**

- [ ] Click **Retire** on _Vitamin D3_, tick **Show retired**.
- **Expect:** it shows **Retired** instead of Create item.

---

## 8. Floor prices unchanged

Tasks: P1-24, P1-36.

- [ ] Log in as **E2E Reception** → Gini Flow → Reception, open the check-in
      test picker and note **Lipid Profile**'s price.
- [ ] As **E2E Reception Admin**, in Services **Edit** _Lipid Profile_
      (`LAB-LIPID`):

  | Box                         | Type this            |
  | --------------------------- | -------------------- |
  | Price (₹)                   | `650`                |
  | Reason for the price change | `New lab price list` |

  → **Save**.

- [ ] Back as Reception, reload the picker.
- **Expect:** Lipid Profile now shows ₹650.

The MO ordering screen, reception's payment queue and CGHS patients with no CGHS
rate need visits from the HealthRay sync, which is off in the test setup; the
automated test **P1-36** covers them (section 10).

---

## 9. Scripts and the database

> ⚠️ Always put `DATABASE_URL=…` in front — without it these scripts use
> **production**, and `smoke:ghm-categories` edits real appointments.

**9.1 Master data smoke (P1-35)** — 8 checks, everything rolled back:

```bash
cd server
DATABASE_URL=postgres://user:pass@localhost:5435/gini_scribe_test npm run smoke:billing-master
```

- [ ] **Expect:** `✓ 1.` … `✓ 8.` and **ALL OK (8/8)**, plus an ℹ line about
      tests billed at their item's price.

**9.2 GHM smoke scripts (P1-36)** — need a date with at least 5 appointments:

```bash
DATABASE_URL=postgres://user:pass@localhost:5435/gini_scribe_test npm run smoke:ghm-categories -- 2026-09-21
DATABASE_URL=postgres://user:pass@localhost:5435/gini_scribe_test npm run smoke:ghm-pill-filters -- 2026-09-21
```

- [ ] **Expect:** only `PASS` lines. "Need 5 appointments" means the date is too
      empty.

**9.3 Change log, history and rates (P1-13, P1-14)** — in `psql` on the test
database (section 0):

```sql
SELECT entity, entity_id, action, actor_id, at FROM billing_audit ORDER BY at DESC LIMIT 20;
SELECT * FROM service_item_price_history ORDER BY changed_at DESC LIMIT 10;
SELECT scheme_code, service_item_id, rate, bill_code, valid_from, valid_to FROM category_item_rates;
SELECT code, label, parent_code, daily_cap, is_active FROM patient_schemes ORDER BY code;
SELECT * FROM billing_settings;
SELECT * FROM bill_series;
DELETE FROM billing_audit;
```

- [ ] Every change you made in sections 2–7 shows in `billing_audit`.
- [ ] Card numbers, PINs and similar show as `[redacted]`.
- [ ] The last line fails — the change log is append-only.

**9.4 P2-01 — import history table**

- [ ] In `psql`: `\d billing_imports`
- **Expect:** `id, file_name, imported_by, imported_at, counts, status`.
- [ ] `\d billing_audit`
- **Expect:** an `import_id` column.

**9.5 P2-02 — Excel cell parsing**

```bash
node -e "import('./server/services/billing/importColumns.js').then(m=>{const c=m.sheetByName('Items').columns.find(x=>x.name==='base_price');for (const v of ['1,200','1200.50','12.345','₹500']) console.log(v, '→', m.parseCell(c, v))})"
```

- [ ] **Expect:**

  | Typed     | Result                                               |
  | --------- | ---------------------------------------------------- |
  | `1,200`   | error: must be a plain number (no ₹ sign, no commas) |
  | `1200.50` | value `1200.5`                                       |
  | `12.345`  | error: can have at most 2 decimals (paise)           |
  | `₹500`    | error: must be a plain number (no ₹ sign, no commas) |

---

## 10. Automated tests

Stop the two test-app terminals first — the suite uses the same ports and resets
the same test database.

```bash
npm run test:e2e:billing
```

- [ ] **Expect:** about 370 passed. A browser test hit by Chrome's
      `net::ERR_NETWORK_CHANGED` glitch retries once and shows as "flaky" —
      expected on this machine.

---

## 11. Not testable yet

The Billing Counter, bills, payments, discounts, payment rules and the Excel
upload screen belong to Phases 2–4 and are not built yet.

**Reporting a problem:** note the section and step number (e.g. "5.6"), the login
you used, what you typed and what you saw instead. A screenshot helps.
