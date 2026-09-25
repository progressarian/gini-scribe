# Billing — Demo and Testing Guide

A click-by-click guide to record everything built in billing so far, from the first setting to the last report. Every value in the tables can be copied straight into the field it names. The examples build on each other: the items made in Part 2 are the ones billed at the counter in Part 9.

---

## Before you start

- Record on the **test servers**: open `http://localhost:3100`. They use the test database, so nothing reaches real patients or real bills.
- Do not run the automatic billing tests while recording. They wipe the test database and everything you set up.
- Logins (PIN is **4321** for all):

| Who                 | Role            | What they can open                                                                                   |
| ------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| E2E Admin           | Admin           | Everything, including Billing settings and Undo on the CGHS register                                 |
| E2E Reception Admin | Reception admin | Billing counter, Settings billing tabs (not Billing settings), Desk requests, CGHS register, Reports |
| E2E Reception       | Reception       | Billing counter only                                                                                 |

- Test patients already in the system: **E2E General Adult** (40, Male), **E2E Senior 72** (72, Female), **E2E CGHS Paid** (55, Male), **E2E CGHS Referral** (60, Female), **E2E Pensioner** (68, Male).
- Doctors: **Dr E2E Banshali**, **Dr E2E Rahul**, **Dr E2E Beant**.
- Wherever a date says **today**, pick today's date in the date picker.

### Order of the recording

1. Billing settings (tax codes, bill numbers, pay later)
2. Services — groups, sub-groups, items
3. Categories — categories, sub-categories, who belongs, what the patient pays
4. Category rates
5. Consultant fees
6. Discounts
7. Bulk import
8. Desk requests (shown together with the counter)
9. Billing counter — every case
10. CGHS register
11. Billing reports
12. Who can see what

---

## Part 1 — Billing settings

**Login:** E2E Admin → ⚙️ Settings → **Billing settings** tab.
This tab is for the admin only. It has four cards, and each card has its own **Save** button.

### 1.1 Card "Bills"

How discounts combine, whether patients can pay later, and the note at the bottom of every bill.

| Field                                          | Enter                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| When several discounts apply                   | Only the best discount                                                                      |
| Most codes on one bill                         | 2                                                                                           |
| Allow pay later (a category can override this) | ✔ tick it (needed for the Dues demo)                                                        |
| Bill footer                                    | Thank you for choosing Gini Advanced Care Hospital. Please keep this bill for your records. |

Press **Save**. You should see: _Saved the bill settings_.

> The hospital logo and letterhead on bills come from **Prescription settings**, not from here.

### 1.2 Card "GST"

Leave **Charge GST on bills** switched **off**. The hospital does not charge GST yet.

GST can only be switched on once GSTIN, State code and Legal name are all filled in.

### 1.3 Card "Tax codes"

The GST rates an item can carry. Items can only pick a tax code that exists here.

Press **+ Add tax code** after each row:

| Code   | SAC/HSN         | Rate % |
| ------ | --------------- | ------ |
| EXEMPT | _(leave empty)_ | 0      |
| GST18  | 999312          | 18     |

You should see _Added EXEMPT_, then _Added GST18_.

### 1.4 Card "Number series" (bill numbers)

Bill and receipt numbers start again every financial year (April to March). The next number can only go up, so a number is never used twice.

**Financial year:** 2026-27

| Series       | Prefix | Digits | Next number | Next looks like |
| ------------ | ------ | ------ | ----------- | --------------- |
| Bills        | GH26-  | 6      | 1           | GH26-000001     |
| Receipts     | RC26-  | 6      | 1           | RC26-000001     |
| Credit notes | CN26-  | 6      | 1           | CN26-000001     |

Press **Set up** on each row. You should see _Saved the Bills series for 2026-27_.

> **Important:** if the Bills or Receipts series is not set up, the counter can't finalise a bill. It shows: _Ask the admin to set the bill series for 2026-27_.

---

## Part 2 — Services: groups, sub-groups and items

**Settings → Services** tab.

- **Group:** a top-level head used in reports (OPD, Lab, Cardiology…).
- **Sub-group:** a section inside a group (Lab › Biochemistry). Every item sits in one sub-group.
- **Item:** one thing you can bill, with its own price.

The **code** can never be changed later; the **name** can. Codes have no spaces.

### 2.1 Groups — press **+ Add group**

