# Categories, sub-categories and payment rules — explained with CGHS

Open it from **Settings → Categories**. Reception admins and admins can use this page. Only an
**admin** can change the **Patients per day** limit.

This guide uses the **CGHS setup that is live today (12 Oct 2026)** as the example, then lists every
field (required or not, when it shows) and ends with a test checklist.

---

## 1. The three ideas

| Idea                                      | What it answers                                                                             | Where it lives               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------- |
| **Category**                              | "Which group/scheme is this patient under?" — CGHS, ECHS, Senior Citizen…                   | The tree on the left         |
| **Sub-category**                          | "Which kind of CGHS patient?" — Paid, Pensioner, Referral. Only one level below a category. | Under a category in the tree |
| **Who belongs** (category rules)          | "Can the system suggest/apply this category on its own?" — by age, gender, card             | Middle card on the right     |
| **What the patient pays** (payment rules) | "Of the price, how much does the patient pay and who covers the rest?"                      | Bottom card on the right     |
| **Category rates** (separate page)        | "What is the price of each item for this category?" — e.g. CGHS rate list                   | Settings → Category rates    |

A patient with **no category** is **General**: normal price, the patient pays everything. You
cannot create a category called "general" — that name is kept for patients with no category.

---

## 2. CGHS as configured today

### The tree

- **CGHS** — blue, payer **CGHS Chandigarh**, category printed on the bill
  - **CGHS Paid** — card number required
  - **CGHS Pensioner** — card number required
  - **CGHS Referral** — needs a referral number

- **CGHS itself can't be billed.** Once a category has sub-categories, the counter must pick one
  of them ("That category has sub-categories — choose one").
- The sub-categories have **no payer name of their own**, so they use the parent's: **CGHS
  Chandigarh**. That is who the "rest" is claimed from.
- **Who belongs:** no rules for CGHS → nothing is suggested automatically; the desk picks the
  category by hand.

### Prices (Category rates)

CGHS has **80 item rates**. Sub-categories have none of their own, so they **inherit CGHS's**:

| Item                                              | Base price (General) | CGHS rate | Bill code |
| ------------------------------------------------- | -------------------- | --------- | --------- |
| Consultation — Dr Anil Bhansali (Follow Up / New) | ₹1,500               | ₹700      | CN003     |
| HbA1c                                             | ₹350                 | ₹270      | LB122     |
| Lipid profile                                     | ₹450                 | ₹441      | LB125     |
| Creatinine                                        | ₹100                 | ₹90       | LB058     |
| ECG                                               | ₹200                 | ₹158      | CI001     |

### Payment rules

| Category       | Rule                          | Applies to              | Patient pays | The rest                     |
| -------------- | ----------------------------- | ----------------------- | ------------ | ---------------------------- |
| CGHS (parent)  | CGHS — patient pays 20%       | All services            | 20%          | Claimed from CGHS Chandigarh |
| CGHS Paid      | CGHS Paid — consultation ₹200 | Subgroup _Consultation_ | ₹200         | Claimed                      |
| CGHS Pensioner | Pensioner — nothing to pay    | All services            | Nothing      | Claimed                      |
| CGHS Referral  | Referral — nothing to pay     | All services            | Nothing      | Claimed                      |

### Worked example — one visit: Follow-up consultation + HbA1c + Lipid profile

How each line is priced: **(1) rate** → **(2) payment rule** → split into _patient pays_ + _claim_.

**General patient** (no category): base prices, no rule.

| Line         | Rate   | Patient pays | Claim |
| ------------ | ------ | ------------ | ----- |
| Consultation | ₹1,500 | ₹1,500       | —     |
| HbA1c        | ₹350   | ₹350         | —     |
| Lipid        | ₹450   | ₹450         | —     |
| **Total**    |        | **₹2,300**   |       |

**CGHS Paid**: CGHS rates; consultation hits CGHS Paid's own ₹200 rule; tests have no CGHS Paid
rule, so they fall back to the **parent's 20%** rule.

| Line         | Rate   | Rule used                     | Patient pays       | Claim (CGHS Chandigarh) |
| ------------ | ------ | ----------------------------- | ------------------ | ----------------------- |
| Consultation | ₹700   | CGHS Paid — consultation ₹200 | ₹200               | ₹500                    |
| HbA1c        | ₹270   | CGHS — 20% (inherited)        | ₹54                | ₹216                    |
| Lipid        | ₹441   | CGHS — 20% (inherited)        | ₹88.20             | ₹352.80                 |
| **Total**    | ₹1,411 |                               | **₹342** (rounded) | **₹1,068.80**           |

