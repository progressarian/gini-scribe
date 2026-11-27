import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, refused, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const billEdit = await import("../../../server/services/billing/billEdit.js");
const plans = await import("../../../server/services/billing/membershipPlans.js");
const cards = await import("../../../server/services/billing/membershipCards.js");
const discounts = await import("../../../server/services/billing/discountRules.js");
const billPdf = await import("../../../server/services/billing/billPdf.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.7.1", role: "admin" };
let ids;
let plan;
let card;
const finals = {};

const lineOf = (bill, itemId) => bill.lines.find((line) => line.service_item_id === itemId);

async function draftFor(visit, items) {
  const draft = await bills.openDraft(visit, desk, db);
  for (const line of draft.lines) await bills.removeLine(draft.id, line.id, {}, desk, db);
  let current = draft;
  for (const item of items) current = await bills.addLine(draft.id, { item_id: item }, desk, db);
  return current;
}

const pay = async (bill) => {
  await bills.clearHealthrayAndFinalise(
    bill.id,
    { version: bill.version, paid: { mode: "cash" } },
    desk,
    db,
  );
  return bills.readBill(bill.id, db);
};

const cardRow = () =>
  one(`SELECT consult_left, dietitian_left, status FROM membership_cards WHERE id = $1`, [card.id]);

