import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  extraVisit,
  newTag,
  payRule,
  refused,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
let ids;

const pay = (billId, amount) =>
  query(`INSERT INTO payments (bill_id, mode, amount, received_by) VALUES ($1, 'cash', $2, $3)`, [
    billId,
    (amount / 100).toFixed(2),
    USERS.reception.id,
  ]);

async function finalBill(label, { category = null, item = null, paid = true } = {}) {
  const { visit } = await extraVisit(ids, label);
  const draft = await bills.openDraft(visit, desk, db);
  await bills.addLine(draft.id, { item_id: item ?? ids.dressing }, desk, db);
  const ready = category
    ? await bills.setCategory(draft.id, { category }, desk, db)
    : await bills.readBill(draft.id, db);
  if (paid && ready.totals.payable > 0) await pay(draft.id, ready.totals.payable);
  const bill = await bills.finaliseBill(
    draft.id,
    { version: ready.version, pay_later: !paid },
    desk,
    db,
  );
  return { visit, bill };
}

test.describe.serial("P4-14 cancel an unpaid bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.paid, { name: "claimed everything", patient_pays: "nothing" });
    await query(`UPDATE patient_schemes SET allow_pay_later = TRUE WHERE code = $1`, [
      ids.pensioner,
    ]);
    await payRule(ids, ids.pensioner, { name: "pensioner pays", patient_pays: "full" });
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a final bill with no payment is cancelled with a reason", async () => {
    const { bill } = await finalBill("Can", { category: ids.pensioner, paid: false });
    const number = bill.bill_no;
    await refused(bills.cancelBill(bill.id, {}, desk, db), 400, /why/i, "a cancel with no reason");
    const cancelled = await bills.cancelBill(
      bill.id,
      { reason: "Raised on the wrong patient" },
      desk,
      db,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.bill_no).toBe(number);
    expect(cancelled.cancel_reason).toBe("Raised on the wrong patient");
    expect(cancelled.cancelled_at).not.toBeNull();
    const lines = await query(`SELECT is_live FROM bill_lines WHERE bill_id = $1`, [bill.id]);
    expect(lines.rows.every((line) => line.is_live === false)).toBe(true);
    ids.cancelled = bill.id;
    ids.cancelledVisit = cancelled.visit_id;
  });

  test("2. cancelling frees the item to be billed again", async () => {
    const draft = await bills.openDraft(ids.cancelledVisit, desk, db);
    const bill = await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    expect(bill.lines).toHaveLength(1);
  });

  test("3. a paid bill is refused with 'Refunds are not available yet'", async () => {
    const { bill } = await finalBill("Paid", { category: ids.pensioner, paid: true });
    await refused(
      bills.cancelBill(bill.id, { reason: "The patient changed their mind" }, desk, db),
      409,
      /Refunds are not available yet/,
      "a paid bill",
    );
    const after = await one(`SELECT status FROM bills WHERE id = $1`, [bill.id]);
    expect(after.status).toBe("final");
  });

  test("4. a pending claim bill may be cancelled, and leaves the register", async () => {
    const { bill } = await finalBill("Claim", { category: ids.paid, paid: true });
    expect(bill.claim_status).toBe("pending");
    const cancelled = await bills.cancelBill(bill.id, { reason: "Referral withdrawn" }, desk, db);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.claim_status).toBe("none");
    const { count } = await one(
      `SELECT COUNT(*)::int AS count FROM bills
        WHERE id = $1 AND claim_status = 'pending' AND status = 'final'`,
      [bill.id],
    );
    expect(count).toBe(0);
  });

  test("5. a cleared claim is refused with 'Already paid by CGHS'", async () => {
    const { bill } = await finalBill("Cleared", { category: ids.paid, paid: true });
    await query(
      `UPDATE bills SET claim_status = 'cleared', claim_settlement_id = gen_random_uuid()
        WHERE id = $1`,
      [bill.id],
    );
    await refused(
      bills.cancelBill(bill.id, { reason: "Too late" }, desk, db),
      409,
      /Already paid by CGHS/,
      "a cleared claim",
    );
  });

  test("6. two desks cancelling at once cancel it once", async () => {
    const { bill } = await finalBill("Twice", { category: ids.pensioner, paid: false });
    const both = await Promise.allSettled([
      bills.cancelBill(bill.id, { reason: "The first desk" }, desk, db),
      bills.cancelBill(bill.id, { reason: "The second desk" }, desk, db),
    ]);
    const done = both.filter((r) => r.status === "fulfilled");
    expect(done).toHaveLength(1);
    const beaten = both.find((r) => r.status === "rejected").reason;
    expect(beaten.status).toBe(409);
    expect(beaten.message).toMatch(/already cancelled/);
    const after = await one(`SELECT status, cancel_reason FROM bills WHERE id = $1`, [bill.id]);
    expect(after.status).toBe("cancelled");
    expect(after.cancel_reason).toBe(done[0].value.cancel_reason);
    const { count } = await one(
      `SELECT COUNT(*)::int AS count FROM billing_audit
        WHERE entity = 'bills' AND entity_id = $1 AND action = 'cancel'`,
      [bill.id],
    );
    expect(count).toBe(1);
  });

  test("7. a draft and an already cancelled bill are refused, and the cancel is audited", async () => {
    const { visit } = await extraVisit(ids, "Draft");
    const draft = await bills.openDraft(visit, desk, db);
    await refused(
      bills.cancelBill(draft.id, { reason: "Not needed" }, desk, db),
      409,
      /still a draft/,
      "a draft bill",
    );
    await refused(
      bills.cancelBill(ids.cancelled, { reason: "Again" }, desk, db),
      409,
      /already cancelled/,
      "a bill cancelled twice",
    );
    const { rows } = await query(
      `SELECT action, actor_id FROM billing_audit WHERE entity = 'bills' AND entity_id = $1
        ORDER BY id`,
      [ids.cancelled],
    );
    expect(rows.at(-1)).toMatchObject({ action: "cancel", actor_id: desk.actorId });
  });
});