| Code | Name                     |
| ---- | ------------------------ |
| OPD  | Out-patient Consultation |
| LAB  | Laboratory               |
| CARD | Cardiology Tests         |
| PROC | Procedures               |

### 2.2 Sub-groups — click the group, then **+ Subgroup**

| Under group              | Code       | Name                          |
| ------------------------ | ---------- | ----------------------------- |
| Out-patient Consultation | OPD-CONS   | Consultation                  |
| Laboratory               | LAB-BIO    | Biochemistry                  |
| Laboratory               | LAB-HAEM   | Haematology                   |
| Cardiology Tests         | CARD-HEART | ECG and Heart                 |
| Procedures               | PROC-DRS   | Dressing and Minor Procedures |

**Show on the recording:** Rename, the Move up / Move down arrows, and Deactivate / Activate on one sub-group.

### 2.3 Hospital default consultation items

These are used for any doctor who has no fee of their own.

Pick the **Consultation** sub-group → **+ Add item**:

| Field      | Item 1                                | Item 2                                      |
| ---------- | ------------------------------------- | ------------------------------------------- |
| Name       | Consultation — Hospital default (New) | Consultation — Hospital default (Follow Up) |
| Code       | CONS-DEF-NEW                          | CONS-DEF-FU                                 |
| Subgroup   | Consultation                          | Consultation                                |
| Kind       | Consultation                          | Consultation                                |
| Price (₹)  | 800                                   | 500                                         |
| Unit       | each                                  | each                                        |
| Tax code   | No tax                                | No tax                                      |
| Consultant | Hospital default (any consultant)     | Hospital default (any consultant)           |
| Visit type | New                                   | Follow Up                                   |

### 2.4 "Not priced" — create items straight from what is missing

Press the top button **Not priced**.

**Consultants without a fee.** Find **Dr E2E Banshali** and press **Create item** on each row:

| Field     | New                                                     | Follow Up                                  |
| --------- | ------------------------------------------------------- | ------------------------------------------ |
| Name      | _(already filled)_ Consultation — Dr E2E Banshali (New) | Consultation — Dr E2E Banshali (Follow Up) |
| Code      | CONS-BANSHALI-NEW                                       | CONS-BANSHALI-FU                           |
| Subgroup  | Consultation                                            | Consultation                               |
| Price (₹) | 1000                                                    | 600                                        |

**Tests without an item.** Press **Create item** on each test below. The name, Kind = Test and the test link are filled in for you.

| Test          | Code       | Subgroup      | Price (₹) |
| ------------- | ---------- | ------------- | --------- |
| HbA1c         | LAB-HBA1C  | Biochemistry  | 500       |
| Lipid Profile | LAB-LIPID  | Biochemistry  | 600       |
| CBC           | LAB-CBC    | Haematology   | 200       |
| ECG           | CARD-ECG12 | ECG and Heart | 300       |

### 2.5 A procedure that can be billed more than once

Pick the **Dressing and Minor Procedures** sub-group → **+ Add item**:

| Field                       | Enter                         |
| --------------------------- | ----------------------------- |
| Name                        | Dressing — Small              |
| Code                        | PROC-DRS-S                    |
| Subgroup                    | Dressing and Minor Procedures |
| Kind                        | Procedure                     |
| Price (₹)                   | 250                           |
| Unit                        | each                          |
| Tax code                    | No tax                        |
| Quantity can be more than 1 | ✔                             |
| Max quantity                | 5                             |

### 2.6 Things to show on the recording

- **Change a price and see its history.** Edit **CBC** and change the price 200 → 220. The box **Reason for the price change** appears; type _Reagent cost increased_. Save, then press the **Price history** icon.
- **An error.** Add another item with code **LAB-CBC**. You get _A item with code "LAB-CBC" already exists_.
- **An item on a bill can't be deleted.** Try this after Part 9: Delete **HbA1c**. The screen shows _can't be deleted … N bill lines charge HbA1c_ and offers **Deactivate instead**.

---

## Part 3 — Categories: who the patient is billed as

**Settings → Categories** tab.

- **Category:** who the patient is billed as (CGHS, ECHS, Senior Citizen…). "General" means no category, so never create a category called General.
- **Sub-category:** one level under a category (CGHS › CGHS Paid). It uses the parent's rates and rules unless it has its own.
- **Who belongs:** rules that make the counter suggest (or set) a category for a patient.
- **What the patient pays:** payment rules. They split the price into what the patient pays and what is claimed from the payer (or written off).