**CGHS Pensioner** / **CGHS Referral**: own "nothing to pay" rule on all services beats the parent's
20% → patient ₹0, claim ₹1,411. Referral bills **can't be finalised without the referral number**.

### Things in today's setup worth tidying

1. ~~CGHS Paid had two ₹200 consultation rules~~ — the redundant item rule for Dr Bhansali (New)
   was deleted on 12 Oct 2026; the subgroup rule covers every consultation.
2. **3 patients are recorded as plain "CGHS"** (the parent). At the counter they will be asked to
   choose Paid / Pensioner / Referral every time — set the right sub-category on the patient.
3. **"Card number required" is not checked at finalise** — it shows the card field and stops an
   _automatic_ rule without a card, but a CGHS Paid / Pensioner bill can still be finalised
   without a card number. Decide whether that should be enforced.
4. Two **old CGHS price lists** from the earlier setup (test prices such as CBC ₹100, and an OPD
   fee of ₹150) are **no longer used** by billing — the **Category rates** page replaced them.
   Changing them has no effect.

---

## 3. How a patient gets a category

In this order — the first that applies wins:

1. **The appointment's category** (set when booking).
2. **The patient's recorded category** (patient profile). A recorded category always beats rules.
   If it's a parent with sub-categories → the desk must choose a sub-category.
3. **Who-belongs rules**, checked by priority (smaller first): the first matching **Automatic** rule
   is applied; **Suggest** rules show as one-tap suggestions at the counter. An automatic rule on
   a category that needs a card only applies if the patient has a card number.
4. Nothing matches → **General**.

At the counter the desk can always change it: **Category** select → **Confirm category**. Card and
referral numbers entered there are stored securely and shown with only the last four digits
(for example XXXX1234). Confirming at
the counter changes **this bill only**, not the patient's profile.

### What a sub-category takes from its parent

| Setting                                                       | Inherited?                                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Payer name                                                    | Yes, when the sub-category's is empty                                                                |
| Pay later                                                     | Yes, when the sub-category says "Follow the billing setting"                                         |
| Card required / Needs a referral / Needs the referral scanned | Yes — either one ticked means required                                                               |
| Print category on bill                                        | Yes                                                                                                  |
| Category rates, bill names, bill codes                        | Yes, when the sub-category has none for that item                                                    |
| Payment rules                                                 | Yes — the sub-category's own rules are checked first                                                 |
| Discount rules aimed at the parent                            | Yes                                                                                                  |
| Patients per day                                              | The parent's limit counts all its sub-categories together; a sub-category's own limit must also pass |
| Who-belongs rules, colour, label                              | **No** — each sub-category has its own                                                               |

---

## 4. Which payment rule wins

For each bill line, the system looks at active rules of the sub-category **and** its parent that
are valid on the bill date and match the visit type, then picks:

1. **The sub-category's own rules before the parent's** — even a sub-category's "All services" rule
   beats the parent's item rule.
2. Then the **most specific scope**: one item → one subgroup → one group → all services.
3. Then the **smaller priority number** (blank = 100).
4. No rule at all → patient pays the **full** price.

Then: line discounts → tax → split (_patient pays_ vs _claim_/_adjustment_) → bill-level packages and
discounts → total rounded to the rupee. Discounts reach a payment-rule line only if the discount is
marked "Also on payment-rule lines", and then only reduce what the patient pays — never the claim.

**Patient pays** options:

| Option             | Patient pays                                     | The rest                       |
| ------------------ | ------------------------------------------------ | ------------------------------ |
| Full price         | Everything                                       | — (no "rest")                  |
| A fixed amount (₹) | That amount × quantity, never more than the line | Claimed or adjusted            |
| A percent          | That % of the line (incl. tax)                   | Claimed or adjusted            |
| Nothing            | ₹0                                               | Whole line claimed or adjusted |

**The rest**: **Claimed from <payer>** (needs a payer name on the category or its parent) or
**Adjustment — the hospital absorbs it** (no payer needed, e.g. Senior Citizen discount).

---

## 5. Every field — required, optional, when it shows

