# Gini Billing — Step-by-Step Guide

This guide sets up billing from scratch and then uses it at the counter. Every table lists the screen's field names on the left and a sample value on the right, ready to copy.

The steps build on each other: the items created in Step 2 are the ones billed in Step 8.

---

## Who does what

| User                | Can use                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| **Admin**           | Everything, including Billing settings                                        |
| **Reception Admin** | Billing counter, billing setup screens, Desk requests, CGHS register, Reports |
| **Reception**       | Billing counter only                                                          |

**Sample patients used in this guide:**

- a General patient, aged under 60
- a patient aged 60 or over
- a CGHS card holder
- a CGHS referral patient
- a CGHS pensioner

Wherever a date says **today**, choose today's date.

---

## Step 1 — Billing settings (Admin)

**Settings → Billing settings.** The page has four sections, and each one has its own **Save** button.

### 1.1 Bills

| Field                        | Sample value                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| When several discounts apply | Only the best discount                                                                      |
| Most codes on one bill       | 2                                                                                           |
| Allow pay later              | ✔ Ticked                                                                                    |
| Bill footer                  | Thank you for choosing Gini Advanced Care Hospital. Please keep this bill for your records. |

The hospital logo and letterhead on bills come from **Prescription settings**.

### 1.2 GST

Leave **Charge GST on bills** switched off. It can be switched on later, once the GSTIN, state code and legal name are filled in.

### 1.3 Tax codes

These are the tax rates an item can carry. Press **+ Add tax code** after each row.

| Code   | SAC/HSN   | Rate % |
| ------ | --------- | ------ |
| EXEMPT | _(empty)_ | 0      |
| GST18  | 999312    | 18     |

### 1.4 Number series (bill numbers)

Numbers restart every financial year (April–March) and never repeat.

Choose **Financial year 2026-27**, fill in each row below, and press **Set up** on it.

| Series       | Prefix | Digits | Next number | First number will be |
| ------------ | ------ | ------ | ----------- | -------------------- |
| Bills        | GH26-  | 6      | 1           | GH26-000001          |
| Receipts     | RC26-  | 6      | 1           | RC26-000001          |
| Credit notes | CN26-  | 6      | 1           | CN26-000001          |

> Without the Bills and Receipts series, the counter cannot finalise a bill.

---

## Step 2 — Services (what the hospital charges for)

**Settings → Services.**

- **Group:** a main head, such as OPD or Laboratory.
- **Sub-group:** a section inside a group, such as Laboratory → Biochemistry.
- **Item:** one billable service with its price. Every item sits in a sub-group.

A **code** is permanent and has no spaces. A **name** can be changed later.

Doctor consultation fees are **not** set up here. They have their own page (see 2.3), and they need no group or sub-group; the app files them under **Out-patient Consultation › Consultation** by itself.

### 2.1 Groups — **+ Add group**

| Code | Name             |
| ---- | ---------------- |
| LAB  | Laboratory       |
| CARD | Cardiology Tests |
| PROC | Procedures       |

### 2.2 Sub-groups — select a group, then **+ Subgroup**

| Group            | Code       | Name                          |
| ---------------- | ---------- | ----------------------------- |
| Laboratory       | LAB-BIO    | Biochemistry                  |
| Laboratory       | LAB-HAEM   | Haematology                   |
| Cardiology Tests | CARD-HEART | ECG and Heart                 |
| Procedures       | PROC-DRS   | Dressing and Minor Procedures |

### 2.3 Doctor fees — **Settings → Consultant fees**

All doctor fees are set on the **Consultant fees** page. At the top it has two views: **Fees** (the price grid) and **Not priced** (doctors with no fee yet).

**First, the hospital default fee.** It is charged for any doctor who has no fee of their own.

1. Open **Consultant fees → Not priced**.
2. The first rows are **Hospital default · New** and **Hospital default · Follow Up**. Press **Create item** on each. The name and code are already filled in; type only the price:

| Row                          | Price (₹) |
| ---------------------------- | --------- |
| Hospital default · New       | 800       |
| Hospital default · Follow Up | 500       |

Now every doctor without a fee of their own shows **"Hospital default fee"** under _Billed meanwhile_.

**Then, a doctor who charges a different fee.** In the same list, find the doctor (use **Search doctors without a fee**), press **Create item**, and type the price:

| Row                     | Price (₹) |
| ----------------------- | --------- |
| Your doctor · New       | 1000      |
| Your doctor · Follow Up | 600       |

The list shows 25 doctors per page; use **Next** or the search box to find the rest.

### 2.4 "Not priced" on the Services page — tests

On **Services**, press **Not priced**. It lists the tests the floor can order that have no price yet. (A line at the top links to the Consultant fees page for any doctor fees still missing.)

**Tests without an item.** Press **Create item** on each test. The name and test link are already filled in.