test.describe.serial("E2 membership cards", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    ids.family = await extraVisit(ids, "Fam");
    ids.friend = await extraVisit(ids, "Friend");
    ids.late = await extraVisit(ids, "Late");
  });

  test.afterAll(async () => {
    await query(`UPDATE billing_settings SET membership_dietitian_item_id = NULL`);
    if (plan) {
      await query(
        `UPDATE bills SET membership_card_id = NULL WHERE membership_card_id IN
                     (SELECT id FROM membership_cards WHERE plan_id = $1)`,
        [plan.id],
      );
      await query(
        `DELETE FROM membership_card_uses WHERE card_id IN
                     (SELECT id FROM membership_cards WHERE plan_id = $1)`,
        [plan.id],
      );
      await query(`DELETE FROM membership_cards WHERE plan_id = $1`, [plan.id]);
    }
    await query(
      `UPDATE bills SET edit_started_at = NULL, edit_snapshot = NULL
                  WHERE visit_id = ANY($1)`,
      [[ids.visit, ids.family.visit, ids.friend.visit, ids.late.visit]],
    );
    const sale = plan?.service_item_id ?? null;
    await tearDown(ids);
    if (plan) {
      await query(
        `DELETE FROM bill_line_discounts WHERE rule_id IN
                     (SELECT id FROM discount_rules WHERE membership_plan_id = $1)`,
        [plan.id],
      );
      await query(`DELETE FROM discount_rules WHERE membership_plan_id = $1`, [plan.id]);
      await query(`DELETE FROM membership_plans WHERE id = $1`, [plan.id]);
      await query(`DELETE FROM bill_lines WHERE service_item_id = $1`, [sale]);
      await query(`DELETE FROM service_items WHERE id = $1`, [sale]);
    }
  });

  test("1. an admin plan makes a Membership › Consultant service and a hidden lab discount", async () => {
    plan = await plans.createPlan(
      {
        code: `G${tag}`.toUpperCase(),
        name: `Gold ${tag}`,
        price: 5000,
        consult_count: 2,
        dietitian_count: 1,
        lab_discount_pct: 15,
        lab_excludes_outsourced: false,
      },
      admin,
      db,
    );
    const item = await one(
      `SELECT g.code AS group_code, s.code AS subgroup_code, i.base_price::float AS price
         FROM service_items i JOIN service_subgroups s ON s.id = i.subgroup_id
         JOIN service_groups g ON g.id = s.group_id WHERE i.id = $1`,
      [plan.service_item_id],
    );
    expect(item).toEqual({
      group_code: "MEMBERSHIP",
      subgroup_code: "MEMBERSHIP-CONS",
      price: 5000,
    });
    const listed = await discounts.listDiscountRules({}, db);
    expect(listed.some((rule) => rule.membership_plan_id === plan.id)).toBe(false);
    const rule = await one(`SELECT id FROM discount_rules WHERE membership_plan_id = $1`, [
      plan.id,
    ]);
    await refused(
      discounts.updateDiscountRule(rule.id, { value: 50 }, admin, db),
      409,
      /Membership plans/,
      "editing a membership discount from Discounts",
    );
  });

  test("2. selling the plan on a bill creates the card when the bill is final", async () => {
    const draft = await draftFor(ids.visit, [plan.service_item_id]);
    expect(draft.totals.payable).toBe(500000);
    finals.sale = await pay(draft);
    const sold = await cards.cardsOfPatient(ids.patient, db);
    expect(sold).toHaveLength(1);
    card = sold[0];
    expect(card).toMatchObject({ consult_left: 2, dietitian_left: 1, status: "active" });
    expect(card.card_no).toMatch(/^MEM-\d{6}$/);
    expect(lineOf(finals.sale, plan.service_item_id).group_code).toBe("MEMBERSHIP");
  });

  test("3. a family member uses the card: the consultation is free and the lab is 15% off", async () => {
    const draft = await draftFor(ids.family.visit, [ids.consultNew, ids.hba1c]);
    const applied = await bills.setMembershipCard(draft.id, { card_id: card.id }, desk, db);
    expect(lineOf(applied, ids.consultNew).patient_payable).toBe(0);
    expect(lineOf(applied, ids.consultNew).membership_benefit).toBe("consultation");
    expect(lineOf(applied, ids.hba1c).patient_payable).toBe(21250);
    finals.family = await pay(applied);
    expect(await cardRow()).toMatchObject({ consult_left: 1, status: "active" });
    const use = await one(
      `SELECT patient_id, kind, source FROM membership_card_uses WHERE bill_id = $1`,
      [finals.family.id],
    );
    expect(use).toEqual({ patient_id: ids.family.patient, kind: "consultation", source: "bill" });
  });

  test("4. after the last consultation is used today, the lab discount still applies today", async () => {
    const friend = await draftFor(ids.friend.visit, [ids.consultNew, ids.dressing]);
    const applied = await bills.setMembershipCard(friend.id, { card_id: card.id }, desk, db);
    finals.friend = await pay(applied);
    expect(await cardRow()).toMatchObject({ consult_left: 0, dietitian_left: 1 });

    const late = await draftFor(ids.late.visit, [ids.consultNew, ids.hba1c]);
    const today = await bills.setMembershipCard(late.id, { card_id: card.id }, desk, db);
    expect(lineOf(today, ids.consultNew).patient_payable).toBe(150000);
    expect(lineOf(today, ids.hba1c).patient_payable).toBe(21250);
    ids.lateBill = today.id;
  });

  test("5. on a later day with no consultations left, the lab discount stops", async () => {
    await query(
      `UPDATE membership_card_uses SET used_on = used_on - 1 WHERE card_id = $1 AND kind = 'consultation'`,
      [card.id],
    );
    await bills.setMembershipCard(ids.lateBill, { card_id: null }, desk, db);
    const again = await bills.setMembershipCard(ids.lateBill, { card_id: card.id }, desk, db);
    expect(lineOf(again, ids.hba1c).patient_payable).toBe(25000);
    await query(
      `UPDATE membership_card_uses SET used_on = used_on + 1 WHERE card_id = $1 AND kind = 'consultation'`,
      [card.id],
    );
  });

  test("6. a dietitian line is covered, and a manual dietitian use can be reversed", async () => {
    await plans.setMembershipSettings({ dietitian_item_id: ids.brace }, admin, db);
    const withDiet = await bills.addLine(ids.lateBill, { item_id: ids.brace }, desk, db);
    expect(lineOf(withDiet, ids.brace).patient_payable).toBe(0);
    expect(lineOf(withDiet, ids.brace).membership_benefit).toBe("dietitian");
    await bills.removeLine(ids.lateBill, lineOf(withDiet, ids.brace).id, {}, desk, db);

    const used = await cards.useDietitianManually(
      card.id,
      { patient_id: ids.late.patient, note: "Diet review at the desk" },
      desk,
      db,
    );
    expect(used).toMatchObject({ dietitian_left: 0, status: "exhausted" });
    await refused(
      cards.useDietitianManually(card.id, { patient_id: ids.late.patient, note: "x" }, desk, db),
      409,
      /no dietitian visits left/,
      "a second dietitian visit",
    );
    const manual = used.uses.find((use) => use.source === "manual");
    const back = await cards.reverseUse(manual.id, { reason: "Entered by mistake" }, desk, db);
    expect(back).toMatchObject({ dietitian_left: 1, status: "active" });
  });

  test("7. removing a covered consultation in a bill edit gives it back to the card", async () => {
    const started = await billEdit.startEdit(
      finals.friend.id,
      { version: finals.friend.version },
      desk,
      db,
    );
    const removed = await bills.removeLine(
      finals.friend.id,
      lineOf(started, ids.consultNew).id,
      {},
      desk,
      db,
    );
    expect(removed.totals.payable).toBe(50000);
    await billEdit.saveEdit(
      finals.friend.id,
      { version: removed.version, reason: "Consultation was not given" },
      desk,
      db,
    );
    expect((await cardRow()).consult_left).toBe(1);
    const reversed = await one(
      `SELECT count(*)::int AS n FROM membership_card_uses
        WHERE bill_id = $1 AND reversed_at IS NOT NULL`,
      [finals.friend.id],
    );
    expect(reversed.n).toBe(1);
  });

  test("8. search finds the card by number and masks the phone", async () => {
    const found = await cards.searchCards({ q: card.card_no }, db);
    expect(found.map((row) => row.id)).toContain(card.id);
    const detail = await cards.cardDetail(card.id, db);
    expect(detail.uses.some((use) => !use.by_holder)).toBe(true);
    expect(detail.holder.phone === null || detail.holder.phone.startsWith("••")).toBe(true);
  });

  test("9. the printed bill shows the card and what is left on it", async () => {
    const view = await billPdf.billView(finals.family.id, db);
    const html = billPdf.membershipHtml(view);
    expect(html).toContain(card.card_no);
    expect(html).toContain("consultation");
  });

  test("10. a sold card that has been used can't lose its sale line", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE bill_lines SET is_live = FALSE WHERE bill_id = $1`, [
        finals.sale.id,
      ]);
      await refused(
        cards.syncMemberships(client, finals.sale.id, desk),
        409,
        /already been used/,
        "dropping a used card's sale",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