### Add category / Add sub-category

| Field | Required | Rules                                                                                                                                                                                 | Notes                                |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Code  | Yes      | 2 to 32 characters: small letters, numbers and underscore only (capitals become small letters, other characters are dropped as you type); cannot be "general"; must not already exist | **Permanent** — can never be renamed |
| Label | Yes      | Max 200; unique (ignoring case) under the same parent                                                                                                                                 | Can be changed later                 |

"+ Sub-category" appears only under an **active top-level** category (two levels max). The parent
must be active.

### Category details (category and sub-category)

| Field                          | Required          | Empty means                                                          | Shown / editable                                   |
| ------------------------------ | ----------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| Label                          | Yes               | —                                                                    | Always                                             |
| Colour                         | No (default gray) | gray                                                                 | Always                                             |
| Patients per day               | No                | No limit (0 = no patients that day)                                  | Editable by **admin only**                         |
| Payer name                     | No                | No payer → "claim" rules not allowed; sub-category: use the parent's | Always                                             |
| Pay later                      | No                | "Follow the billing setting" (sub-category: parent's choice first)   | Always                                             |
| Card number required           | No                | Off                                                                  | Always                                             |
| Needs a referral               | No                | Off                                                                  | Always — when on, finalise needs a referral number |
| Needs the referral scanned     | No                | Off                                                                  | Always — when on, finalise needs the scan          |
| Print the category on the bill | No                | Off                                                                  | Always                                             |

Buttons: **Save** (enabled only after a change), **Retire / Bring back** (a parent can't be retired
while it has active sub-categories), **Delete** (refused if the category is used anywhere — then
offered **Retire** instead).

### Who belongs (category rules)

Not available on a parent that has sub-categories (existing ones can be **Moved** to a
sub-category).

| Field             | Required              | Rules                                                           |
| ----------------- | --------------------- | --------------------------------------------------------------- |
| Rule name         | Yes                   | Unique per category                                             |
| From age / To age | No                    | 0–150, From ≤ To. Empty = any                                   |
| Gender            | No                    | Any / Male / Female / Other                                     |
| Has a card        | No                    | Patient must have a card number                                 |
| How it applies    | Yes (default Suggest) | **Suggest** — desk confirms; **Automatic** — applied on its own |
| Priority          | No (blank = 100)      | Smaller is checked first                                        |

At least **one condition** (age, gender or card) is required. An **Automatic** rule on a category
that requires a card must tick **Has a card**.

### What the patient pays (payment rules)

| Field                   | Required                                               | Shows when                           | Rules / messages                                                                                      |
| ----------------------- | ------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Rule name               | Yes                                                    | Always                               | "Give the rule a name"; unique per category                                                           |
| Applies to              | Yes (default All services)                             | Always                               | All services / One group / One subgroup / One item                                                    |
| Group / Subgroup / Item | Yes, for that choice                                   | Applies to = group / subgroup / item | "Choose the group/subgroup/item the rule is for"                                                      |
| Visit types             | No                                                     | Always                               | None ticked = every visit. New / Follow Up / Investigation                                            |
| Patient pays            | Yes (default A fixed amount)                           | Always                               | Full / Amount / Percent / Nothing                                                                     |
| Amount (₹)              | Yes, for Amount                                        | Patient pays = Amount                | Max 2 decimals; **can't exceed the price of any item it covers** (refused, listing the cheaper items) |
| Percent (%)             | Yes, for Percent                                       | Patient pays = Percent               | 0–100                                                                                                 |
| The rest                | Yes (default Claim if a payer exists, else Adjustment) | Hidden for Full price                | Claim needs a payer name on the category or parent                                                    |
| From                    | No                                                     | Always                               | Blank = today                                                                                         |
| To                      | No                                                     | Always                               | Blank = no end; can't be before From                                                                  |
| Priority                | No (blank = 100)                                       | Always                               | Smaller wins at the same level                                                                        |

On a sub-category, the parent's rules show read-only as **"From CGHS — inherited"** (change them on
CGHS). **Test this rule** previews a split for an item and visit type without saving.

Lowering an item's base price or a category rate **below an active fixed-amount rule** is refused
("This price is too low for a payment rule…").

---

## 6. Test checklist

Use a **test category** (for example "Test CGHS" with its own sub-categories) so real patients and
real CGHS settings are not affected. Delete or retire it when testing is finished.

