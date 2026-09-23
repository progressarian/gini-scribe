import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, refused, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
let ids;

test.describe.serial("P4-06 open or create a draft bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await query(`UPDATE patients SET scheme_code = $2 WHERE id = $1`, [ids.patient, ids.paid]);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. it creates a draft with the category, the payer and the age on the bill date", async () => {
    const draft = await bills.openDraft(ids.visit, desk, db);
    ids.bill = draft.id;
    expect(draft.status).toBe("draft");
    expect(draft.bill_no).toBeNull();
    expect(draft.visit_id).toBe(ids.visit);
    expect(draft.patient_id).toBe(ids.patient);
    expect(draft.appointment_id).toBe(ids.appointment);
    expect(draft.bill_date).toBe(ids.day);
    expect(draft.category).toBe(ids.paid);
    expect(draft.category_label).toBe(`P4 CGHS ${tag} › Paid`);
    expect(draft.payer_name).toBe(`CGHS ${tag}`);
    expect(draft.patient_age).toBe(55);
    expect(draft.lines).toEqual([]);
    expect(draft.totals.payable).toBe(0);
  });

  test("2. calling it twice returns the same draft", async () => {
    const again = await bills.openDraft(ids.visit, desk, db);
    expect(again.id).toBe(ids.bill);
    const { count } = await one(`SELECT COUNT(*)::int AS count FROM bills WHERE visit_id = $1`, [
      ids.visit,
    ]);
    expect(count).toBe(1);
  });

  test("3. two desks opening it at the same moment still get one draft", async () => {
    await query(`DELETE FROM bills WHERE id = $1`, [ids.bill]);
    const deskA = await db.connect();
    const deskB = await db.connect();
    let first;
    let second;
    try {
      await deskA.query("BEGIN");
      await deskB.query("BEGIN");
      first = await bills.openDraftIn(deskA, ids.visit, desk);
      const waiting = bills.openDraftIn(deskB, ids.visit, desk);
      await new Promise((settle) => setTimeout(settle, 300));
      await deskA.query("COMMIT");
      second = await waiting;
      await deskB.query("COMMIT");
    } finally {
      deskA.release();
      deskB.release();
    }
    expect(second.id).toBe(first.id);
    ids.bill = first.id;
    const { count } = await one(`SELECT COUNT(*)::int AS count FROM bills WHERE visit_id = $1`, [
      ids.visit,
    ]);
    expect(count).toBe(1);
  });

  test("4. the payer name falls back to the parent category", async () => {
    const { payer_name: payer } = await one(`SELECT payer_name FROM bills WHERE id = $1`, [
      ids.bill,
    ]);
    expect(payer).toBe(`CGHS ${tag}`);
    await query(`UPDATE patient_schemes SET payer_name = 'Own payer' WHERE code = $1`, [ids.paid]);
    await query(`DELETE FROM bills WHERE id = $1`, [ids.bill]);
    const draft = await bills.openDraft(ids.visit, desk, db);
    ids.bill = draft.id;
    expect(draft.payer_name).toBe("Own payer");
    await query(`UPDATE patient_schemes SET payer_name = NULL WHERE code = $1`, [ids.paid]);
  });

  test("5. a bare parent category leaves the bill asking for a sub-category", async () => {
    await query(`DELETE FROM bills WHERE id = $1`, [ids.bill]);
    await query(`UPDATE patients SET scheme_code = $2 WHERE id = $1`, [ids.patient, ids.parent]);
    const draft = await bills.openDraft(ids.visit, desk, db);
    ids.bill = draft.id;
    expect(draft.category).toBeNull();
    expect(draft.needs_category).toBe(true);
    expect(draft.suggestions.map((s) => s.category.code).sort()).toEqual(
      [ids.paid, ids.pensioner, ids.referral].sort(),
    );
    await query(`UPDATE patients SET scheme_code = $2 WHERE id = $1`, [ids.patient, ids.paid]);
  });

  test("6. a draft opens beside a final bill, and an unknown visit is refused", async () => {
    await refused(
      bills.openDraft("11111111-1111-1111-1111-111111111111", desk, db),
      404,
      /visit/i,
      "an unknown visit",
    );
    await refused(bills.openDraft("not-a-visit", desk, db), 400, /valid visit/i, "a bad visit id");
    await query(
      `UPDATE bills SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'test'
        WHERE id = $1`,
      [ids.bill],
    );
    const fresh = await bills.openDraft(ids.visit, desk, db);
    expect(fresh.id).not.toBe(ids.bill);
    expect(fresh.status).toBe("draft");
  });

  test("7. creating the draft is audited", async () => {
    const { rows } = await query(
      `SELECT action, actor_id FROM billing_audit
        WHERE entity = 'bills' AND entity_id = $1 ORDER BY id`,
      [ids.bill],
    );
    expect(rows[0]).toMatchObject({ action: "create", actor_id: desk.actorId });
  });
});
