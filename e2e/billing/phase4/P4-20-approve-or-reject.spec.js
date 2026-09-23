import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/billingRequests.js");

const db = getPool();
const tag = crypto.randomBytes(3).toString("hex");
const desk = { actorId: USERS.reception.id, ip: "10.9.2.1" };
const admin = { actorId: USERS.reception_admin.id, ip: "10.9.2.2" };
const ids = {};
let lineNo = 1;

const failure = (promise) => promise.then(() => null).catch((e) => e);
const refused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, `${label}: ${error?.message ?? "no refusal"}`).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};

const auditFor = (entity, id) =>
  query(
    `SELECT action, actor_id FROM billing_audit WHERE entity = $1 AND entity_id = $2 ORDER BY id`,
    [entity, String(id)],
  ).then((r) => r.rows);

const addLine = (item, extra = {}) =>
  query(
    `INSERT INTO bill_lines
       (bill_id, visit_id, line_no, service_item_id, repeat_request_id, bill_name, quantity, rate,
        listed_actual, actual_amount, taxable, patient_payable)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 500, 500, 500, 500, 500) RETURNING id`,
    [
      extra.bill ?? ids.bill,
      extra.visit ?? ids.visit,
      ++lineNo,
      item,
      extra.repeat ?? null,
      `Line ${lineNo}`,
    ],
  ).then((r) => r.rows[0].id);

const newItemRequest = (name) =>
  svc.createNewItemRequest(
    { proposed_name: name, proposed_group: "Consumables", reason: "The doctor asked for it" },
    desk,
    db,
  );

const repeatRequest = (item, visit = ids.visit) =>
  svc.createRepeatRequest(
    { service_item_id: item, visit_id: visit, reason: "Other knee, per Dr Rahul" },
    desk,
    db,
  );

