import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { desk, extraVisit, newTag, tearDown } from "../phase4/p4-bills-fixture.mjs";
import { askRefund, refundApproved } from "../phase4b/p4b-refunds.mjs";
import {
  auditOf,
  billClaim,
  claimBill,
  db,
  mountClaims,
  pensionerBill,
  queryString,
  referralBill,
  setUpClaims,
} from "./p5-claims.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");

const tag = newTag();
let ids;
let api;

const utr = (label) => `UTR-${tag}-${label}`;

const clear = (billList, amount, extra = {}, as = "reception_admin") =>
  api.call("POST", "/clear", {
    as,
    body: {
      bill_ids: billList.map((bill) => bill.id),
      received_on: ids.day,
      reference: utr(extra.label ?? "x"),
      amount,
      note: extra.note,
      ...extra.body,
    },
  });

const settlementsWith = (reference) =>
  query(`SELECT id, voided_at FROM claim_settlements WHERE reference = $1`, [reference]).then(
    (r) => r.rows,
  );

const listed = async (tab, params = {}) =>
  (await api.call("GET", `/${tab}${queryString({ payer: `CGHS ${tag}`, ...params })}`)).body;

test.describe.serial("P5-03 clear one or many bills", () => {
  test.beforeAll(async () => {
    test.setTimeout(120000);
    ids = await setUpClaims(tag);
    api = await mountClaims();
  });

  test.afterAll(async () => {
    await api?.close();
    await tearDown(ids);
  });

  test("1. one ₹700 bill is cleared with 700, leaves Pending and shows on Cleared", async () => {
    const { bill } = await pensionerBill(ids, "One");
    const res = await clear([bill], 700, { label: "one", note: "Batch 12" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      payer_name: `CGHS ${tag}`,
      received_on: ids.day,
      reference: utr("one"),
      amount: 70000,
      note: "Batch 12",
      cleared_by: USERS.reception_admin.id,
      voided_at: null,
      bills: [{ bill_id: bill.id, bill_no: bill.bill_no, amount: 70000 }],
    });
    const stored = await billClaim(bill.id);
    expect(stored).toMatchObject({ claim_status: "cleared", claim_settlement_id: res.body.id });
    expect(stored.version).toBe(bill.version + 1);
    const link = await one(
      `SELECT amount::text, voided_at FROM claim_settlement_bills WHERE bill_id = $1`,
      [bill.id],
    );
    expect(link).toEqual({ amount: "700.00", voided_at: null });

    expect((await listed("pending")).rows.map((r) => r.bill_id)).not.toContain(bill.id);
    const cleared = (await listed("cleared")).rows.find((r) => r.bill_id === bill.id);
    expect(cleared).toMatchObject({
      claim_status: "cleared",
      claim: 70000,
      settlement: {
        id: res.body.id,
        received_on: ids.day,
        reference: utr("one"),
        amount: 70000,
        total: 70000,
        cleared_by: USERS.reception_admin.id,
        cleared_by_name: USERS.reception_admin.name,
      },
    });
    expect((await bills.readBill(bill.id, db)).claim_cleared_on).toBe(ids.day);

    const made = await auditOf("claim_settlements", res.body.id);
    expect(made.map((a) => a.action)).toEqual(["create"]);
    expect(made[0].actor_id).toBe(USERS.reception_admin.id);
    expect(made[0].after.bills).toEqual([
      { bill_id: bill.id, bill_no: bill.bill_no, amount: 70000 },
    ]);
    const billAudit = (await auditOf("bills", bill.id)).at(-1);
    expect(billAudit.action).toBe("update");
    expect(billAudit.before.claim_status).toBe("pending");
    expect(billAudit.after).toMatchObject({
      claim_status: "cleared",
      claim_settlement_id: res.body.id,
    });
    ids.one = bill;
    ids.oneSettlement = res.body.id;
  });

  test("2. two bills (₹350 + ₹700) cleared with 1,050 share one reference", async () => {
    const a = (await referralBill(ids, "TwoA")).bill;
    const b = (await pensionerBill(ids, "TwoB")).bill;
    const res = await clear([a, b], "1050.00", { label: "two" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.amount).toBe(105000);
    expect(res.body.bills.map((x) => x.amount).sort()).toEqual([35000, 70000]);
    const rows = await query(`SELECT claim_settlement_id FROM bills WHERE id = ANY($1::uuid[])`, [
      [a.id, b.id],
    ]);
    expect(new Set(rows.rows.map((r) => r.claim_settlement_id))).toEqual(new Set([res.body.id]));
    const found = await listed("cleared", { reference: `${tag}-TWO` });
    expect(found.rows.map((r) => r.bill_id).sort()).toEqual([a.id, b.id].sort());
    expect(found.totals).toEqual({ count: 2, amount: 105000 });
    ids.two = [a, b];
    ids.twoSettlement = res.body.id;
  });

  test("3. a wrong amount is refused with the difference, and nothing is written", async () => {
    const a = (await referralBill(ids, "WrongA")).bill;
    const b = (await pensionerBill(ids, "WrongB")).bill;
    const short = await clear([a, b], 1000, { label: "wrong" });
    expect(short.status).toBe(409);
    expect(short.body.error).toMatch(/difference ₹50/);
    expect(short.body.error).toMatch(/less than claimed/);
    const over = await clear([a, b], 1100, { label: "wrong" });
    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(/difference ₹50\.00 more than claimed/);
    expect(await settlementsWith(utr("wrong"))).toEqual([]);
    expect((await billClaim(a.id)).claim_status).toBe("pending");
    expect((await billClaim(b.id)).claim_status).toBe("pending");
    ids.wrong = [a, b];
  });

  test("4. clearing a cleared bill is refused, alone or with others", async () => {
    const again = await clear([ids.one], 700, { label: "again" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already cleared \(reference .*-one, received /);
    const mixed = await clear([ids.wrong[1], ids.one], 1400, { label: "again" });
    expect(mixed.status).toBe(409);
    expect(mixed.body.error).toMatch(/already cleared/);
    expect(await settlementsWith(utr("again"))).toEqual([]);
  });

  test("5. three bills clear at once", async () => {
    const third = (await pensionerBill(ids, "Three")).bill;
    const res = await clear([...ids.wrong, third], 1750, { label: "three" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.bills).toHaveLength(3);
    for (const bill of [...ids.wrong, third]) {
      expect((await billClaim(bill.id)).claim_settlement_id).toBe(res.body.id);
    }
  });

  test("6. mixed payers, cancelled bills and impossible entries are refused in words", async () => {
    const cghs = (await pensionerBill(ids, "Mix")).bill;
    const echs = (await claimBill(ids, "Echs", { category: ids.other, itemId: ids.fee700 })).bill;
    const payers = await clear([cghs, echs], 1400, { label: "mix" });
    expect(payers.status).toBe(409);
    expect(payers.body.error).toMatch(/different payers .* clear each payer's bills separately/);

    const gone = (await pensionerBill(ids, "Cancel")).bill;
    await bills.cancelBill(gone.id, { reason: "Wrong patient" }, desk, db);
    const cancelled = await clear([gone], 700, { label: "mix" });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error).toMatch(/is cancelled/);

    const future = await clear([cghs], 700, { label: "mix", body: { received_on: "2999-01-01" } });
    expect(future.status).toBe(400);
    expect(future.body.error).toMatch(/can't be in the future/);
    const early = await clear([cghs], 700, { label: "mix", body: { received_on: "2020-01-01" } });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/money can't have been received on 2020-01-01/);

    const twice = await api.call("POST", "/clear", {
      body: { bill_ids: [cghs.id, cghs.id], received_on: ids.day, reference: "X", amount: 1400 },
    });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toMatch(/chosen twice/);
    const unknown = await api.call("POST", "/clear", {
      body: {
        bill_ids: ["00000000-0000-4000-8000-000000000099"],
        received_on: ids.day,
        reference: "X",
        amount: 1,
      },
    });
    expect(unknown.status).toBe(404);
    const priced = await api.call("POST", "/clear", {
      body: { bill_ids: [cghs.id], received_on: ids.day, reference: "X", amount: 700, rate: 1 },
    });
    expect(priced.status).toBe(400);
    expect(priced.body.error).toMatch(/Unknown field: rate/);
    const blank = await api.call("POST", "/clear", {
      body: { bill_ids: [cghs.id], received_on: ids.day, reference: " ", amount: 700 },
    });
    expect(blank.status).toBe(400);
    expect(await settlementsWith(utr("mix"))).toEqual([]);
    ids.mix = cghs;
  });

  test("7. undo is admin only; it returns the bills to pending and voids the payment", async () => {
    const [a, b] = ids.two;
    const reason = { reason: "Wrong UTR typed" };
    const route = `/settlements/${ids.twoSettlement}/undo`;
    const refusedUndo = await api.call("POST", route, { body: reason });
    expect(refusedUndo.status).toBe(403);
    expect((await billClaim(a.id)).claim_status).toBe("cleared");
    const noReason = await api.call("POST", route, { as: "admin", body: {} });
    expect(noReason.status).toBe(400);

    const undone = await api.call("POST", route, { as: "admin", body: reason });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(undone.body).toMatchObject({
      id: ids.twoSettlement,
      voided_by: USERS.admin.id,
      void_reason: "Wrong UTR typed",
    });
    expect(undone.body.voided_at).toBeTruthy();
    for (const bill of [a, b]) {
      expect(await billClaim(bill.id)).toMatchObject({
        claim_status: "pending",
        claim_settlement_id: null,
      });
      expect((await bills.readBill(bill.id, db)).claim_cleared_on).toBeNull();
    }
    const links = await query(
      `SELECT voided_at FROM claim_settlement_bills WHERE settlement_id = $1`,
      [ids.twoSettlement],
    );
    expect(links.rows.every((r) => r.voided_at)).toBe(true);
    const pendingNow = (await listed("pending")).rows.map((r) => r.bill_id);
    expect(pendingNow).toEqual(expect.arrayContaining([a.id, b.id]));
    expect((await listed("cleared", { reference: `${tag}-two` })).totals.count).toBe(0);
    const audit = await auditOf("claim_settlements", ids.twoSettlement);
    expect(audit.map((x) => x.action)).toEqual(["create", "cancel"]);
    expect(audit[1].actor_id).toBe(USERS.admin.id);

    const twice = await api.call("POST", route, { as: "admin", body: reason });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatch(/already been undone/);

    const redo = await clear([a, b], 1050, { label: "two-right" });
    expect(redo.status, JSON.stringify(redo.body)).toBe(201);
    const read = await api.call("GET", `/settlements/${ids.twoSettlement}`);
    expect(read.status).toBe(200);
    expect(read.body.bills).toHaveLength(2);
    expect(read.body.bills.every((x) => x.voided_at)).toBe(true);
  });

  test("8. two desks clearing the same bill at once clear it once", async () => {
    const { bill } = await pensionerBill(ids, "Race");
    const both = await Promise.all([
      clear([bill], 700, { label: "race-a" }),
      clear([bill], 700, { label: "race-b" }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = both.find((r) => r.status === 409);
    expect(loser.body.error).toMatch(/already cleared/);
    const links = await query(
      `SELECT COUNT(*)::int AS n FROM claim_settlement_bills WHERE bill_id = $1`,
      [bill.id],
    );
    expect(links.rows[0].n).toBe(1);
  });

  test("9. a credit note before clearing lowers the amount due; after clearing, the claim can't be credited", async () => {
    const { bill } = await claimBill(ids, "Credit", {
      category: ids.pensioner,
      itemId: [ids.fee700, ids.fee350],
    });
    const line = bill.lines.find((l) => l.service_item_id === ids.fee350);
    await refundApproved(bill.id, [{ line_id: line.id }]);
    const gross = await clear([bill], 1050, { label: "credit" });
    expect(gross.status).toBe(409);
    expect(gross.body.error).toMatch(/\(₹700\.00\) — difference ₹350\.00 more than claimed/);
    const net = await clear([bill], 700, { label: "credit" });
    expect(net.status, JSON.stringify(net.body)).toBe(201);
    expect(net.body.bills[0].amount).toBe(70000);
    const other = bill.lines.find((l) => l.service_item_id === ids.fee700);
    const error = await askRefund(bill.id, [{ line_id: other.id }]).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.code).toBe("claim_cleared");
  });

  test("10. a test on the bill carries its claim as approved, and undo leaves the test alone", async () => {
    const { visit } = await extraVisit(ids, "Lab");
    const order = await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                        sample_status, kind)
       VALUES ($1, 'today', 'pending', 250, 'payment_pending', 'lab') RETURNING id`,
      [visit],
    );
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 250)`,
      [order.id, ids.hba1cName],
    );
    await visitLines.linesForOrder(
      visit,
      { labOrderId: order.id, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    const draft = (await bills.listVisitBills(visit, db)).find((b) => b.status === "draft");
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    const final = await bills.finaliseBill(draft.id, { version: ready.version }, desk, db);
    expect(final.totals.claim).toBe(25000);
    const res = await clear([final], 250, { label: "lab" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const money = () =>
      one(
        `SELECT amount_paid::text, amount_claimed::text, claim_state, payment_status
           FROM giniflow_lab_orders WHERE id = $1`,
        [order.id],
      );
    const cleared = await money();
    expect(cleared).toEqual({
      amount_paid: "0.00",
      amount_claimed: "250.00",
      claim_state: "approved",
      payment_status: "claim_approved",
    });
    const undone = await api.call("POST", `/settlements/${res.body.id}/undo`, {
      as: "admin",
      body: { reason: "Entered against the wrong batch" },
    });
    expect(undone.status).toBe(200);
    expect(await money()).toEqual(cleared);
  });

  test("11. paise claims and two part credits: list, export and clear agree to the paisa", async () => {
    test.setTimeout(120000);
    const item = async (code, price, allowQuantity = false) => {
      const { id } = await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, allow_quantity,
                                    max_quantity)
         VALUES ($1, $2, $3, $4, 'procedure', $5, $6) RETURNING id`,
        [
          `P4-${code}-${tag}`,
          `P5 ${code} ${tag}`,
          ids.subgroup,
          price,
          allowQuantity,
          allowQuantity ? 10 : null,
        ],
      );
      await query(
        `INSERT INTO category_item_rates (scheme_code, service_item_id, bill_code, valid_from)
         VALUES ($1, $2, 'CC09', $3::date - 1)`,
        [ids.parent, id, ids.day],
      );
      return id;
    };
    const odd = [await item("PO1", 333.33), await item("PO2", 333.33), await item("PO3", 333.33)];
    const dressing = await item("PQ1", 100, true);
    const three = (await claimBill(ids, "Odd", { category: ids.pensioner, itemId: odd })).bill;
    const { visit } = await extraVisit(ids, "Qty", { doctorId: CONSULTANTS.banshali.id });
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(
      draft.id,
      { item_id: dressing, doctor_id: CONSULTANTS.banshali.id, quantity: 3 },
      desk,
      db,
    );
    await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    const fresh = await bills.readBill(draft.id, db);
    const qty = await bills.finaliseBill(draft.id, { version: fresh.version }, desk, db);
    await refundApproved(qty.id, [{ line_id: qty.lines[0].id, quantity: 1 }]);
    await refundApproved(qty.id, [{ line_id: qty.lines[0].id, quantity: 1 }]);

    const list = await listed("pending");
    const row = (bill) => list.rows.find((r) => r.bill_id === bill.id);
    expect(row(three)).toMatchObject({ billed_claim: 99999, credited: 0, claim: 99999 });
    expect(row(qty)).toMatchObject({ billed_claim: 30000, credited: 20000, claim: 10000 });
    expect(list.totals.amount).toBe(list.rows.reduce((sum, r) => sum + r.claim, 0));
    const file = await api.call("GET", `/pending/export${queryString({ payer: `CGHS ${tag}` })}`);
    expect(Number(file.headers.get("x-claims-amount"))).toBe(list.totals.amount);

    const wrong = await clear([three, qty], 1299.99, { label: "odd-gross" });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatch(/difference ₹200\.00 more/);
    const paid = await clear([three, qty], 1099.99, { label: "odd" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.bills.map((b) => b.amount).sort((a, b) => a - b)).toEqual([10000, 99999]);
    const cleared = await listed("cleared", { reference: utr("odd") });
    expect(cleared.totals).toEqual({ count: 2, amount: 109999 });
  });
});