The categories **CGHS, ECHS, Himachal Government, Senior Citizen** and **Special Discount** already exist.

### 3.1 CGHS details — click **CGHS**

| Field                          | Enter                                                |
| ------------------------------ | ---------------------------------------------------- |
| Colour                         | blue                                                 |
| Patients per day               | _(leave empty = no limit; only an admin can set it)_ |
| Payer name                     | CGHS Chandigarh                                      |
| Pay later                      | Follow the billing setting                           |
| Print the category on the bill | ✔                                                    |

Press **Save**. The payer name is needed before any rule can claim money from CGHS.

### 3.2 CGHS sub-categories — on CGHS press **+ Sub-category**

| Code           | Label          |
| -------------- | -------------- |
| cghs_paid      | CGHS Paid      |
| cghs_referral  | CGHS Referral  |
| cghs_pensioner | CGHS Pensioner |

Codes are lowercase letters, numbers and `_` only.

Now open each sub-category and tick its boxes, then **Save**. Leave **Payer name** empty on all three; they use CGHS's.

| Sub-category   | Card number required | Needs a referral | Needs the referral scanned                                 | Print the category on the bill |
| -------------- | -------------------- | ---------------- | ---------------------------------------------------------- | ------------------------------ |
| CGHS Paid      | ✔                    |                  |                                                            | ✔                              |
| CGHS Referral  |                      | ✔                | _(leave off on the test server — scans need file storage)_ | ✔                              |
| CGHS Pensioner | ✔                    |                  |                                                            | ✔                              |

### 3.3 "Who belongs" rules — open the category or sub-category, then **+ Add rule**

| On             | Rule name                | From age | To age    | Gender | Has a card | How it applies              | Priority |
| -------------- | ------------------------ | -------- | --------- | ------ | ---------- | --------------------------- | -------- |
| Senior Citizen | Age 60 and above         | 60       | _(empty)_ | Any    |            | Automatic                   | 100      |
| CGHS Pensioner | Pensioner with CGHS card | 60       | _(empty)_ | Any    | ✔          | Suggest — the desk confirms | 50       |

- **Automatic:** the bill opens already set to that category. Here, every patient aged 60 or over opens as Senior Citizen.
- **Suggest:** the rule is recorded, and you can see it working in **Test this rule** (Part 6), but the counter does not show it as a button today. The desk picks the category by hand.

When a patient matches two rules, the smaller priority number wins.

> On **CGHS** itself the screen says rules must go on a sub-category. That is expected: a patient is always billed under one of its sub-categories.

### 3.4 "What the patient pays" — payment rules, **+ Payment rule**

**Rule 1 — on CGHS (the parent).** It applies to every CGHS sub-category that has no rule of its own.

| Field        | Enter                          |
| ------------ | ------------------------------ |
| Rule name    | CGHS — patient pays 20%        |
| Applies to   | The whole category             |
| Visit types  | _(none ticked = every visit)_  |
| Patient pays | A percent of the price         |
| Percent (%)  | 20                             |
| The rest     | Claimed from CGHS Chandigarh   |
| From / To    | _(empty = from today, no end)_ |
| Priority     | 100                            |

**Rule 2 — on CGHS Paid.** A fixed consultation share, which beats the 20% for OPD items.

| Field        | Enter                              |
| ------------ | ---------------------------------- |
| Rule name    | CGHS Paid — consultation ₹200      |
| Applies to   | A group → Out-patient Consultation |
| Patient pays | A fixed amount (₹)                 |
| Amount (₹)   | 200                                |
| The rest     | Claimed from CGHS Chandigarh       |

**Rule 3 — on CGHS Referral.**

| Field        | Enter                        |
| ------------ | ---------------------------- |
| Rule name    | Referral — nothing to pay    |
| Applies to   | The whole category           |
| Patient pays | Nothing                      |
| The rest     | Claimed from CGHS Chandigarh |

**Rule 4 — on CGHS Pensioner.**

| Field        | Enter                        |
| ------------ | ---------------------------- |
| Rule name    | Pensioner — nothing to pay   |
| Applies to   | The whole category           |
| Patient pays | Nothing                      |
| The rest     | Claimed from CGHS Chandigarh |

