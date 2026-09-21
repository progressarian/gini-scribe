import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { apiAs } from "../../helpers/auth.mjs";
import { query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const c = (name) => `${name}_${tag}`;
const M = "/api/billing/master";
const ids = {};
let api = null;

const call = async (method, path, data) => {
  const response = await api[method](path, data === undefined ? {} : { data });
  const body = await response.json().catch(() => null);
  return { status: response.status(), body };
};
const expectOk = async (method, path, data, status = 200) => {
  const r = await call(method, path, data);
  expect(r.status, `${method.toUpperCase()} ${path}: ${JSON.stringify(r.body)}`).toBe(status);
  return r.body;
};

test.describe.serial("P1-26 master data routes", () => {
  test.beforeAll(async () => {
    api = await apiAs("reception_admin");
    const doctor = await query(
      `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
      [`Dr Route ${tag}`],
    );
    ids.doctor = doctor.rows[0].id;
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("1. reception_admin can build the whole service master over HTTP", async () => {
    const group = await expectOk(
      "post",
      `${M}/groups`,
      { code: `RG-${tag}`, name: `Route group ${tag}` },
      201,
    );
    ids.group = group.id;
    const sub = await expectOk(
      "post",
      `${M}/subgroups`,
      { group_id: group.id, code: `RS-${tag}`, name: "Route sub" },
      201,
    );
    ids.sub = sub.id;
    await expectOk("patch", `${M}/groups/${group.id}`, { sort_order: 7 });
    const catalogue = await query(
      `INSERT INTO giniflow_test_catalog (test_name, price) VALUES ($1, 90) RETURNING id`,
      [`Route test ${tag}`],
    );
    const test1 = await expectOk(
      "post",
      `${M}/items`,
      {
        code: `RI-${tag}`,
        name: "Route test",
        subgroup_id: sub.id,
        base_price: "250.50",
        kind: "test",
        test_catalog_id: catalogue.rows[0].id,
      },
      201,
    );
    ids.item = test1.id;
    const consult = await expectOk(
      "post",
      `${M}/items`,
      {
        code: `RC-${tag}`,
        name: "Route consult",
        subgroup_id: sub.id,
        base_price: 900,
        kind: "consultation",
        doctor_id: ids.doctor,
        visit_type: "New",
      },
      201,
    );
    ids.consult = consult.id;
    await expectOk("patch", `${M}/items/${test1.id}`, { base_price: 300, reason: "New card" });
    const history = await expectOk("get", `${M}/items/${test1.id}/price-history`);
    expect(history.map((h) => h.new_price)).toEqual([300, 250.5]);
    const list = await expectOk("get", `${M}/items?groupId=${group.id}&active=true&q=route`);
    expect(list.items.map((i) => i.code).sort()).toEqual([`RC-${tag}`, `RI-${tag}`].sort());
    const notPriced = await expectOk("get", `${M}/items/not-priced`);
    expect(notPriced.tests.map((t) => t.test_name)).not.toContain(`Route test ${tag}`);
    expect(Array.isArray(await expectOk("get", `${M}/tax-codes?activeOnly=true`))).toBe(true);

    await expectOk(
      "post",
      `${M}/categories`,
      { code: c("cghs"), label: `CGHS ${tag}`, payer_name: "CGHS" },
      201,
    );
    await expectOk(
      "post",
      `${M}/categories`,
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      201,
    );
    await expectOk("patch", `${M}/categories/${c("paid")}`, { print_category_on_bill: true });
    const tree = await expectOk("get", `${M}/categories`);
    expect(tree.find((t) => t.code === c("cghs")).sub_categories.map((s) => s.code)).toEqual([
      c("paid"),
    ]);

    const rule = await expectOk(
      "post",
      `${M}/category-rules`,
      { scheme_code: c("paid"), name: "Card holders", requires_card: true, mode: "auto" },
      201,
    );
    ids.rule = rule.id;
    await expectOk("patch", `${M}/category-rules/${rule.id}`, { min_age: "60" });
    expect(
      (await expectOk("get", `${M}/category-rules?schemeCode=${c("paid")}`)).map((r) => r.name),
    ).toEqual(["Card holders"]);

    await expectOk("put", `${M}/category-rates`, {
      scheme_code: c("cghs"),
      service_item_id: consult.id,
      rate: 700,
      bill_code: "CC02",
      valid_from: "2026-01-01",
    });
    const grid = await expectOk(
      "get",
      `${M}/category-rates/${c("paid")}?groupId=${group.id}&date=2026-10-01`,
    );
    expect(grid.items.find((i) => i.service_item_id === consult.id)).toMatchObject({
      rate: 700,
      rate_source: "parent",
      bill_code: "CC02",
    });
    const rateHistory = await expectOk(
      "get",
      `${M}/category-rates/${c("cghs")}/items/${consult.id}`,
    );
    expect(rateHistory).toHaveLength(1);

    const audit = await query(
      `SELECT actor_id, ip FROM billing_audit WHERE entity = 'service_groups' AND entity_id = $1 ORDER BY id LIMIT 1`,
      [String(group.id)],
    );
    expect(audit.rows[0].actor_id, "the signed-in user is recorded").toBe(USERS.reception_admin.id);
  });

  test("2. refusals come back as clear 4xx with the details", async () => {
    const used = await call("delete", `${M}/groups/${ids.group}`);
    expect(used.status).toBe(409);
    expect(used.body.error).toMatch(/still used: 1 subgroup under Route group/);
    expect(used.body.uses).toEqual([
      expect.objectContaining({ table: "service_subgroups", count: 1 }),
    ]);
    const active = await call("put", `${M}/subgroups/${ids.sub}/active`, { is_active: false });
    expect(active.status).toBe(409);
    expect(active.body.active.sort()).toEqual(["Route consult", "Route test"]);
    const where = await expectOk("get", `${M}/usage/subgroup/${ids.sub}`);
    expect(where.uses[0].text).toBe("2 items in Route sub");
    const categoryUse = await expectOk("get", `${M}/usage/category/${c("cghs")}`);
    expect(categoryUse.uses.map((u) => u.table)).toContain("patient_schemes");
    const overlap = await call("put", `${M}/category-rates`, {
      scheme_code: c("cghs"),
      service_item_id: ids.consult,
      rate: 1,
      valid_from: "2026-06-01",
      valid_to: "2026-06-30",
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.conflicts).toHaveLength(1);
    const missing = await call("patch", `${M}/items/999999999`, { name: "X" });
    expect(missing.status).toBe(404);
  });

  test("3. every body endpoint uses its schema: unknown fields and bad values are 400", async () => {
    const bodies = [
      ["post", `${M}/groups`, { code: "X", name: "X" }],
      ["patch", `${M}/groups/${ids.group}`, { name: "X" }],
      ["put", `${M}/groups/${ids.group}/active`, { is_active: true }],
      ["post", `${M}/subgroups`, { group_id: ids.group, code: "X", name: "X" }],
      ["patch", `${M}/subgroups/${ids.sub}`, { name: "X" }],
      ["put", `${M}/subgroups/${ids.sub}/active`, { is_active: true }],
      [
        "post",
        `${M}/items`,
        { code: "X", name: "X", subgroup_id: ids.sub, base_price: 1, kind: "other" },
      ],
      ["patch", `${M}/items/${ids.item}`, { name: "X" }],
      ["put", `${M}/items/${ids.item}/active`, { is_active: true }],
      ["post", `${M}/categories`, { code: "x_x", label: "X" }],
      ["patch", `${M}/categories/${c("paid")}`, { label: "X" }],
      ["post", `${M}/category-rules`, { scheme_code: c("paid"), name: "X", min_age: 1 }],
      ["patch", `${M}/category-rules/${ids.rule}`, { name: "X" }],
      ["put", `${M}/category-rules/${ids.rule}/active`, { is_active: true }],
      [
        "put",
        `${M}/category-rates`,
        { scheme_code: c("cghs"), service_item_id: ids.consult, rate: 1 },
      ],
    ];
    for (const [method, path, body] of bodies) {
      const r = await call(method, path, { ...body, price_override: 1 });
      expect(r.status, `${method.toUpperCase()} ${path} with an unknown field`).toBe(400);
      expect(r.body.error).toBe("Unknown field: price_override");
    }
    const badValue = await call("post", `${M}/items`, {
      code: "X",
      name: "X",
      subgroup_id: ids.sub,
      base_price: -5,
      kind: "other",
    });
    expect(badValue.status).toBe(400);
    expect(badValue.body.error).toBe("Price must be 0 or more");
    const badActive = await call("put", `${M}/items/${ids.item}/active`, { is_active: "false" });
    expect(badActive.status).toBe(400);
    for (const path of [
      `${M}/items?active=yes`,
      `${M}/items?groupId=abc`,
      `${M}/groups?sort=name`,
      `${M}/category-rates/${c("cghs")}?date=01-01-2026`,
    ]) {
      expect((await call("get", path)).status, path).toBe(400);
    }
    for (const path of [
      `${M}/items/abc/price-history`,
      `${M}/items/99999999999/price-history`,
      `${M}/category-rates/NOT%20A%20CODE`,
      `${M}/usage/doctor/1`,
    ]) {
      expect((await call("get", path)).status, path).toBe(400);
    }
    const itemsBefore = await query(
      `SELECT count(*)::int AS n FROM service_items WHERE code = 'X'`,
    );
    expect(itemsBefore.rows[0].n, "nothing was created by the refused requests").toBe(0);
  });

  test("4. only admin and reception_admin can reach the master routes", async () => {
    const paths = [
      ["get", `${M}/groups`],
      ["post", `${M}/groups`, { code: `DENY-${tag}`, name: "Deny" }],
      ["get", `${M}/items`],
      ["patch", `${M}/items/${ids.item}`, { name: "Deny" }],
      ["delete", `${M}/category-rules/${ids.rule}`],
      [
        "put",
        `${M}/category-rates`,
        { scheme_code: c("cghs"), service_item_id: ids.consult, rate: 1 },
      ],
      ["get", `${M}/items/not-priced`],
    ];
    for (const role of ["reception", "coordinator", "lab"]) {
      const other = await apiAs(role);
      for (const [method, path, data] of paths) {
        const response = await other[method](path, data === undefined ? {} : { data });
        expect(response.status(), `${role} ${method.toUpperCase()} ${path}`).toBe(403);
      }
      await other.dispose();
    }
    const admin = await apiAs("admin");
    expect((await admin.get(`${M}/groups`)).status()).toBe(200);
    await admin.dispose();
    const denied = await query(`SELECT count(*)::int AS n FROM service_groups WHERE code = $1`, [
      `DENY-${tag}`,
    ]);
    expect(denied.rows[0].n).toBe(0);
  });

  test("5. deletes work through the routes when nothing uses the row", async () => {
    const spare = await expectOk(
      "post",
      `${M}/groups`,
      { code: `SP-${tag}`, name: `Spare ${tag}` },
      201,
    );
    expect(await expectOk("delete", `${M}/groups/${spare.id}`)).toEqual({
      deleted: true,
      id: spare.id,
    });
    const rule = await expectOk(
      "post",
      `${M}/category-rules`,
      { scheme_code: c("paid"), name: "Spare rule", min_age: 1 },
      201,
    );
    expect((await expectOk("delete", `${M}/category-rules/${rule.id}`)).deleted).toBe(true);
    const deleted = await expectOk(
      "delete",
      `${M}/category-rates/${c("cghs")}/items/${ids.consult}/2026-01-01`,
    );
    expect(deleted).toMatchObject({ deleted: true, previous: null });
  });

  test("6. a rate is deleted through its address; bad addresses and options are 400", async () => {
    await expectOk("put", `${M}/category-rates`, {
      scheme_code: c("cghs"),
      service_item_id: ids.consult,
      rate: 650,
      valid_from: "2027-01-01",
    });
    await expectOk("put", `${M}/category-rates`, {
      scheme_code: c("cghs"),
      service_item_id: ids.consult,
      rate: 660,
      valid_from: "2027-06-01",
    });
    const bad = [
      `${M}/category-rates/${c("cghs")}/items/${ids.consult}/2027-06-01?reopen_previous=yes`,
      `${M}/category-rates/${c("cghs")}/items/${ids.consult}/2027-06-01?other=1`,
      `${M}/category-rates/${c("cghs")}/items/${ids.consult}/01-06-2027`,
      `${M}/category-rates/${c("cghs")}/items/abc/2027-06-01`,
    ];
    for (const path of bad) expect((await call("delete", path)).status, path).toBe(400);
    const undone = await expectOk(
      "delete",
      `${M}/category-rates/${c("cghs")}/items/${ids.consult}/2027-06-01?reopen_previous=true`,
    );
    expect(undone.reopened).toMatchObject({ valid_from: "2027-01-01", valid_to: null });
    expect(
      (await call("delete", `${M}/category-rates/${c("cghs")}/items/${ids.consult}/2027-06-01`))
        .status,
    ).toBe(404);
  });
});