| Test          | Code       | Subgroup      | Price (₹) |
| ------------- | ---------- | ------------- | --------- |
| HbA1c         | LAB-HBA1C  | Biochemistry  | 500       |
| Lipid Profile | LAB-LIPID  | Biochemistry  | 600       |
| CBC           | LAB-CBC    | Haematology   | 200       |
| ECG           | CARD-ECG12 | ECG and Heart | 300       |

### 2.5 An item that can be billed more than once

Select **Dressing and Minor Procedures**, then **+ Add item**:

| Field                       | Sample value     |
| --------------------------- | ---------------- |
| Name                        | Dressing — Small |
| Code                        | PROC-DRS-S       |
| Kind                        | Procedure        |
| Price (₹)                   | 250              |
| Quantity can be more than 1 | ✔ Ticked         |
| Max quantity                | 5                |

**Good to know:**

- To change a price, edit the item. The screen asks for a reason, for example _Reagent cost increased_, and records it under **Price history**.
- An item that has been used on a bill cannot be deleted. It can only be **deactivated**.

---

## Step 3 — Categories (who pays)

**Settings → Categories.**

- **Category:** the type of patient, such as CGHS, ECHS or Senior Citizen. A patient with no category is billed as **General**, so General is never created here.
- **Sub-category:** a type inside a category, such as CGHS → CGHS Paid.
- **Who belongs:** rules that set a patient's category automatically.
- **What the patient pays:** rules that split a price into the patient's share and the part claimed from the payer, such as CGHS.

CGHS, ECHS, Himachal Government, Senior Citizen and Special Discount already exist.

### 3.1 Set up CGHS — select **CGHS**

| Field                          | Sample value    |
| ------------------------------ | --------------- |
| Payer name                     | CGHS Chandigarh |
| Print the category on the bill | ✔ Ticked        |

Press **Save**.

### 3.2 CGHS sub-categories — **+ Sub-category**

| Code           | Label          | Tick these, then Save                                |
| -------------- | -------------- | ---------------------------------------------------- |
| cghs_paid      | CGHS Paid      | Card number required, Print the category on the bill |
| cghs_referral  | CGHS Referral  | Needs a referral, Print the category on the bill     |
| cghs_pensioner | CGHS Pensioner | Card number required, Print the category on the bill |

Leave **Payer name** empty on each sub-category; it uses CGHS's. A CGHS patient must always be billed under one of these three.

### 3.3 Who belongs — open **Senior Citizen**, then **+ Add rule**

| Field          | Sample value     |
| -------------- | ---------------- |
| Rule name      | Age 60 and above |
| From age       | 60               |
| How it applies | Automatic        |

Now every patient aged 60 or over opens at the counter as **Senior Citizen**. The desk can still change it.

### 3.4 What the patient pays — **+ Payment rule**

| Add on         | Rule name                     | Applies to                            | Patient pays            | The rest                     |
| -------------- | ----------------------------- | ------------------------------------- | ----------------------- | ---------------------------- |
| CGHS           | CGHS — patient pays 20%       | The whole category                    | A percent: **20**       | Claimed from CGHS Chandigarh |
| CGHS Paid      | CGHS Paid — consultation ₹200 | A group: **Out-patient Consultation** | A fixed amount: **200** | Claimed from CGHS Chandigarh |
| CGHS Referral  | Referral — nothing to pay     | The whole category                    | Nothing                 | Claimed from CGHS Chandigarh |
| CGHS Pensioner | Pensioner — nothing to pay    | The whole category                    | Nothing                 | Claimed from CGHS Chandigarh |

Leave the dates and priority empty.

**How the rules combine:**

- The most specific rule wins: an item rule beats a sub-group rule, which beats a group rule, which beats a whole-category rule.
- A sub-category's own rule beats its parent's rule.
- Example: a CGHS Paid patient pays ₹200 for a consultation and 20% of everything else.

**Tip:** press **Test this rule** inside the form to preview the patient's share before saving. Nothing is saved by the preview.

---

## Step 4 — Category rates (special prices)

**Settings → Category rates.** Choose **Category: CGHS**, then **Edit** a row and **Save**.

| Item  | Rate (₹) | Bill name                        | Bill code | From  |
| ----- | -------- | -------------------------------- | --------- | ----- |
| HbA1c | 450      | Glycosylated Haemoglobin (HbA1c) | CG101     | today |
| ECG   | 250      | ECG 12 Lead                      | CG201     | today |

CGHS sub-categories use these rates automatically; the screen shows them as **From CGHS**. **History** shows past rates.

---

## Step 5 — Consultant fees

**Settings → Consultant fees → Fees.** One grid holds every doctor's New and Follow-up fee for every category. Click a cell to change it. Use the **search box** (doctor name or code) and the **Doctor** and **Category** filters to find a doctor; the grid shows 25 doctors per page.