**Show on the recording:** before saving Rule 2, press **Test this rule**, pick the preview item **Consultation — Dr E2E Banshali (New)** and visit type **New**. It shows the actual price → what the patient pays → the rest claimed. Nothing is saved.

- **Most specific wins:** an item rule beats a sub-group rule, which beats a group rule, which beats the whole category. A sub-category's own rule beats its parent's.
- **Error to show:** set Amount ₹2000 on a rule for **Dressing — Small** only. The screen says the patient can't pay ₹2000 because the item costs less.

---

## Part 4 — Category rates

**Settings → Category rates** tab.

A category's own price for an item, with its own name and code as printed on the bill. Sub-categories use the parent's rate unless they have their own.

**Category:** CGHS. Press **Edit** on each row, fill it in, then **Save**:

| Item  | Rate | Bill name                        | Bill code | From  | To        |
| ----- | ---- | -------------------------------- | --------- | ----- | --------- |
| HbA1c | 450  | Glycosylated Haemoglobin (HbA1c) | CG101     | today | _(empty)_ |
| ECG   | 250  | ECG 12 Lead                      | CG201     | today | _(empty)_ |

Now choose **CGHS Paid** in the Category box. The same rows show **From CGHS**, meaning they are inherited.

- Press **History** on a row to see its rates over time.
- **Clear** removes a rate.
- A bill code can never be the same as a discount code.

---

## Part 5 — Consultant fees

**Settings → Consultant fees** tab.

Each doctor's New and Follow Up fee for every category, and what the patient pays, on one grid. Greyed values are inherited. The **General** column is the base price, which is changed on the Services page.

Click the cell **Dr E2E Banshali · New × CGHS Paid**:

| Field            | Enter                   |
| ---------------- | ----------------------- |
| Fee (₹)          | 900                     |
| Patient pays     | An amount (₹)           |
| Amount (₹)       | 200                     |
| The rest goes to | Claim (CGHS Chandigarh) |
| Bill name        | OPD Consultation — CGHS |
| Bill code        | CG001                   |
| Valid from       | today                   |
| Valid to         | _(empty)_               |

Press **Save**. You should see _Saved the CGHS Paid fee for Dr E2E Banshali (New)_.

**Copy a column.** Press **Copy column to…**:

| Field     | Enter     |
| --------- | --------- |
| Copy from | CGHS Paid |
| Copy to   | ECHS      |
| Starting  | _(empty)_ |

Press **Copy…**, then **Copy**. You should see _Copied N fees from CGHS Paid to ECHS_.

---

## Part 6 — Discounts

**Settings → Discounts** tab → **+ New discount**.

There are two kinds of discount:

- **Code:** the desk types it at the counter.
- **Automatic:** applies by itself when the patient and item match.

Reception can never type a discount amount by hand.

### Discount 1 — senior citizen code

| Field                   | Enter                            |
| ----------------------- | -------------------------------- |
| Name                    | Senior citizen 10% off           |
| How it applies          | Code — the desk enters it        |
| Code                    | SENIOR10                         |
| Kind                    | Percent off                      |
| Percent                 | 10                               |
| Largest discount ₹      | 500                              |
| Applies to              | Each line                        |
| What it covers          | _(nothing = every service)_      |
| Categories              | _(nothing)_                      |
| From age / To age       | 60 / _(empty)_                   |
| Gender                  | Any                              |
| Valid from / to         | today / 2026-12-31               |
| Uses per day            | 50                               |
| Priority                | 100                              |
| Who may enter this code | _(nothing = every billing role)_ |

### Discount 2 — camp coupon on the whole bill

| Field                       | Enter                     |
| --------------------------- | ------------------------- |
| Name                        | Health camp ₹50 off       |
| How it applies              | Code — the desk enters it |
| Code                        | CAMP50                    |
| Kind                        | Flat ₹ off                |
| ₹ off                       | 50                        |
| Applies to                  | The whole bill            |
| Valid from / to             | today / 2026-10-31        |
| Uses in all                 | 100                       |
| Uses per patient            | 1                         |
| Stacks with other discounts | ✔                         |

### Discount 3 — doctor's coupon

| Field                   | Enter                      |
| ----------------------- | -------------------------- |
| Name                    | Dr Banshali patient coupon |
| How it applies          | Code — the desk enters it  |
| Code                    | DRB5                       |
| Kind                    | Percent off                |
| Percent                 | 5                          |
| Applies to              | Each line                  |
| Doctors                 | ✔ Dr E2E Banshali          |
| Uses per doctor per day | 5                          |
| Who may enter this code | ✔ Reception admin, ✔ Admin |

