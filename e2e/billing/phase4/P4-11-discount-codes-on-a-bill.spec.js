import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  discountCode,
  extraVisit,
  newTag,
  refused,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
const CODE = `P4C${tag.toUpperCase()}`;
const GONE = `P4X${tag.toUpperCase()}`;
const ELSEWHERE = `P4E${tag.toUpperCase()}`;
let ids;

test.describe.serial("P4-11 discount codes on a bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    ids.code = await discountCode(ids, CODE, { kind: "percent", value: 10 });
    ids.gone = await discountCode(ids, GONE, {
      kind: "percent",
      value: 50,
      valid_to: "2020-01-01",
    });
    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await bills.addLine(ids.bill, { item_id: ids.dressing }, desk, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a valid code changes the totals", async () => {
    const bill = await bills.addCode(ids.bill, { code: CODE }, desk, db);
    expect(bill.codes).toEqual([CODE]);
    expect(bill.totals.discount).toBe(5000);
    expect(bill.totals.payable).toBe(45000);
    const step = await one(
      `SELECT d.code, d.method, d.taken_from, d.amount FROM bill_line_discounts d
         JOIN bill_lines l ON l.id = d.bill_line_id WHERE l.bill_id = $1`,
      [ids.bill],
    );
    expect(step).toMatchObject({ code: CODE, method: "code", taken_from: "actual" });
    expect(Number(step.amount)).toBe(50);
  });

  test("2. the code stays on the draft while the bill changes", async () => {
    const bill = await bills.addLine(ids.bill, { item_id: ids.brace }, desk, db);
    expect(bill.codes).toEqual([CODE]);
    expect(bill.totals.discount).toBe(5000 + 8000);
    expect(bill.totals.payable).toBe(45000 + 72000);
  });

  test("3. an invalid code returns its reason", async () => {
    const unknown = await refused(
      bills.addCode(ids.bill, { code: "P4-NOPE" }, desk, db),
      409,
      /no discount with the code/i,
      "an unknown code",
    );
    expect(unknown.reason).toBe("unknown");
    const expired = await refused(
      bills.addCode(ids.bill, { code: GONE }, desk, db),
      409,
      /expired/i,
      "an expired code",
    );
    expect(expired.reason).toBe("expired");
    await refused(
      bills.addCode(ids.bill, { code: CODE }, desk, db),
      409,
      /already on this bill/,
      "the same code twice",
    );
    expect((await bills.readBill(ids.bill, db)).codes).toEqual([CODE]);
  });

  test("4. a code that fits nothing on this bill is refused with its reason", async () => {
    ids.elsewhere = await discountCode(ids, ELSEWHERE, {
      kind: "percent",
      value: 10,
      service_item_ids: [ids.hba1c],
    });
    const refusal = await refused(
      bills.addCode(ids.bill, { code: ELSEWHERE }, desk, db),
      409,
      new RegExp(`The code ${ELSEWHERE}`),
      "a code for another item",
    );
    expect(refusal.reason).toBe("items");
    expect((await bills.readBill(ids.bill, db)).codes).toEqual([CODE]);
  });

  test("5. removing the code puts the totals back", async () => {
    const bill = await bills.removeCode(ids.bill, { code: CODE }, desk, db);
    expect(bill.codes).toEqual([]);
    expect(bill.totals.discount).toBe(0);
    expect(bill.totals.payable).toBe(50000 + 80000);
    const { count } = await one(
      `SELECT COUNT(*)::int AS count FROM bill_line_discounts d
         JOIN bill_lines l ON l.id = d.bill_line_id WHERE l.bill_id = $1`,
      [ids.bill],
    );
    expect(count).toBe(0);
    await refused(
      bills.removeCode(ids.bill, { code: CODE }, desk, db),
      404,
      /isn't on this bill/,
      "removing a code that isn't there",
    );
  });

  test("6. a code that takes nothing is refused, not quietly dropped", async () => {
    const free = await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
       VALUES ($1, $2, $3, 0, 'procedure') RETURNING id`,
      [`P4-FREE-${tag}`, `P4 Free ${tag}`, ids.subgroup],
    );
    const { visit } = await extraVisit(ids, "Zero");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: free.id }, desk, db);
    const refusal = await refused(
      bills.addCode(draft.id, { code: CODE }, desk, db),
      409,
      /takes nothing off this bill/,
      "a code that takes nothing",
    );
    expect(refusal.reason).toBe("no_effect");
    expect((await bills.readBill(draft.id, db)).codes).toEqual([]);
    const paid = await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    expect(paid.totals.payable).toBe(50000);
    const kept = await bills.addCode(draft.id, { code: CODE }, desk, db);
    expect(kept.codes).toEqual([CODE]);
    expect(kept.totals.payable).toBe(45000);
  });

  test("7. codes can't be entered on a bill that is already final", async () => {
    await query(
      `UPDATE bills SET status = 'final', bill_no = $2, series = 'MAIN', fy = $3,
              finalised_at = NOW() WHERE id = $1`,
      [ids.bill, `P4/${tag}/000011`, ids.fy],
    );
    await refused(
      bills.addCode(ids.bill, { code: CODE }, desk, db),
      409,
      /already final/,
      "a code on a final bill",
    );
  });
});
