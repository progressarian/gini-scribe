import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/serviceItems.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.3.3.3" };
const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
const code = (name) => `${name}-${tag}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);
const one = (sql, params) => query(sql, params).then((r) => r.rows[0]);
const ids = {};

const base = (overrides = {}) => ({
  code: code(`I${crypto.randomBytes(2).toString("hex")}`),
  name: `Item ${crypto.randomBytes(3).toString("hex")}`,
  subgroup_id: ids.sub,
  base_price: 100,
  kind: "procedure",
  ...overrides,
});

const expectRefused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, label).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};

test.describe.serial("P1-17 service items service", () => {
  test.beforeAll(async () => {
    const group = await one(
      `INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`,
      [code("G"), `Items group ${tag}`],
    );
    ids.group = group.id;
    ids.sub = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Procedures') RETURNING id`,
        [group.id, code("S")],
      )
    ).id;
    ids.sub2 = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Consultations') RETURNING id`,
        [group.id, code("S2")],
      )
    ).id;
    ids.offSub = (
      await one(
        `INSERT INTO service_subgroups (group_id, code, name, is_active) VALUES ($1, $2, 'Closed', FALSE) RETURNING id`,
        [group.id, code("S3")],
      )
    ).id;
    ids.tax = (
      await one(`INSERT INTO tax_codes (code, rate_pct) VALUES ($1, 18) RETURNING id`, [code("T")])
    ).id;
    ids.offTax = (
      await one(`INSERT INTO tax_codes (code, is_active) VALUES ($1, FALSE) RETURNING id`, [
        code("T0"),
      ])
    ).id;
    ids.labOnly = (
      await one(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ('Dr. Hospital Admin', 'consultant', 'x', TRUE) RETURNING id`,
      )
    ).id;
    ids.gone = (
      await one(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', FALSE) RETURNING id`,
        [`Dr Retired ${tag}`],
      )
    ).id;
    ids.hba1c = (await one(`SELECT id FROM giniflow_test_catalog WHERE test_name = 'HbA1c'`)).id;
    ids.abi = (await one(`SELECT id FROM giniflow_test_catalog WHERE test_name = 'ABI'`)).id;
    ids.retired = (
      await one(
        `INSERT INTO giniflow_test_catalog (test_name, price, is_active) VALUES ($1, 10, FALSE) RETURNING id`,
        [`Retired test ${tag}`],
      )
    ).id;
  });

  test("1. create each kind with the planned defaults, price history and audit", async () => {
    const dressing = await svc.createItem(
      base({ code: code("DRESS"), name: "Dressing", base_price: "250.50" }),
      ctx,
      db,
    );
    expect(dressing).toMatchObject({
      base_price: 250.5,
      unit: "each",
      allow_quantity: false,
      max_quantity: null,
      tax_code_id: null,
      price_includes_tax: false,
      is_active: true,
    });
    ids.dressing = dressing.id;
    const consult = await svc.createItem(
      base({
        code: code("C-NEW"),
        name: "Consultation New",
        subgroup_id: ids.sub2,
        kind: "consultation",
        doctor_id: CONSULTANTS.rahul.id,
        visit_type: "New",
        base_price: 700,
      }),
      ctx,
      db,
    );
    ids.rahulNew = consult.id;
    const fallback = await svc.createItem(
      base({
        code: code("C-DEF"),
        name: "Consultation default FU",
        subgroup_id: ids.sub2,
        kind: "consultation",
        visit_type: "Follow Up",
        base_price: 500,
      }),
      ctx,
      db,
    );
    expect(fallback.doctor_id).toBeNull();
    ids.defaultFu = fallback.id;
    const hba1c = await svc.createItem(
      base({
        code: code("HBA1C"),
        name: "HbA1c",
        kind: "test",
        test_catalog_id: ids.hba1c.toUpperCase(),
        tax_code_id: ids.tax,
        allow_quantity: true,
        max_quantity: 2,
      }),
      ctx,
      db,
    );
    expect(hba1c).toMatchObject({
      test_catalog_id: ids.hba1c,
      tax_code_id: ids.tax,
      max_quantity: 2,
    });
    ids.hba1cItem = hba1c.id;
    const history = await svc.priceHistory(dressing.id, db);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      old_price: null,
      new_price: 250.5,
      reason: "Created",
      changed_by: ctx.actorId,
    });
    const audit = await query(
      `SELECT action, actor_id FROM billing_audit WHERE entity = 'service_items' AND entity_id = $1`,
      [String(dressing.id)],
    );
    expect(audit.rows).toEqual([{ action: "create", actor_id: ctx.actorId }]);
  });

  test("2. the shape of an item is checked, with clear messages", async () => {
    const cases = [
      [{ kind: "consultation", subgroup_id: ids.sub2 }, 400, /needs a visit type/],
      [
        { kind: "consultation", visit_type: "Investigation" },
        400,
        /Visit type must be one of: New, Follow Up/,
      ],
      [{ doctor_id: CONSULTANTS.rahul.id }, 400, /Only consultation items have a doctor/],
      [{ visit_type: "New" }, 400, /Only consultation items have a doctor/],
      [{ kind: "test" }, 400, /must be linked to a test/],
      [{ test_catalog_id: ids.abi }, 400, /Only test items are linked/],
      [{ test_catalog_id: "not-a-uuid", kind: "test" }, 400, /valid test/],
      [{ max_quantity: 3 }, 400, /only applies when quantity is allowed/],
      [{ allow_quantity: true, max_quantity: 0 }, 400, /1 or more/],
      [{ allow_quantity: "true" }, 400, /Allow quantity must be true or false/],
      [{ price_includes_tax: true }, 400, /only applies when the item has a tax code/],
      [{ base_price: -1 }, 400, /can't be negative/],
      [{ base_price: 10.005 }, 400, /at most 2 decimals/],
      [{ base_price: undefined }, 400, /Base price is required/],
      [{ base_price: true }, 400, /amount in rupees/],
      [{ kind: "package" }, 400, /Kind must be one of/],
      [{ unit: "  " }, 400, /Unit can't be blank/],
      [{ code: "A B" }, 400, /blank or contain spaces/],
      [{ name: "" }, 400, /Name can't be blank/],
      [{ subgroup_id: undefined }, 400, /Choose a subgroup/],
      [{ code: code("dress") }, 409, /already exists/],
      [{ name: "DRESSING" }, 409, /An item called "Dressing" already exists in Procedures/],
    ];
    for (const [overrides, status, message] of cases) {
      const input = base(overrides);
      for (const [key, value] of Object.entries(overrides))
        if (value === undefined) delete input[key];
      await expectRefused(
        svc.createItem(input, ctx, db),
        status,
        message,
        JSON.stringify(overrides),
      );
    }
  });

  test("3. links must point at active, real things", async () => {
    const consult = (extra) =>
      base({ kind: "consultation", subgroup_id: ids.sub2, visit_type: "Follow Up", ...extra });
    await expectRefused(
      svc.createItem(base({ subgroup_id: ids.offSub }), ctx, db),
      409,
      /Closed is deactivated/,
    );
    await expectRefused(
      svc.createItem(base({ subgroup_id: 999999999 }), ctx, db),
      404,
      /subgroup no longer exists/,
    );
    await expectRefused(
      svc.createItem(base({ tax_code_id: ids.offTax }), ctx, db),
      409,
      /is deactivated/,
    );
    await expectRefused(
      svc.createItem(consult({ doctor_id: ids.gone }), ctx, db),
      409,
      /not an active doctor/,
    );
    await expectRefused(
      svc.createItem(consult({ doctor_id: ids.labOnly }), ctx, db),
      409,
      /lab-only provider/,
    );
    await expectRefused(
      svc.createItem(consult({ doctor_id: 999999999 }), ctx, db),
      404,
      /doctor no longer exists/,
    );
    await expectRefused(
      svc.createItem(base({ kind: "test", test_catalog_id: ids.retired }), ctx, db),
      409,
      /retired/,
    );
    await expectRefused(
      svc.createItem(
        base({ kind: "test", test_catalog_id: "00000000-0000-0000-0000-000000000000" }),
        ctx,
        db,
      ),
      404,
      /not in the test catalogue/,
    );
    await expectRefused(
      svc.createItem(base({ kind: "test", test_catalog_id: ids.hba1c }), ctx, db),
      409,
      /HbA1c already has an item/,
    );
  });

  test("4. one active consultation item per doctor and visit type, and one default", async () => {
    await expectRefused(
      svc.createItem(
        base({
          kind: "consultation",
          subgroup_id: ids.sub2,
          doctor_id: CONSULTANTS.rahul.id,
          visit_type: "New",
        }),
        ctx,
        db,
      ),
      409,
      /already an active New consultation item for this doctor/,
    );
    await expectRefused(
      svc.createItem(
        base({ kind: "consultation", subgroup_id: ids.sub2, visit_type: "Follow Up" }),
        ctx,
        db,
      ),
      409,
      /for the hospital default/,
    );
    await svc.setItemActive(ids.rahulNew, false, ctx, db);
    const replacement = await svc.createItem(
      base({
        code: code("C-NEW2"),
        name: "Consultation New v2",
        kind: "consultation",
        subgroup_id: ids.sub2,
        doctor_id: CONSULTANTS.rahul.id,
        visit_type: "New",
        base_price: 800,
      }),
      ctx,
      db,
    );
    expect(replacement.is_active).toBe(true);
    await expectRefused(
      svc.setItemActive(ids.rahulNew, true, ctx, db),
      409,
      /already an active New consultation/,
    );
  });

  test("5. two simultaneous creates for the same doctor and visit type: the second gets a 409", async () => {
    const make = (n, dbOrClient) =>
      svc.createItem(
        base({
          code: code(`RACE${n}`),
          name: `Race ${n}`,
          kind: "consultation",
          subgroup_id: ids.sub2,
          doctor_id: CONSULTANTS.beant.id,
          visit_type: "New",
        }),
        ctx,
        dbOrClient,
      );
    const first = await db.connect();
    try {
      await first.query("BEGIN");
      await make(1, first);
      const second = failure(make(2, db));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query("COMMIT");
      const error = await second;
      expect(error?.status).toBe(409);
      expect(error.message).toBe(
        "There is already an active consultation item for that doctor and visit type",
      );
    } finally {
      await first.query("ROLLBACK").catch(() => {});
      first.release();
    }
    const saved = await query(
      `SELECT count(*)::int AS n FROM service_items WHERE doctor_id = $1 AND visit_type = 'New' AND is_active`,
      [CONSULTANTS.beant.id],
    );
    expect(saved.rows[0].n).toBe(1);
  });

  test("6. update: a price change needs a reason and writes history; other edits don't", async () => {
    await expectRefused(
      svc.updateItem(ids.dressing, { base_price: 300 }, ctx, db),
      400,
      /reason for the price change/,
    );
    const updated = await svc.updateItem(
      ids.dressing,
      { base_price: 300, reason: "New rate card" },
      ctx,
      db,
    );
    expect(updated.base_price).toBe(300);
    const same = await svc.updateItem(
      ids.dressing,
      { base_price: "300.00", name: "Dressing (small)" },
      ctx,
      db,
    );
    expect(same.name).toBe("Dressing (small)");
    const history = await svc.priceHistory(ids.dressing, db);
    expect(history.map((h) => [h.old_price, h.new_price, h.reason])).toEqual([
      [250.5, 300, "New rate card"],
      [null, 250.5, "Created"],
    ]);
    expect(history[0].changed_by_name).toBe(USERS.reception_admin.name);
    await expectRefused(
      svc.updateItem(ids.defaultFu, { kind: "procedure" }, ctx, db),
      400,
      /Only consultation items have a doctor/,
    );
    const changed = await svc.updateItem(
      ids.defaultFu,
      { kind: "procedure", visit_type: null },
      ctx,
      db,
    );
    expect(changed).toMatchObject({ kind: "procedure", visit_type: null, doctor_id: null });
    const inclusive = await svc.createItem(
      base({ name: "Inclusive", tax_code_id: ids.tax, price_includes_tax: true }),
      ctx,
      db,
    );
    expect(inclusive.price_includes_tax).toBe(true);
    await expectRefused(
      svc.updateItem(inclusive.id, { tax_code_id: null }, ctx, db),
      400,
      /only applies when the item has a tax code/,
    );
    const plain = await svc.updateItem(
      inclusive.id,
      { tax_code_id: null, price_includes_tax: false },
      ctx,
      db,
    );
    expect(plain).toMatchObject({ tax_code_id: null, price_includes_tax: false });
    await expectRefused(svc.updateItem(ids.dressing, {}, ctx, db), 400, /Nothing to change/);
    await expectRefused(svc.updateItem(999999999, { name: "X" }, ctx, db), 404);
    await expectRefused(
      svc.updateItem(ids.dressing, { subgroup_id: ids.offSub }, ctx, db),
      409,
      /Closed is deactivated/,
    );
  });

  test("7. the list searches and filters, with names joined in", async () => {
    const all = await svc.listItems({ groupId: ids.group }, db);
    expect(all.total).toBe(all.items.length);
    expect(all.items.every((i) => i.group_name === `Items group ${tag}`)).toBe(true);
    const hb = await svc.listItems({ q: "hba1c", groupId: ids.group }, db);
    expect(hb.items.map((i) => i.id)).toEqual([ids.hba1cItem]);
    expect(hb.items[0]).toMatchObject({
      test_name: "HbA1c",
      tax_code: code("T"),
      subgroup_name: "Procedures",
    });
    const byCode = await svc.listItems({ q: code("DRESS").toLowerCase() }, db);
    expect(byCode.items.map((i) => i.id)).toEqual([ids.dressing]);
    expect(
      (await svc.listItems({ q: "%", groupId: ids.group }, db)).total,
      "% is searched literally",
    ).toBe(0);
    const consults = await svc.listItems(
      { kind: "consultation", doctorId: CONSULTANTS.rahul.id },
      db,
    );
    expect(consults.items.every((i) => i.doctor_name === CONSULTANTS.rahul.name)).toBe(true);
    const inactive = await svc.listItems({ active: false, groupId: ids.group }, db);
    expect(inactive.items.map((i) => i.id)).toContain(ids.rahulNew);
    const page = await svc.listItems({ groupId: ids.group, limit: 2, offset: 1 }, db);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(all.total);
    await expectRefused(svc.listItems({ active: "true" }, db), 400);
  });

  test("8. reactivating re-checks the subgroup and tax code", async () => {
    await svc.setItemActive(ids.hba1cItem, false, ctx, db);
    await query(`UPDATE tax_codes SET is_active = FALSE WHERE id = $1`, [ids.tax]);
    await expectRefused(svc.setItemActive(ids.hba1cItem, true, ctx, db), 409, /is deactivated/);
    await query(`UPDATE tax_codes SET is_active = TRUE WHERE id = $1`, [ids.tax]);
    const on = await svc.setItemActive(ids.hba1cItem, true, ctx, db);
    expect(on.is_active).toBe(true);
    await expectRefused(svc.setItemActive(ids.hba1cItem, "false", ctx, db), 400, /true or false/);
  });

  test("9. a used item can't be deleted; an unused one takes its history with it", async () => {
    await query(
      `INSERT INTO category_item_rates (scheme_code, service_item_id, rate) VALUES ('cghs', $1, 200)`,
      [ids.dressing],
    );
    const used = await expectRefused(svc.deleteItem(ids.dressing, ctx, db), 409);
    expect(used.message).toBe(
      "Dressing (small) can't be deleted because it is still used: 1 category rate for Dressing (small). Deactivate it instead.",
    );
    const spare = await svc.createItem(base({ name: "Spare" }), ctx, db);
    expect(await svc.deleteItem(spare.id, ctx, db)).toEqual({ deleted: true, id: spare.id });
    expect(await svc.priceHistory(spare.id, db)).toEqual([]);
    const audit = await query(
      `SELECT action FROM billing_audit WHERE entity = 'service_items' AND entity_id = $1 ORDER BY id`,
      [String(spare.id)],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["create", "delete"]);
  });

  test("10. inside a caller's transaction it joins it", async () => {
    const outer = await db.connect();
    try {
      await outer.query("BEGIN");
      await svc.createItem(base({ code: code("TX"), name: "Tx item" }), ctx, outer);
      await outer.query("ROLLBACK");
    } finally {
      outer.release();
    }
    expect((await query(`SELECT 1 FROM service_items WHERE code = $1`, [code("TX")])).rows).toEqual(
      [],
    );
  });
});