### Discount 4 — automatic camp price for Lipid Profile

| Field           | Enter                         |
| --------------- | ----------------------------- |
| Name            | Lipid Profile camp price      |
| How it applies  | Automatic — applies by itself |
| Kind            | Fixed price                   |
| Price ₹         | 450                           |
| Applies to      | Each line                     |
| Items           | search **LAB-LIPID** → Add    |
| Valid from / to | today / 2026-10-31            |

### "Test this rule" (below the list)

This prices a made-up bill exactly as the counter would. Nothing is saved and no limit is used up.

| Field                     | Enter                            |
| ------------------------- | -------------------------------- |
| Test age                  | 65                               |
| Test gender               | Female                           |
| Test category             | General                          |
| Test visit type           | New                              |
| Test doctor               | Dr E2E Banshali                  |
| Test date                 | today                            |
| Test as role              | Reception                        |
| Test items                | HbA1c → Add, Lipid Profile → Add |
| Codes entered at the desk | SENIOR10, DRB5                   |

Press **Test**. The results should show:

- **SENIOR10 under "Discounts that applied".**
- **DRB5 under "Codes refused"**, because reception is not allowed to enter it.
- **Lipid Profile at its ₹450 camp price.** With "Only the best discount" set, each line takes its single biggest discount.

---

## Part 7 — Bulk import

**Settings → Bulk import** tab.

Add or update many rows at once from an Excel file. Nothing is saved until you press **Commit**.

1. Press **Download template**. This saves **gini-billing-template.xlsx**, which has one sheet per kind of data plus a **Read me** sheet.
2. Open the **Items** sheet and type these three rows under the grey EXAMPLE rows:

| item_code | name            | subgroup_code | base_price | unit | allow_quantity | kind  | test_name |
| --------- | --------------- | ------------- | ---------- | ---- | -------------- | ----- | --------- |
| LAB-TSH   | TSH             | LAB-BIO       | 280        | each | no             | test  | TSH       |
| LAB-CBC   | CBC             | LAB-HAEM      | 240        | each | no             | test  | CBC       |
| LAB-BAD   | Wrong price row | LAB-BIO       | ₹300       | each | no             | other |           |

3. Save the file as **.xlsx** and drop it on **Filled-in template (.xlsx)**.

What you should see:

- **LAB-TSH** is **Ready**: a new item.
- **LAB-CBC** is **Needs override**: its price changes 220 → 240.
- **LAB-BAD** is **Failed**: _base_price must be a plain number (no ₹ sign, no commas)_.

**Show on the recording:**

- The status tabs, the **Sheet** filter and the **Search** box.
- **Download failed rows**.
- On LAB-CBC press **Override**, then **Commit** → **Yes, save 2 rows**.
- The **Import history** card at the bottom → **View report**.

Blank cells use their default. Required column headers are orange. Amounts have no ₹ sign or commas, and dates are written as 2026-10-01.

---

## Part 8 — Desk requests

**Settings → Desk requests** tab. It needs Admin or Reception admin, and the tab shows a count badge.

The counter sends two kinds of request here:

- **Bill again:** the patient needs an item billed a second time on the same visit.
- **New item:** an item is missing from the list. It comes with no price; the admin sets the price.

The requests themselves are raised during Part 9 (cases G and H). Keep this tab open in a second window to show it updating live.

---

## Part 9 — Billing counter

### 9.1 Open the shift (cash drawer)

**Login:** E2E Reception. Go to Stations → **🧾 Billing Counter** → **Shift** tab.

| Field        | Enter |
| ------------ | ----- |
| Opening cash | 2000  |

Press **Open shift**. Cash can't be taken without an open shift; card and UPI can.

### 9.2 Check the patient in (this creates the draft bill)

Go to **Reception** station → **+ Walk-in**, search the patient, choose the journey step (Consultation) → **✓ Check in**.

Check-in quietly opens a **draft bill** with the consultation fee already on it. On the patient's row, press **Bill** to open that bill on the counter in a new tab.

Check in all five test patients this way.

### Case A — General patient, cash, quantity, whole-bill coupon

Patient: **E2E General Adult**.

