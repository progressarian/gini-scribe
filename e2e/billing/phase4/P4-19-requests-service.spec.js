import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/billingRequests.js");

const db = getPool();
const tag = crypto.randomBytes(3).toString("hex");
const desk = { actorId: USERS.reception.id, ip: "10.9.1.1" };
const otherDesk = { actorId: USERS.coordinator.id, ip: "10.9.1.2" };
const ids = {};

const failure = (promise) => promise.then(() => null).catch((e) => e);
const refused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, `${label}: ${error?.message ?? "no refusal"}`).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};

const auditFor = (id) =>
  query(
    `SELECT action, actor_id, ip FROM billing_audit
      WHERE entity = 'billing_requests' AND entity_id = $1 ORDER BY id`,
    [String(id)],
  ).then((r) => r.rows);

const addLine = (visit, bill, item, lineNo) =>
  query(
    `INSERT INTO bill_lines
       (bill_id, visit_id, line_no, service_item_id, bill_name, quantity, rate,
        listed_actual, actual_amount, taxable, patient_payable)
     VALUES ($1, $2, $3, $4, $5, 1, 500, 500, 500, 500, 500) RETURNING id`,
    [bill, visit, lineNo, item, `Line ${lineNo}`],
  ).then((r) => r.rows[0].id);

