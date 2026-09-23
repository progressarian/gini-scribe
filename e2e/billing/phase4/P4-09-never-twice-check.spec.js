import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, refused, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const requests = await import("../../../server/services/billing/billingRequests.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.4.9" };
let ids;

test.describe.serial("P4-09 never-twice check", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    const draft = await bills.openDraft(ids.visit, desk, db);
    ids.bill = draft.id;
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the same item can't be added twice to one visit", async () => {
    const bill = await bills.addLine(ids.bill, { item_id: ids.dressing }, desk, db);
    expect(bill.lines).toHaveLength(1);
    await refused(
      bills.addLine(ids.bill, { item_id: ids.dressing }, desk, db),
      409,
      /Already billed on this visit's draft bill/,
      "the same item twice",
    );
    expect((await bills.readBill(ids.bill, db)).lines).toHaveLength(1);
  });

  test("2. the refusal names the bill the item is already on", async () => {
    await query(
      `UPDATE bills SET status = 'final', bill_no = $2, series = 'MAIN', fy = $3,
              finalised_at = NOW() WHERE id = $1`,
      [ids.bill, `P4/${tag}/000009`, ids.fy],
    );
    const next = await bills.openDraft(ids.visit, desk, db);
    ids.second = next.id;
    await refused(
      bills.addLine(ids.second, { item_id: ids.dressing }, desk, db),
      409,
      new RegExp(`Already billed on bill P4/${tag}/000009`),
      "an item on an earlier final bill",
    );
  });

  test("3. an approval lets it on once, and only once", async () => {
    const request = await requests.createRepeatRequest(
      {
        service_item_id: ids.dressing,
        visit_id: ids.visit,
        bill_id: ids.second,
        reason: "The dressing had to be done again in the afternoon",
      },
      desk,
      db,
    );
    await requests.approveRequest(request.id, { note: "Seen and agreed" }, admin, db);
    const bill = await bills.addLine(ids.second, { item_id: ids.dressing }, desk, db);
    expect(bill.lines).toHaveLength(1);
    const line = await one(
      `SELECT repeat_request_id FROM bill_lines WHERE bill_id = $1 AND service_item_id = $2`,
      [ids.second, ids.dressing],
    );
    expect(line.repeat_request_id).toBe(request.id);
    const used = await one(`SELECT status FROM billing_requests WHERE id = $1`, [request.id]);
    expect(used.status).toBe("used");
    await refused(
      bills.addLine(ids.second, { item_id: ids.dressing }, desk, db),
      409,
      /Already billed on/,
      "a third line with the approval spent",
    );
  });

  test("4. an approval for another item or visit is refused", async () => {
    const request = await requests.createRepeatRequest(
      {
        service_item_id: ids.dressing,
        visit_id: ids.visit,
        bill_id: ids.second,
        reason: "A third dressing was needed",
      },
      desk,
      db,
    );
    await requests.approveRequest(request.id, { note: "Fine" }, admin, db);
    const bill = await bills.addLine(ids.second, { item_id: ids.brace }, desk, db);
    const brace = bill.lines.find((l) => l.service_item_id === ids.brace);
    expect(brace.repeat_request_id).toBeNull();
    const untouched = await one(`SELECT status FROM billing_requests WHERE id = $1`, [request.id]);
    expect(untouched.status).toBe("approved");
    await refused(
      bills.addLine(ids.second, { item_id: ids.brace, repeat_request_id: request.id }, desk, db),
      409,
      /another item/i,
      "an approval given for a different item",
    );
    ids.spareApproval = request.id;
  });

  test("5. the database index is the last guard", async () => {
    const error = await query(
      `INSERT INTO bill_lines (bill_id, visit_id, line_no, service_item_id, bill_name, quantity)
       VALUES ($1, $2, 99, $3, 'By hand', 1)`,
      [ids.second, ids.visit, ids.dressing],
    ).then(
      () => null,
      (e) => e,
    );
    expect(error?.code).toBe("23505");
  });

  test("6. a cancelled line frees the item again", async () => {
    await query(`UPDATE bill_lines SET is_live = FALSE WHERE visit_id = $1`, [ids.visit]);
    const bill = await bills.addLine(ids.second, { item_id: ids.dressing }, desk, db);
    expect(bill.lines.some((l) => l.service_item_id === ids.dressing)).toBe(true);
  });
});
