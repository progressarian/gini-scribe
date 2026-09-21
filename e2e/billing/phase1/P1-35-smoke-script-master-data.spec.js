import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { apiAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { buildCatalogTest } from "../../helpers/builders.mjs";
import { buildTestEnv, repoRoot } from "../../setup/testEnv.mjs";

const tag = crypto.randomBytes(3).toString("hex");
const M = "/api/billing/master";
const up = (name) => `P135_${name}_${tag}`.toUpperCase();
const cat = (name) => `p135_${name}_${tag}`;
const seed = {};
let api = null;

const call = async (method, url, data) => {
  const response = await api[method](url, data === undefined ? {} : { data });
  return { status: response.status(), body: await response.json().catch(() => null) };
};
const ok = async (method, url, data, status = 200) => {
  const r = await call(method, url, data);
  expect(r.status, `${method.toUpperCase()} ${url}: ${JSON.stringify(r.body)}`).toBe(status);
  return r.body;
};

test.describe("P1-35 the smoke script itself", () => {
  test("1. npm run smoke:billing-master passes against the test database and leaves nothing", async () => {
    const before = await one(
      `SELECT (SELECT count(*) FROM service_groups)::int AS groups,
              (SELECT count(*) FROM service_items)::int AS items,
              (SELECT count(*) FROM patient_schemes)::int AS schemes,
              (SELECT count(*) FROM billing_audit)::int AS audit`,
    );
    const result = spawnSync("npm", ["run", "-s", "smoke:billing-master"], {
      cwd: path.join(repoRoot, "server"),
      env: buildTestEnv(),
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("localhost:5435/gini_scribe_test");
    expect(result.stdout).toContain("ALL OK (8/8)");
    expect(result.stdout).toMatch(
      /ℹ (Every test with an item bills at its old catalogue price\.|\d+ test\(s\) now bill at their item's price)/,
    );
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8])
      expect(result.stdout).toMatch(new RegExp(`✓ ${n}\\. `));
    const after = await one(
      `SELECT (SELECT count(*) FROM service_groups)::int AS groups,
              (SELECT count(*) FROM service_items)::int AS items,
              (SELECT count(*) FROM patient_schemes)::int AS schemes,
              (SELECT count(*) FROM billing_audit)::int AS audit`,
    );
    expect(after, "the rolled-back run changed nothing, audit log included").toEqual(before);
  });
});

test.describe.serial("P1-35 the same scenarios through the API as reception_admin", () => {
  test.beforeAll(async () => {
    api = await apiAs("reception_admin");
    seed.doctor = await one(
      `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
      [`Dr P135 ${tag}`],
    );
    seed.test = await buildCatalogTest({ test_name: `P135 Test ${tag}`, price: 320 });
  });

  test.afterAll(async () => {
    await api?.dispose();
    await query(`DELETE FROM category_item_rates WHERE scheme_code LIKE $1`, [`p135%${tag}`]);
    await query(`DELETE FROM category_rules WHERE scheme_code LIKE $1`, [`p135%${tag}`]);
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code LIKE $1)`,
      [`P135%${tag.toUpperCase()}`],
    );
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P135%${tag.toUpperCase()}`]);
    await query(`DELETE FROM service_subgroups WHERE code LIKE $1`, [`P135%${tag.toUpperCase()}`]);
    await query(`DELETE FROM service_groups WHERE code LIKE $1`, [`P135%${tag.toUpperCase()}`]);
    await query(`DELETE FROM patient_schemes WHERE parent_code LIKE $1`, [`p135%${tag}`]);
    await query(`DELETE FROM patient_schemes WHERE code LIKE $1`, [`p135%${tag}`]);
    if (seed.test) await query(`DELETE FROM giniflow_test_catalog WHERE id = $1`, [seed.test.id]);
    if (seed.doctor) await query(`DELETE FROM doctors WHERE id = $1`, [seed.doctor.id]);
  });

  test("2. create, update and delete one of each master row", async () => {
    seed.group = await ok("post", `${M}/groups`, { code: up("g"), name: `P135 ${tag}` }, 201);
    await ok("patch", `${M}/groups/${seed.group.id}`, { name: `P135 group ${tag}` });
    seed.subgroup = await ok(
      "post",
      `${M}/subgroups`,
      { group_id: seed.group.id, code: up("s"), name: "P135 sub" },
      201,
    );
    await ok("patch", `${M}/subgroups/${seed.subgroup.id}`, { name: "P135 subgroup" });
    seed.item = await ok(
      "post",
      `${M}/items`,
      {
        code: up("i"),
        name: "P135 dressing",
        subgroup_id: seed.subgroup.id,
        base_price: 200,
        kind: "procedure",
      },
      201,
    );
    const top = await ok(
      "post",
      `${M}/categories`,
      { code: cat("top"), label: `P135 ${tag}` },
      201,
    );
    await ok("patch", `${M}/categories/${top.code}`, { payer_name: "P135 payer" });
    const rule = await ok(
      "post",
      `${M}/category-rules`,
      { scheme_code: top.code, name: "P135 women", gender: "Female" },
      201,
    );
    await ok("patch", `${M}/category-rules/${rule.id}`, { priority: 7 });
    const saved = await ok("put", `${M}/category-rates`, {
      scheme_code: top.code,
      service_item_id: seed.item.id,
      rate: 150,
      bill_code: "P1",
    });
    await ok(
      "delete",
      `${M}/category-rates/${top.code}/items/${seed.item.id}/${saved.rate.valid_from}`,
    );
    await ok("delete", `${M}/category-rules/${rule.id}`);
    await ok("delete", `${M}/categories/${top.code}`);

    const spareGroup = await ok(
      "post",
      `${M}/groups`,
      { code: up("g2"), name: `P135 spare ${tag}` },
      201,
    );
    const spareSub = await ok(
      "post",
      `${M}/subgroups`,
      { group_id: spareGroup.id, code: up("s2"), name: "P135 spare sub" },
      201,
    );
    const spareItem = await ok(
      "post",
      `${M}/items`,
      {
        code: up("i2"),
        name: "P135 spare",
        subgroup_id: spareSub.id,
        base_price: 10,
        kind: "other",
      },
      201,
    );
    await ok("patch", `${M}/items/${spareItem.id}`, { unit: "box" });
    await ok("delete", `${M}/items/${spareItem.id}`);
    await ok("delete", `${M}/subgroups/${spareSub.id}`);
    await ok("delete", `${M}/groups/${spareGroup.id}`);
    const left = await one(
      `SELECT (SELECT count(*) FROM service_groups WHERE id = $1)::int
            + (SELECT count(*) FROM patient_schemes WHERE code = $2)::int
            + (SELECT count(*) FROM category_rules WHERE id = $3)::int AS n`,
      [spareGroup.id, top.code, rule.id],
    );
    expect(left.n).toBe(0);
  });

  test("3. deleting a row that is still used is refused, with the list of uses", async () => {
    const r = await call("delete", `${M}/subgroups/${seed.subgroup.id}`);
    expect(r.status).toBe(409);
    expect(r.body.uses.map((u) => u.text).join(" ")).toContain("1 item");
    expect((await call("delete", `${M}/groups/${seed.group.id}`)).status).toBe(409);
  });

  test("4. CGHS › Pensioner is accepted; a child under Pensioner is refused", async () => {
    await ok("post", `${M}/categories`, { code: cat("cghs"), label: `P135 CGHS ${tag}` }, 201);
    const pensioner = await ok(
      "post",
      `${M}/categories`,
      { code: cat("pen"), label: "Pensioner", parent_code: cat("cghs") },
      201,
    );
    expect(pensioner.display_label).toBe(`P135 CGHS ${tag} › Pensioner`);
    const deep = await call("post", `${M}/categories`, {
      code: cat("deep"),
      label: "Too deep",
      parent_code: cat("pen"),
    });
    expect(deep.status).toBe(409);
  });

  test("5. a second consultation item for the same doctor and visit type is refused", async () => {
    const body = {
      name: "P135 consultation",
      subgroup_id: seed.subgroup.id,
      base_price: 900,
      kind: "consultation",
      doctor_id: seed.doctor.id,
      visit_type: "New",
    };
    await ok("post", `${M}/items`, { ...body, code: up("c1") }, 201);
    const again = await call("post", `${M}/items`, { ...body, code: up("c2"), name: "Again" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already an active New consultation item/);
  });

  test("6. a price change writes the price history", async () => {
    const noReason = await call("patch", `${M}/items/${seed.item.id}`, { base_price: 240 });
    expect(noReason.status).toBe(400);
    await ok("patch", `${M}/items/${seed.item.id}`, { base_price: 240, reason: "P135 change" });
    const history = await ok("get", `${M}/items/${seed.item.id}/price-history`);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ old_price: 200, new_price: 240, reason: "P135 change" });
  });

  test("7. the floor's test prices are unchanged, and follow a new item", async () => {
    const floor = async () => (await ok("get", "/api/giniflow/stations/reception/catalog")).tests;
    const expected = Object.fromEntries(
      (
        await query(
          `SELECT c.test_name,
                  COALESCE((SELECT i.base_price FROM service_items i
                             WHERE i.test_catalog_id = c.id AND i.is_active), c.price)::float AS price
             FROM giniflow_test_catalog c WHERE c.is_active`,
        )
      ).rows.map((r) => [r.test_name, r.price]),
    );
    const listed = await floor();
    expect(listed.length).toBe(Object.keys(expected).length);
    for (const t of listed) expect(t.price, t.name).toBe(expected[t.name]);
    expect(listed.find((t) => t.name === `P135 Test ${tag}`)?.price).toBe(320);

    await ok(
      "post",
      `${M}/items`,
      {
        code: up("lab"),
        name: "P135 lab",
        subgroup_id: seed.subgroup.id,
        base_price: 345,
        kind: "test",
        test_catalog_id: seed.test.id,
      },
      201,
    );
    expect((await floor()).find((t) => t.name === `P135 Test ${tag}`)?.price).toBe(345);
  });
});