test.describe.serial("P4-20 approving and rejecting desk requests", () => {
  test.beforeAll(async () => {
    ids.group = (
      await one(`INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`, [
        `P420G-${tag}`,
        `Decisions ${tag}`,
      ])
    ).id;
    ids.subgroup = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Procedures') RETURNING id`,
        [ids.group, `P420S-${tag}`],
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
    ids.xray = await item("P420-XR", `X-ray knee ${tag}`);
    ids.dressing = await item("P420-DR", `Dressing ${tag}`);
    ids.patient = (
      await one(`INSERT INTO patients (name, file_no, age) VALUES ($1, $2, 51) RETURNING id`, [
        `P420 Patient ${tag}`,
        `F420-${tag}`,
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
    await addLine(ids.xray);
    await addLine(ids.dressing);
    await query(
      `INSERT INTO bill_lines
         (bill_id, visit_id, line_no, service_item_id, bill_name, quantity, rate,
          listed_actual, actual_amount, taxable, patient_payable)
       VALUES ($1, $2, 1, $3, 'Other visit X-ray', 1, 500, 500, 500, 500, 500)`,
      [ids.otherBill, ids.otherVisit, ids.xray],
    );
  });

  test("1. approving a new item creates it through the items service and links it", async () => {
    const request = await newItemRequest(`Ankle brace ${tag}`);
    const approved = await svc.approveRequest(
      request.id,
      {
        note: "Created under consumables",
        item: { code: `P420-AB-${tag}`, subgroup_id: ids.subgroup, base_price: 750, kind: "other" },
      },
      admin,
      db,
    );
    ids.createdItem = approved.created_item.id;
    expect(approved.status).toBe("approved");
    expect(approved.created_item.name).toBe(`Ankle brace ${tag}`);
    expect(approved.created_item.code).toBe(`P420-AB-${tag}`);
    expect(approved.decided_by).toMatchObject({ id: USERS.reception_admin.id });
    expect(approved.decided_at).not.toBeNull();
    expect(approved.decision_note).toBe("Created under consumables");
    expect(approved.usable).toBe(true);
    const item = await one(
      `SELECT name, base_price, subgroup_id FROM service_items WHERE id = $1`,
      [ids.createdItem],
    );
    expect(item).toMatchObject({ name: `Ankle brace ${tag}`, subgroup_id: ids.subgroup });
    expect(Number(item.base_price)).toBe(750);
    expect((await auditFor("billing_requests", request.id)).map((r) => r.action)).toEqual([
      "create",
      "approve",
    ]);
    expect((await auditFor("service_items", ids.createdItem)).map((r) => r.action)).toEqual([
      "create",
    ]);
  });

  test("2. the items service's own refusals come through, and the request stays pending", async () => {
    const request = await newItemRequest(`Knee brace ${tag}`);
    const item = { code: `P420-KB-${tag}`, subgroup_id: ids.subgroup, base_price: 300 };
    await refused(
      svc.approveRequest(request.id, { item: { ...item, kind: "widget" } }, admin, db),
      400,
      /Kind must be one of/,
      "bad kind",
    );
    await refused(
      svc.approveRequest(
        request.id,
        { item: { ...item, code: `P420-AB-${tag}`, kind: "other" } },
        admin,
        db,
      ),
      409,
      /already exists/,
      "duplicate code",
    );
    await refused(
      svc.approveRequest(
        request.id,
        { item: { ...item, subgroup_id: null, kind: "other" } },
        admin,
        db,
      ),
      400,
      /Choose a subgroup/,
      "no subgroup",
    );
    const stored = await one(
      `SELECT status, created_item_id, decided_at FROM billing_requests WHERE id = $1`,
      [request.id],
    );
    expect(stored).toMatchObject({ status: "pending", created_item_id: null, decided_at: null });
    expect(
      await one(`SELECT id FROM service_items WHERE code = $1`, [`P420-KB-${tag}`]),
    ).toBeNull();
    ids.pendingNewItem = request.id;
  });

  test("3. rejecting takes a note, and a decided request is never decided twice", async () => {
    await refused(
      svc.rejectRequest(ids.pendingNewItem, {}, admin, db),
      400,
      /Write a note/,
      "no note",
    );
    const rejected = await svc.rejectRequest(
      ids.pendingNewItem,
      { note: "We already bill this as Dressing" },
      admin,
      db,
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.decision_note).toBe("We already bill this as Dressing");
    expect(rejected.decided_by.name).toBe(USERS.reception_admin.name);
    expect(rejected.usable).toBe(false);
    await refused(
      svc.rejectRequest(ids.pendingNewItem, { note: "Again" }, admin, db),
      409,
      /already rejected/,
      "reject twice",
    );
    await refused(
      svc.approveRequest(ids.pendingNewItem, { item: {} }, admin, db),
      409,
      /already rejected/,
      "approve after reject",
    );
    expect((await auditFor("billing_requests", ids.pendingNewItem)).map((r) => r.action)).toEqual([
      "create",
      "reject",
    ]);
    await refused(
      svc.rejectRequest(ids.pendingNewItem, { note: "Again" }, {}, db),
      401,
      /Sign in again/,
      "no signed-in admin",
    );
  });

  test("4. a repeat approval is usable once, and the second use is refused", async () => {
    const request = await repeatRequest(ids.xray);
    ids.repeat = request.id;
    const approved = await svc.approveRequest(request.id, { note: "Other knee, fine" }, admin, db);
    expect(approved.status).toBe("approved");
    expect(approved.usable).toBe(true);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const waiting = await svc.repeatApprovalFor(client, {
        visitId: ids.visit,
        serviceItemId: ids.xray,
      });
      expect(waiting.id).toBe(request.id);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const used = await svc.useRepeatApproval(
      request.id,
      { visitId: ids.visit, serviceItemId: ids.xray },
      desk,
      db,
    );
    expect(used.status).toBe("used");
    ids.repeatLine = await addLine(ids.xray, { repeat: request.id });
    const listed = await svc.getRequest(request.id, db);
    expect(listed.usable).toBe(false);
    expect(listed.used_on).toMatchObject({ line_id: ids.repeatLine, bill_id: ids.bill });
    await refused(
      svc.useRepeatApproval(request.id, { visitId: ids.visit, serviceItemId: ids.xray }, desk, db),
      409,
      /already been used/,
      "second use",
    );
    expect((await auditFor("billing_requests", request.id)).map((r) => r.action)).toEqual([
      "create",
      "approve",
      "update",
    ]);
  });

  test("5. the database refuses a second line on the same approval, and a mismatched line", async () => {
    const second = await failure(addLine(ids.xray, { repeat: ids.repeat }));
    expect(second?.code, second?.message).toBe("23505");
    const fresh = await repeatRequest(ids.dressing);
    await svc.approveRequest(fresh.id, { note: "Fine" }, admin, db);
    ids.dressingRepeat = fresh.id;
    const otherItem = await failure(addLine(ids.xray, { repeat: fresh.id }));
    expect(otherItem?.code, otherItem?.message).toBe("23503");
    const otherVisit = await failure(
      addLine(ids.dressing, { repeat: fresh.id, visit: ids.otherVisit, bill: ids.otherBill }),
    );
    expect(otherVisit?.code, otherVisit?.message).toBe("23503");
    const lines = await one(
      `SELECT count(*)::int AS n FROM bill_lines WHERE repeat_request_id = $1`,
      [ids.repeat],
    );
    expect(lines.n).toBe(1);
  });

  test("6. an approval is only good for its own visit, its own item and its own kind", async () => {
    const request = await svc.getRequest(ids.dressingRepeat, db);
    expect(request).toMatchObject({ status: "approved", usable: true });
    await refused(
      svc.useRepeatApproval(
        request.id,
        { visitId: ids.otherVisit, serviceItemId: ids.dressing },
        desk,
        db,
      ),
      409,
      /another visit/,
      "other visit",
    );
    await refused(
      svc.useRepeatApproval(request.id, { visitId: ids.visit, serviceItemId: ids.xray }, desk, db),
      409,
      /another item/,
      "other item",
    );
    const pending = await repeatRequest(ids.xray);
    await refused(
      svc.useRepeatApproval(pending.id, { visitId: ids.visit, serviceItemId: ids.xray }, desk, db),
      409,
      /hasn't answered that request yet/,
      "pending",
    );
    const rejected = await svc.rejectRequest(pending.id, { note: "One is enough" }, admin, db);
    expect(rejected.status).toBe("rejected");
    await refused(
      svc.useRepeatApproval(pending.id, { visitId: ids.visit, serviceItemId: ids.xray }, desk, db),
      409,
      /was rejected/,
      "rejected",
    );
    const newItem = await newItemRequest(`Sling ${tag}`);
    await refused(
      svc.useRepeatApproval(newItem.id, { visitId: ids.visit, serviceItemId: ids.xray }, desk, db),
      409,
      /for a new item/,
      "new item",
    );
    await refused(
      svc.useRepeatApproval(
        "00000000-0000-4000-8000-000000000000",
        { visitId: ids.visit, serviceItemId: ids.xray },
        desk,
        db,
      ),
      404,
      /no longer exists/,
      "unknown",
    );
    ids.usedDressing = request.id;
  });

  test("7. an approved repeat is not asked for again, and a vanished line can't be approved", async () => {
    await refused(
      svc.createRepeatRequest(
        { service_item_id: ids.dressing, visit_id: ids.visit, reason: "Again" },
        desk,
        db,
      ),
      409,
      /already approved billing/,
      "approval waiting",
    );
    const gone = await repeatRequest(ids.xray);
    await query(
      `UPDATE bill_lines SET is_live = FALSE WHERE visit_id = $1 AND service_item_id = $2`,
      [ids.visit, ids.xray],
    );
    await refused(
      svc.approveRequest(gone.id, { note: "Too late" }, admin, db),
      409,
      /no longer on this visit's bill/,
      "line removed",
    );
    await query(`UPDATE bill_lines SET is_live = TRUE WHERE id = $1`, [ids.repeatLine]);
  });

  test("8. the inbox and the desk's panel both say whether an approval is still usable", async () => {
    const pending = await svc.listPendingRequests(db);
    expect(pending.some((r) => r.id === ids.repeat)).toBe(false);
    const mine = await svc.listMyRequests({ visitId: ids.visit }, desk, db);
    const used = mine.find((r) => r.id === ids.repeat);
    expect(used).toMatchObject({ status: "used", usable: false });
    expect(used.used_on.line_id).toBe(ids.repeatLine);
    const waiting = mine.find((r) => r.id === ids.usedDressing);
    expect(waiting).toMatchObject({ status: "approved", usable: true });
    expect(waiting.decision_note).toBe("Fine");
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