Click the consultant's **New** row, **CGHS Paid** column:

| Field            | Sample value            |
| ---------------- | ----------------------- |
| Fee (₹)          | 900                     |
| Patient pays     | An amount (₹): 200      |
| The rest goes to | Claim (CGHS Chandigarh) |
| Bill name        | OPD Consultation — CGHS |
| Bill code        | CG001                   |
| Valid from       | today                   |

**Copy column to…** copies one category's fees to another in one step, for example **CGHS Paid → ECHS**.

---

## Step 6 — Discounts

**Settings → Discounts → + New discount.**

- A **code** discount is typed by the desk.
- An **automatic** discount applies by itself.
- The desk can never type a discount amount by hand.

| Field              | Senior discount        | Health camp coupon                    | Doctor's coupon                       | Camp price               |
| ------------------ | ---------------------- | ------------------------------------- | ------------------------------------- | ------------------------ |
| Name               | Senior citizen 10% off | Health camp ₹50 off                   | Doctor coupon 5%                      | Lipid Profile camp price |
| How it applies     | Code                   | Code                                  | Code                                  | Automatic                |
| Code               | SENIOR10               | CAMP50                                | DOC5                                  | —                        |
| Kind               | Percent off: 10        | Flat ₹ off: 50                        | Percent off: 5                        | Fixed price: 450         |
| Largest discount ₹ | 500                    | —                                     | —                                     | —                        |
| Applies to         | Each line              | The whole bill                        | Each line                             | Each line                |
| Covers             | —                      | —                                     | Doctors: your consultant              | Items: LAB-LIPID         |
| Who gets it        | From age: 60           | —                                     | —                                     | —                        |
| Valid to           | 2026-12-31             | 2026-10-31                            | —                                     | 2026-10-31               |
| Limits             | Uses per day: 50       | Uses in all: 100, Uses per patient: 1 | Uses per doctor per day: 5            | —                        |
| Other              | —                      | Stacks with other discounts ✔         | Who may enter: Reception admin, Admin | —                        |

Leave any field marked — empty. Set **Valid from** to today on every discount.

**Test this rule** (below the list) prices a sample bill without saving anything. For example:

- **Age:** 65
- **Items:** HbA1c and Lipid Profile
- **Codes:** SENIOR10, DOC5
- **Test as role:** Reception

Press **Test**. SENIOR10 applies. DOC5 is refused, because reception may not enter it.

---

## Step 7 — Bulk import (many rows at once)

**Settings → Bulk import.**

1. Press **Download template**. It downloads an Excel file with one sheet per kind of data and a **Read me** sheet.
2. On the **Items** sheet, add rows. For example:

| item_code | name | subgroup_code | base_price | kind | test_name |
| --------- | ---- | ------------- | ---------- | ---- | --------- |
| LAB-TSH   | TSH  | LAB-BIO       | 280        | test | TSH       |
| LAB-CBC   | CBC  | LAB-HAEM      | 240        | test | CBC       |

3. Upload the file. Every row is checked first and sorted into four lists:
   - **Ready:** new rows.
   - **Needs override:** changes to rows that already exist. A change is saved only if you press **Override**.
   - **Failed:** rows with a mistake. The reason is shown, for example _base_price must be a plain number (no ₹ sign, no commas)_.
   - **Unchanged:** rows that already match.
4. Press **Commit**. Only Ready rows and the rows you chose to override are saved.

Amounts are plain numbers, dates are written as 2026-10-01, and an empty cell uses its default value.

---

## Step 8 — Billing counter (daily use)

### 8.1 Start of day — open the cash drawer

Open **Billing Counter → Shift**. Enter **Opening cash: 2000** and press **Open shift**.

Cash can only be taken while a shift is open. Card and UPI payments work without a shift.

### 8.2 Check-in creates the bill

When reception checks a patient in, a **draft bill** opens by itself with the consultation fee on it. Tests the doctor orders are added to the bill automatically.

Press **Bill** on the patient's row at reception to open their bill.

### Case A — General patient, cash payment

1. **Add items:** HbA1c, then Dressing — Small. Change the dressing's **Qty** to **2**.
2. **Discount code:** CAMP50, then **Apply code**.
3. **Payment:** Mode **Cash**, press **Rest**, then **Take payment**.
4. Press **Finalise & print** to get the bill (GH26-000001), then **Print receipt** for the receipt.

### Case B — Senior patient, card + UPI

1. The bill opens as **Senior Citizen** automatically.
2. Add Lipid Profile (the ₹450 camp price applies by itself) and HbA1c.
3. **Discount code:** SENIOR10.
4. **Payment 1:** Card, **500**, Reference **4321**.
5. Press **+ Split payment**. **Payment 2:** UPI, **Rest**, Reference **UPI302611223344**.
6. Press **Take payment**, then **Finalise & print**.