test.describe.serial("P4-19 desk requests service", () => {
  test.beforeAll(async () => {
    ids.group = (
      await one(`INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`, [
        `P419G-${tag}`,
        `Requests ${tag}`,
      ])
    ).id;
    ids.subgroup = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Procedures') RETURNING id`,
        [ids.group, `P419S-${tag}`],
      )
    ).id;
    const item = async (code, name) =>
      (
        await one(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
           VALUES ($1, $2, $3, 500, 'procedure') RETURNING id`,
          [`${code}-${tag}`, name, ids.subgroup],
        )
      ).id;
    ids.xray = await item("P419-XR", `X-ray knee ${tag}`);
    ids.dressing = await item("P419-DR", `Dressing ${tag}`);
    ids.patient = (
      await one(`INSERT INTO patients (name, file_no, age) VALUES ($1, $2, 44) RETURNING id`, [
        `P419 Patient ${tag}`,
        `F419-${tag}`,
      ])
    ).id;
    ids.visit = (
      await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [ids.patient])
    ).id;
    ids.otherVisit = (
      await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date) VALUES ($1, CURRENT_DATE - 1) RETURNING id`,
        [ids.patient],
      )
    ).id;
    ids.bill = (
      await one(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
        ids.patient,
        ids.visit,
      ])
    ).id;
    ids.otherBill = (
      await one(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
        ids.patient,
        ids.otherVisit,
      ])
    ).id;
    ids.line = await addLine(ids.visit, ids.bill, ids.xray, 1);
  });

  test("1. a new-item request records the name, the group hint, the reason and who asked", async () => {
    const request = await svc.createNewItemRequest(
      {
        proposed_name: `  Ankle brace ${tag}  `,
        proposed_group: " Consumables ",
        reason: "The doctor asked for it today and it isn't on the list",
        visit_id: ids.visit,
        bill_id: ids.bill,
        requested_by: USERS.reception_admin.id,
      },
      desk,
      db,
    );
    ids.newItemRequest = request.id;
    expect(request.kind).toBe("new_item");
    expect(request.status).toBe("pending");
    expect(request.proposed_name).toBe(`Ankle brace ${tag}`);
    expect(request.proposed_group).toBe("Consumables");
    expect(request.item).toBeNull();
    expect(request.patient).toMatchObject({ id: ids.patient, name: `P419 Patient ${tag}` });
    expect(request.requested_by).toMatchObject({ id: USERS.reception.id });
    expect(request.decided_by).toBeNull();
    expect(request.usable).toBe(false);
    const stored = await one(
      `SELECT requested_by, created_by FROM billing_requests WHERE id = $1`,
      [request.id],
    );
    expect(stored.requested_by).toBe(USERS.reception.id);
    expect(stored.created_by).toBe(USERS.reception.id);
    expect(await auditFor(request.id)).toEqual([
      { action: "create", actor_id: USERS.reception.id, ip: desk.ip },
    ]);
  });

  test("2. a request can never carry a price, a name or a reason", async () => {
    const good = {
      proposed_name: `Brace ${tag}`,
      reason: "Needed today",
    };
    await refused(
      svc.createNewItemRequest({ ...good, base_price: 400 }, desk, db),
      400,
      /can't carry a price/,
      "price",
    );
    await refused(
      svc.createNewItemRequest({ ...good, rate: "400" }, desk, db),
      400,
      /rate/,
      "rate",
    );
    await refused(
      svc.createNewItemRequest({ proposed_name: "  ", reason: "x" }, desk, db),
      400,
      /Name can't be blank/,
      "blank name",
    );
    await refused(
      svc.createNewItemRequest({ proposed_name: "Brace", reason: "  " }, desk, db),
      400,
      /Say why/,
      "blank reason",
    );
    await refused(
      svc.createNewItemRequest(good, {}, db),
      401,
      /Sign in again/,
      "no signed-in user",
    );
  });

  test("3. a repeat request is allowed only for an item the visit already carries", async () => {
    const request = await svc.createRepeatRequest(
      {
        service_item_id: ids.xray,
        visit_id: ids.visit,
        bill_id: ids.bill,
        reason: "Second X-ray, other knee, per Dr Rahul",
      },
      desk,
      db,
    );
    ids.repeatRequest = request.id;
    expect(request.kind).toBe("repeat_item");
    expect(request.status).toBe("pending");
    expect(request.item).toMatchObject({ id: ids.xray, name: `X-ray knee ${tag}` });
    expect(request.visit_id).toBe(ids.visit);
    expect(request.bill_id).toBe(ids.bill);
    expect(request.patient.file_no).toBe(`F419-${tag}`);
    expect(request.usable).toBe(false);
    expect((await auditFor(request.id)).map((r) => r.action)).toEqual(["create"]);
  });

  test("4. an item that isn't on the visit's bill needs no approval", async () => {
    await refused(
      svc.createRepeatRequest(
        { service_item_id: ids.dressing, visit_id: ids.visit, reason: "Dressing twice" },
        desk,
        db,
      ),
      409,
      /isn't on this visit's bill yet/,
      "not billed",
    );
    await refused(
      svc.createRepeatRequest(
        { service_item_id: ids.xray, visit_id: ids.otherVisit, reason: "Wrong visit" },
        desk,
        db,
      ),
      409,
      /isn't on this visit's bill yet/,
      "other visit",
    );
  });

  test("5. the same item is not asked for twice while an admin hasn't answered", async () => {
    await refused(
      svc.createRepeatRequest(
        {
          service_item_id: ids.xray,
          visit_id: ids.visit,
          bill_id: ids.bill,
          reason: "Asking again",
        },
        desk,
        db,
      ),
      409,
      /already waiting for an admin's answer/,
      "duplicate",
    );
  });

  test("6. unknown visits, items and bills are refused before anything is written", async () => {
    const before = await one(`SELECT count(*)::int AS n FROM billing_requests`);
    const missing = "00000000-0000-4000-8000-000000000000";
    await refused(
      svc.createRepeatRequest(
        { service_item_id: ids.xray, visit_id: missing, reason: "Gone" },
        desk,
        db,
      ),
      404,
      /visit no longer exists/,
      "visit",
    );
    await refused(
      svc.createRepeatRequest(
        { service_item_id: 999999999, visit_id: ids.visit, reason: "Gone" },
        desk,
        db,
      ),
      404,
      /item doesn't exist/,
      "item",
    );
    await refused(
      svc.createRepeatRequest(
        {
          service_item_id: ids.xray,
          visit_id: ids.visit,
          bill_id: ids.otherBill,
          reason: "Other bill",
        },
        desk,
        db,
      ),
      409,
      /belongs to another visit/,
      "bill of another visit",
    );
    await refused(
      svc.createRepeatRequest(
        { service_item_id: ids.xray, visit_id: "not-a-visit", reason: "Bad id" },
        desk,
        db,
      ),
      400,
      /Choose a valid visit/,
      "bad id",
    );
    expect((await one(`SELECT count(*)::int AS n FROM billing_requests`)).n).toBe(before.n);
  });

  test("7. the admin's inbox lists pending requests oldest first, with everything it needs", async () => {
    const pending = await svc.listPendingRequests(db);
    const mine = pending.filter((r) => [ids.newItemRequest, ids.repeatRequest].includes(r.id));
    expect(mine.map((r) => r.id)).toEqual([ids.newItemRequest, ids.repeatRequest]);
    expect(pending.map((r) => r.requested_at.getTime())).toEqual(
      [...pending].map((r) => r.requested_at.getTime()).sort((a, b) => a - b),
    );
    const [newItem, repeat] = mine;
    expect(newItem.proposed_name).toBe(`Ankle brace ${tag}`);
    expect(newItem.reason).toMatch(/isn't on the list/);
    expect(newItem.requested_by.name).toBe(USERS.reception.name);
    expect(repeat.item.code).toBe(`P419-XR-${tag}`);
    expect(repeat.patient.name).toBe(`P419 Patient ${tag}`);
    expect(repeat.reason).toMatch(/other knee/);
    expect(mine.every((r) => r.usable === false)).toBe(true);
  });

  test("8. a desk user sees their own requests, newest first, with status and note", async () => {
    const theirs = await svc.createNewItemRequest(
      { proposed_name: `Splint ${tag}`, reason: "Another desk asked" },
      otherDesk,
      db,
    );
    const mine = await svc.listMyRequests({}, desk, db);
    const ours = mine.filter((r) => [ids.newItemRequest, ids.repeatRequest].includes(r.id));
    expect(ours.map((r) => r.id)).toEqual([ids.repeatRequest, ids.newItemRequest]);
    expect(mine.some((r) => r.id === theirs.id)).toBe(false);
    expect(ours.every((r) => r.status === "pending" && r.decision_note === null)).toBe(true);
    const visitOnly = await svc.listMyRequests({ visitId: ids.visit }, desk, db);
    expect(visitOnly.map((r) => r.id).sort()).toEqual(
      [ids.newItemRequest, ids.repeatRequest].sort(),
    );
    await refused(svc.listMyRequests({}, {}, db), 401, /Sign in again/, "no user");
    const single = await svc.getRequest(ids.repeatRequest, db);
    expect(single.item.id).toBe(ids.xray);
    await refused(
      svc.getRequest("00000000-0000-4000-8000-000000000000", db),
      404,
      /no longer exists/,
      "unknown request",
    );
  });

  test("9. the admin can read the whole history, by kind and by status", async () => {
    const repeats = await svc.listRequests({ kind: "repeat_item", visitId: ids.visit }, db);
    expect(repeats.map((r) => r.id)).toEqual([ids.repeatRequest]);
    await refused(svc.listRequests({ status: "answered" }, db), 400, /Status must be/, "status");
    await refused(svc.listRequests({ kind: "other" }, db), 400, /Kind must be/, "kind");
    const capped = await svc.listRequests({ limit: 1 }, db);
    expect(capped).toHaveLength(1);
  });

  test("10. the never-twice helpers answer what the bills service will ask", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const line = await svc.liveLineFor(client, {
        visitId: ids.visit,
        serviceItemId: ids.xray,
      });
      expect(line.id).toBe(ids.line);
      expect(
        await svc.liveLineFor(client, { visitId: ids.visit, serviceItemId: ids.dressing }),
      ).toBeNull();
      expect(
        await svc.repeatApprovalFor(client, { visitId: ids.visit, serviceItemId: ids.xray }),
      ).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test.afterAll(async () => {
    await query(`DELETE FROM bill_lines WHERE visit_id = ANY($1::uuid[])`, [
      [ids.visit, ids.otherVisit],
    ]);
    await query(
      `DELETE FROM billing_requests WHERE visit_id = ANY($1::uuid[]) OR proposed_name LIKE $2`,
      [[ids.visit, ids.otherVisit], `%${tag}%`],
    );
  });
});