1. The consultation line is already there.
2. **Add items**, search and **Add**: `LAB-HBA1C`, `PROC-DRS-S`.
3. On Dressing — Small, change **Qty** to **2** and press Enter.
4. **Discount code:** `CAMP50` → **Apply code**. The chip shows _CAMP50 · Health camp ₹50 off · ₹50 off_.
5. **Payment:** Mode **Cash** → press **Rest** → **Take payment ₹…**.
6. Press **Finalise & print**. The bill PDF opens with number **GH26-000001**.
7. Press **Print receipt**. You get one page per payment, starting at **RC26-000001**.

### Case B — wrong code, then senior discount and a split payment

Patient: **E2E Senior 72**.

1. The bill opens already set to **Senior Citizen**. That is the automatic "Age 60 and above" rule from Part 3.
2. Add `LAB-LIPID` and `LAB-HBA1C`. Lipid Profile already shows the automatic ₹450 camp price.
3. **Show a refused code:** type `DRB5` → **Apply code**. It is refused because reception can't enter it.
4. Type `SENIOR10` → **Apply code**.
5. **Payment** row 1: Mode **Card**, Amount **500**, Reference **4321**.
6. Press **+ Split payment**. Row 2: Mode **UPI**, press **Rest**, Reference **UPI302611223344**.
7. Press **Take payment**, then **Finalise & print**.

To show another refusal: on Case A's patient, `SENIOR10` is refused because the patient is under 60.

### Case C — CGHS Paid (card, patient pays a share)

Patient: **E2E CGHS Paid**.

1. **Category:** CGHS → **CGHS Paid**. If you pick plain CGHS, the counter asks you to choose a sub-category.
2. **Card number:** `CGHS12345678` → **Save numbers** → **Confirm category**.
3. Add `LAB-HBA1C` and `CARD-ECG12`. The lines show the CGHS bill names and codes (CG101, CG201).
4. **Totals** shows **Claimed**: the part CGHS pays.
5. Take the patient's share in **Cash** with **Rest**, then **Finalise & print**.
6. The badge reads **CGHS pending**.

### Case D — CGHS Referral (referral number, nothing to pay)

Patient: **E2E CGHS Referral**.

1. The bill opens as **Senior Citizen** (the patient is 60). Change **Category** to CGHS → **CGHS Referral**.
2. **Referral number:** `REF/CHD/2026/0457` → **Save numbers** → **Confirm category**.
   - Before the number is saved, the list under the buttons shows _Enter the referral number first._
3. Add `LAB-LIPID`.
4. The screen says _No payment is needed on this bill._ Press **Finalise & print**. The badge reads **CGHS pending**.

### Case E — CGHS Pensioner (nothing to pay)

Patient: **E2E Pensioner**.

1. The bill opens as **Senior Citizen** (the patient is 68). Change **Category** to CGHS → **CGHS Pensioner**.
2. **Card number:** `CGHS87654321` → **Save numbers** → **Confirm category**.
3. Add `LAB-CBC`, then **Finalise & print**. Everything is claimed and the badge reads **CGHS pending**.

### Case F — pay later, then collect from Dues

Use a General patient who has not paid yet (check in **E2E General Adult** again, or use any new walk-in).

1. Add `LAB-CBC`.
2. Tick **Pay later** → **Finalise & print**.
3. Open the **Dues** tab. The bill shows its **Outstanding** amount. Press **Take payment**, then pay in **Cash** with **Rest**.

### Case G — bill again (needs an admin)

On Case A's patient, search `LAB-HBA1C` again. It is greyed with **Ask admin to bill again**.

1. Press it. In **Why must it be billed again?** type _Repeat sample — first sample haemolysed_ → **Send request**.
2. **Admin window:** Settings → **Desk requests**. The request appears. Press **Approve**, type _OK to repeat_ in **Note for the desk** → **Approve request**.
3. **Counter:** under **My requests** the row shows **Approved**. Press **Add to bill**.

### Case H — new item request

1. On any draft, search `Nebulisation`. The screen says no item matches. Press **Request new item**:

| Field             | Enter                             |
| ----------------- | --------------------------------- |
| Item name         | Nebulisation                      |
| Group             | Procedures                        |
| Why is it needed? | Doctor advised nebulisation today |

Press **Send request**.

2. **Admin window:** Desk requests → **Create item**:

| Field             | Enter                         |
| ----------------- | ----------------------------- |
| Name              | Nebulisation                  |
| Code              | PROC-NEB                      |
| Subgroup          | Dressing and Minor Procedures |
| Kind              | procedure                     |
| Price (₹)         | 300                           |
| Note for the desk | Added at ₹300                 |

Press **Create item and approve**. The counter can now add **PROC-NEB**.

### Case I — cancel an unpaid bill

Take a bill finalised with **Pay later** that has nothing paid (repeat Case F without collecting).

1. Press **Cancel unpaid bill**.
2. In **Why is this bill being cancelled?** type _Patient left before paying — billed by mistake_ → **Cancel bill**.
3. Then press **Start a new bill for this visit**.

A bill with money on it has no Cancel button; refunds are not built on screen yet.

### Case J — second bill on the same visit

After a bill is final, a new test ordered for that visit opens a second draft. The screen shows _A new draft bill is open on this visit_ → **Open the new draft bill**. The first bill moves to **Earlier bills on this visit**, where **Print** reprints it.

### Case K — lab gate (optional; needs the MO station)

A test ordered at the MO station waits at the Lab with _Waiting for reception to clear payment_. Once the counter takes the money for that test, the Lab can press **Start collection**. CGHS Referral and Pensioner tests are released when the bill is finalised.

### 9.3 Close the shift

**Shift** tab.

| Field        | Enter                                                                     |
| ------------ | ------------------------------------------------------------------------- |
| Counted cash | _(the "Expected in the drawer" figure, or ₹10 less to show a difference)_ |
| Note         | End of demo shift                                                         |

Press **Close shift** → **Close the shift**. The screen shows expected, counted and the difference.

---

## Part 10 — CGHS register

**Login:** E2E Reception Admin (or Admin). Top menu → **🧾 CGHS register**.

Every final bill with an amount claimed from CGHS stays **Pending** until the money reaches the bank.

1. The **Pending** tab lists the bills from Cases C, D and E.
2. Tick all three (or **Select all filtered**) → **Clear selected**.

| Field               | Enter                                              |
| ------------------- | -------------------------------------------------- |
| Date received       | today                                              |
| Reference (UTR)     | UTR2026092500123                                   |
| Amount received (₹) | _(already filled with the total claim — leave it)_ |
| Note                | CGHS September batch                               |

3. The line says _The amount matches the selected claims._ Press **Save**. You should see _Cleared 3 bills — reference UTR2026092500123_.
4. **Counter:** open Case C's bill. The badge now reads **Cleared on 2026-09-25**.
5. **Cleared** tab → **Undo** (admin only). Enter Reason _Wrong UTR entered_ → **Undo payment**. The bills go back to Pending. Clear them again.
6. Press **Print pending list** and **Export Pending (.xlsx)** / **Export Cleared (.xlsx)**.

To show an error, change the amount received to a different figure. **Save** stays off and the screen shows the difference.

---

## Part 11 — Billing reports

Top menu → **💹 Billing Reports**. Final bills only; days are India dates.

**Dates:** This month.

Open each tab:

- Revenue by service
- Revenue by consultant
- Revenue by category
- Collections (by payment mode, user, shift and day)
- Dues
- Discounts
- CGHS receivables (with ageing)
- Coupon usage
- Cancellations
- Desk requests

Try the filters **By: Day**, **Category: CGHS**, **Consultant: Dr E2E Banshali**. Press **Download Excel**.

---

## Part 12 — Who can see what

| Screen                                                                                                 | Admin        | Reception admin | Reception |
| ------------------------------------------------------------------------------------------------------ | ------------ | --------------- | --------- |
| Billing counter                                                                                        | ✔            | ✔               | ✔         |
| Settings: Categories, Services, Category rates, Consultant fees, Discounts, Desk requests, Bulk import | ✔            | ✔               | ✘         |
| Settings: Billing settings                                                                             | ✔            | ✘               | ✘         |
| Category "Patients per day"                                                                            | ✔            | read only       | ✘         |
| CGHS register                                                                                          | ✔ (and Undo) | ✔               | ✘         |
| Billing reports                                                                                        | ✔            | ✔               | ✘         |

**Show on the recording:** log in as **E2E Reception**. There is no billing Settings, no CGHS register and no Billing Reports in the menu.

---

## Not built on screen yet

- **Refunds and credit notes.** The server side exists, but there is no counter screen. A paid bill can't be cancelled.
- **GST on bills.** It is ready but switched off until the hospital needs it.