### Categories

| #   | Do                                                          | Expect                                                           |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| C1  | Add a category and type the code "Test CGHS!"               | It becomes "testcghs" (small letters, symbols dropped)           |
| C2  | Add a category with the code "general"                      | Refused: that name is reserved                                   |
| C3  | Add two sub-categories with the same label under one parent | Second refused (label must be unique)                            |
| C4  | Try "+ Sub-category" on a sub-category                      | Button not offered (two levels only)                             |
| C5  | Edit label, save; try to change the code                    | Label saves; code has no edit field                              |
| C6  | As reception admin, change Patients per day                 | Read-only "Only an admin can change this"; as admin it saves     |
| C7  | Sub-category with empty payer name                          | Placeholder "Same as CGHS: CGHS Chandigarh"; claim rules allowed |
| C8  | Clear the parent's payer name while a claim rule exists     | Refused (claim needs a payer)                                    |
| C9  | Retire a parent with active sub-categories                  | Refused; retire the sub-categories first                         |
| C10 | Delete a category used on a bill                            | Refused, offered Retire                                          |
| C11 | Edit fields, click another category                         | "Discard your changes…?" Keep editing / Discard                  |

### Who belongs

| #   | Do                                                                    | Expect                                                              |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| W1  | Rule with no age, gender or card                                      | Refused: needs at least one condition                               |
| W2  | From age 70, To age 60                                                | Refused (From ≤ To)                                                 |
| W3  | Senior Citizen: Automatic, age ≥ 60                                   | A 65-year-old General patient's new bill comes in as Senior Citizen |
| W4  | Same rule as Suggest                                                  | Counter shows a one-tap suggestion instead                          |
| W5  | Automatic rule on a card-required category without "Has a card"       | Refused                                                             |
| W6  | Add a rule on CGHS (has sub-categories)                               | No form; "Put rules on a sub-category"                              |
| W7  | Patient recorded as CGHS Paid and matching a Senior Citizen auto rule | Recorded CGHS Paid wins                                             |

### Payment rules (use CGHS numbers from §2)

| #   | Do                                                               | Expect                                                     |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| P1  | CGHS Paid patient, follow-up consult                             | Rate ₹700, patient ₹200, claim ₹500                        |
| P2  | CGHS Paid patient, HbA1c                                         | Rate ₹270, parent 20% → patient ₹54, claim ₹216            |
| P3  | Pensioner patient, any line                                      | Patient ₹0, claim = full CGHS rate                         |
| P4  | Referral bill without referral number → Finalise                 | Refused until the number is entered                        |
| P5  | Amount rule ₹500 on Creatinine (CGHS rate ₹90)                   | Refused, listing Creatinine as cheaper                     |
| P6  | Percent 120                                                      | Refused (0–100)                                            |
| P7  | Claim rule on a category with no payer (own or parent)           | Refused                                                    |
| P8  | Two rules same level, priority 50 and 100                        | Priority 50 used                                           |
| P9  | Item rule on CGHS (parent) + all-services rule on CGHS Paid      | CGHS Paid's own rule wins                                  |
| P10 | Rule with Visit types = Follow Up only, New visit                | Rule not used                                              |
| P11 | Rule From = tomorrow                                             | Not used today                                             |
| P12 | Patient pays = Full price                                        | "The rest" field disappears                                |
| P13 | Lower CGHS's HbA1c rate below an active ₹ rule covering it       | Refused: price too low for a payment rule                  |
| P14 | Test this rule: pick HbA1c, Follow Up                            | Shows split with and without the draft rule; nothing saved |
| P15 | Discount marked "Also on payment-rule lines" on a CGHS Paid bill | Only the patient's share drops; claim unchanged            |

### At the counter

| #   | Do                                               | Expect                                                       |
| --- | ------------------------------------------------ | ------------------------------------------------------------ |
| K1  | Open a bill for a patient recorded as plain CGHS | "Choose a sub-category" buttons; can't finalise until chosen |
| K2  | Confirm CGHS Paid, enter card 1234567890         | Saved, shown as XXXX7890; bill repriced                      |
| K3  | Print a CGHS bill                                | Category printed (Print on bill inherited)                   |
| K4  | Pay later on a CGHS bill                         | Follows category → parent → billing setting                  |