A wrong code is refused with the reason. For example, SENIOR10 on a patient under 60 is refused because of age.

### Case C — CGHS Paid

1. **Category:** CGHS → CGHS Paid.
2. **Card number:** CGHS12345678. Press **Save numbers**, then **Confirm category**.
3. Add HbA1c and ECG. The lines show the CGHS names and codes.
4. **Totals** shows the **Claimed** part, which CGHS pays. Take only the patient's share.
5. Press **Finalise & print**. The bill shows **CGHS pending**.

### Case D — CGHS Referral

1. **Category:** CGHS → CGHS Referral.
2. **Referral number:** REF/CHD/2026/0457. Press **Save numbers**, then **Confirm category**.
3. Add Lipid Profile. There is nothing to pay.
4. Press **Finalise & print**. The bill shows **CGHS pending**.

### Case E — CGHS Pensioner

1. **Category:** CGHS → CGHS Pensioner.
2. **Card number:** CGHS87654321. Press **Save numbers**, then **Confirm category**.
3. Add CBC. There is nothing to pay.
4. Press **Finalise & print**.

### Case F — Pay later

1. Add CBC.
2. Tick **Pay later**, then **Finalise & print**.
3. Later: open the **Dues** tab, press **Take payment**, and collect the amount.

### Case G — Billing the same item twice (needs approval)

1. Add an item that is already on this visit's bill. It shows **Ask admin to bill again**.
2. Enter a reason, for example _Repeat sample — first sample haemolysed_, and press **Send request**.
3. The admin opens **Settings → Desk requests**, presses **Approve**, then **Approve request**.
4. Back at the counter, press **Add to bill** under **My requests**.

### Case H — Item not in the list

1. Search **Nebulisation**. Nothing is found, so press **Request new item**.
2. Fill in **Item name:** Nebulisation, **Group:** Procedures, **Why:** _Doctor advised nebulisation today_.
3. The admin opens **Desk requests** and presses **Create item**.
   - **Code:** PROC-NEB
   - **Subgroup:** Dressing and Minor Procedures
   - **Price:** 300
4. The admin presses **Create item and approve**. The item can now be billed.

### Case I — Cancel an unpaid bill

On a final bill with nothing paid, press **Cancel unpaid bill** and enter a reason, for example _Patient left before paying_. Then press **Start a new bill for this visit** if needed.

### Case J — Second bill on the same visit

A test ordered after a bill is final opens a new draft bill. Press **Open the new draft bill**. Earlier bills stay under **Earlier bills on this visit**, where **Print** reprints them.

### Case K — Lab waits for payment

An ordered test waits at the lab until it is paid. Once the counter takes the payment, the lab can start the test.

CGHS Referral and Pensioner tests are released when the bill is finalised, because CGHS pays for them.

### 8.3 End of day — close the cash drawer

Open the **Shift** tab. Enter the **Counted cash** and press **Close shift**.

The screen shows the expected cash, the counted cash and any difference.

---

## Step 9 — CGHS register (claims from CGHS)

**Menu → CGHS register** (Admin or Reception Admin).

Every CGHS bill stays **Pending** until CGHS pays the hospital.

1. On the **Pending** tab, tick the bills that CGHS paid for, then press **Clear selected**.
2. Fill in the payment:

| Field               | Sample value                            |
| ------------------- | --------------------------------------- |
| Date received       | today                                   |
| Reference (UTR)     | UTR2026092500123                        |
| Amount received (₹) | _(already filled with the total claim)_ |
| Note                | CGHS September batch                    |

3. The screen confirms _The amount matches the selected claims_. Press **Save**.
4. At the counter, those bills now show **Cleared on** and the date.

If the amount does not match, the register shows the difference and **Save** stays off.

An Admin can **Undo** a wrong entry from the **Cleared** tab. The **Print pending list** and **Export (.xlsx)** buttons give the lists for CGHS follow-up.

---

## Step 10 — Billing reports

**Menu → Billing Reports.** Choose the dates, then open a tab. **Download Excel** saves every tab.

| Report                                     | Shows                                      |
| ------------------------------------------ | ------------------------------------------ |
| Revenue by service / consultant / category | Earnings split each way                    |
| Collections                                | Cash, card and UPI, by user, shift and day |
| Dues                                       | Bills still unpaid                         |
| Discounts                                  | Every discount and coupon given            |
| CGHS receivables                           | What CGHS still owes, and for how long     |
| Coupon usage                               | How often each code was used               |
| Cancellations                              | Cancelled bills and the reasons            |
| Desk requests                              | Bill-again and new-item requests           |

---

## Coming next

- **Refunds and credit notes** at the counter. Until then, a paid bill cannot be cancelled.
- **GST on bills.** It is ready, and is switched on in Billing settings when the hospital needs it.
