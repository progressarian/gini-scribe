# 99 — Membership cards

Status: **built 27 Nov 2026**.

## Plans (admin)

Settings → **Membership plans** (`BILLING_MASTER`). A plan has a code, name, price, number of
consultations, number of dietitian visits and a lab discount %. Saving a plan maintains:

- a sale service item `MEM-<code>` under group **Membership** › subgroup **Consultant**
  (seeded by `2027-02-03_memberships.sql`), so the sale shows in every group-based revenue view;
- a hidden automatic discount rule (`discount_rules.membership_plan_id`, `tests_only`) for the lab
  discount. It is not listed or editable under Discounts; it is recorded in
  `bill_line_discounts` like any automatic discount, so the Discounts report counts it.

The same page sets the **dietitian service** (`billing_settings.membership_dietitian_item_id`).

## Selling (reception)

On any bill, **Membership → Sell a membership card** adds the plan's sale line. When the bill is
made final a card `MEM-000001…` is created in that patient's name (`membershipCards.js`
`syncMemberships`). Cards have no expiry date.

## Using a card

Any patient's bill can use any card (**Use someone else's card** searches card no., holder name,
UHID or phone). With a card on the bill:

| Line                                   | Effect                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Consultation (`kind = 'consultation'`) | ₹0 while consultations are left (`membership_benefit = 'consultation'`)                                                |
| The dietitian service                  | ₹0 while dietitian visits are left                                                                                     |
| Tests                                  | Plan's lab discount while consultations are left, **and on the day the last consultation was used**; not on later days |

Uses are recorded in `membership_card_uses` when the bill is made final (or an edit is saved),
under a row lock on the card, so two counters can't overdraw it. Cancelling the bill, refunding
the line, or removing it in a bill edit gives the use back. Reception can also mark a dietitian
visit used on the card itself (Memberships desk tab) and give a manual use back with a reason.

## Revenue

Sale lines are group `MEMBERSHIP` / subgroup `MEMBERSHIP-CONS`: they appear as their own MIS
column and in revenue by item. Revenue by consultant counts them as consultation revenue and
shows an "of which Membership" column (`reports.js`, `dashboardCharges.js` `LINE_KIND`).

## Tests

`e2e/billing/edit/E2-membership-cards.spec.js`, `E3-edit-and-membership-screens.spec.js`.
