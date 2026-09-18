import { test, expect } from "@playwright/test";
import { getPool } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { USAGE_KINDS, assertUnused, whereUsed } =
  await import("../../../server/services/billing/usage.js");

let client = null;
const ids = {};

const insert = async (sql, params = []) => (await client.query(sql, params)).rows[0];

test.describe.serial("P1-14 where-is-it-used helper", () => {
  test.beforeAll(async () => {
    client = await getPool().connect();
    await client.query("BEGIN");
    ids.lab = (
      await insert(`INSERT INTO service_groups (code, name) VALUES ('U-LAB', 'Lab') RETURNING id`)
    ).id;
    ids.empty = (
      await insert(
        `INSERT INTO service_groups (code, name) VALUES ('U-EMPTY', 'Empty') RETURNING id`,
      )
    ).id;
    ids.bio = (
      await insert(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'U-BIO', 'Biochemistry') RETURNING id`,
        [ids.lab],
      )
    ).id;
    await insert(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'U-HAEM', 'Haematology') RETURNING id`,
      [ids.lab],
    );
    ids.tax = (
      await insert(`INSERT INTO tax_codes (code, rate_pct) VALUES ('U-GST18', 18) RETURNING id`)
    ).id;
    ids.unusedTax = (await insert(`INSERT INTO tax_codes (code) VALUES ('U-NIL') RETURNING id`)).id;
    const item = (code, name) =>
      insert(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, tax_code_id)
         VALUES ($1, $2, $3, 100, 'procedure', $4) RETURNING id`,
        [code, name, ids.bio, ids.tax],
      );
    ids.dressing = (await item("U-DRESS", "Dressing")).id;
    await item("U-SUTURE", "Suture");
    await item("U-PLASTER", "Plaster");
    await insert(
      `INSERT INTO patient_schemes (code, label) VALUES ('u_cghs', 'CGHS') RETURNING code`,
    );
    await insert(
      `INSERT INTO patient_schemes (code, label) VALUES ('u_unused', 'Unused') RETURNING code`,
    );
    for (const [code, label] of [
      ["u_paid", "CGHS Paid"],
      ["u_referral", "CGHS Referral"],
      ["u_pensioner", "Pensioner"],
    ]) {
      await insert(
        `INSERT INTO patient_schemes (code, label, parent_code) VALUES ($1, $2, 'u_cghs') RETURNING code`,
        [code, label],
      );
    }
    for (const name of ["Card holders", "Over 60"]) {
      await insert(
        `INSERT INTO category_rules (scheme_code, name, min_age) VALUES ('u_cghs', $1, 60) RETURNING id`,
        [name],
      );
    }
    await insert(
      `INSERT INTO category_item_rates (scheme_code, service_item_id, rate) VALUES ('u_cghs', $1, 80) RETURNING rate`,
      [ids.dressing],
    );
    for (let i = 0; i < 2; i++) {
      await insert(`INSERT INTO patients (name, scheme_code) VALUES ($1, 'u_cghs') RETURNING id`, [
        `E2E Usage ${i}`,
      ]);
    }
    const patient = await insert(
      `INSERT INTO patients (name) VALUES ('E2E Usage visit') RETURNING id`,
    );
    const visit = await insert(
      `INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`,
      [patient.id],
    );
    for (let i = 0; i < 3; i++) {
      await insert(
        `INSERT INTO giniflow_lab_orders (visit_id, scheme_code) VALUES ($1, 'u_cghs') RETURNING id`,
        [visit.id],
      );
    }
    await insert(
      `INSERT INTO scheme_cap_overrides (scheme_code, appointment_date, booked_at_override, cap_at_override)
       VALUES ('u_cghs', CURRENT_DATE, 10, 10) RETURNING scheme_code`,
    );
    for (let i = 0; i < 4; i++) {
      await insert(
        `INSERT INTO appointments (patient_name, patient_category, appointment_date)
         VALUES ('E2E Usage', 'u_cghs', CURRENT_DATE) RETURNING id`,
      );
    }
  });
  test.afterAll(async () => {
    await client?.query("ROLLBACK").catch(() => {});
    client?.release();
  });

  test("1. an unused row of every kind has no uses", async () => {
    for (const [kind, key] of [
      ["group", ids.empty],
      ["taxCode", ids.unusedTax],
      ["category", "u_unused"],
      ["category", "u_pensioner"],
    ]) {
      expect((await whereUsed(kind, key, client)).uses, `${kind} ${key}`).toEqual([]);
    }
  });

  test("2. a used category lists every use in plain words", async () => {
    const { name, uses } = await whereUsed("category", "u_cghs", client);
    expect(name).toBe("CGHS");
    expect(uses.map((u) => u.text)).toEqual([
      "3 sub-categories under CGHS",
      "2 category rules for CGHS",
      "1 category rate for CGHS",
      "2 patients are recorded as CGHS",
      "3 test orders are priced as CGHS",
      "1 daily-limit override is recorded for CGHS",
      "4 appointments are booked as CGHS",
    ]);
  });

  test("3. groups, subgroups, items and tax codes read correctly", async () => {
    const texts = async (kind, key) => (await whereUsed(kind, key, client)).uses.map((u) => u.text);
    expect(await texts("group", ids.lab)).toEqual(["2 subgroups under Lab"]);
    expect(await texts("subgroup", ids.bio)).toEqual(["3 items in Biochemistry"]);
    expect(await texts("item", ids.dressing)).toEqual(["1 category rate for Dressing"]);
    expect(await texts("taxCode", ids.tax)).toEqual(["3 items use tax code U-GST18"]);
  });

  test("4. assertUnused refuses a used row with 409 and the list, and passes an unused one", async () => {
    const error = await assertUnused("subgroup", ids.bio, client).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      "Biochemistry can't be deleted because it is still used: 3 items in Biochemistry. Deactivate it instead.",
    );
    expect(error.uses).toEqual([
      { table: "service_items", column: "subgroup_id", count: 3, text: "3 items in Biochemistry" },
    ]);
    await expect(assertUnused("group", ids.empty, client)).resolves.toEqual({ name: "Empty" });
  });

  test("5. an unknown row is a 404 and an unknown kind is refused", async () => {
    const missing = await whereUsed("category", "u_nope", client).catch((e) => e);
    expect(missing.status).toBe(404);
    for (const kind of ["doctor", "constructor", "toString", "__proto__"]) {
      await expect(whereUsed(kind, 1, client), kind).rejects.toThrow(/unknown kind/);
    }
  });

  test("6. every blocking database link into these tables is covered", async () => {
    const tables = [...new Set(Object.values(USAGE_KINDS).map((k) => k.table))];
    const { rows } = await client.query(
      `SELECT c.confrelid::regclass::text AS target, c.conrelid::regclass::text AS source,
              a.attname AS column
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confdeltype <> 'c'
          AND c.confrelid::regclass::text = ANY($1)`,
      [tables],
    );
    expect(rows.length).toBeGreaterThan(0);
    const covered = new Set(
      Object.values(USAGE_KINDS).flatMap((k) =>
        k.uses.map((u) => `${k.table}<-${u.table}.${u.column}`),
      ),
    );
    const missing = rows
      .map((r) => `${r.target}<-${r.source}.${r.column}`)
      .filter((link) => !covered.has(link));
    expect(missing, "links the usage list doesn't check").toEqual([]);
  });

  test("7. every column that holds a category code is counted as a use", async () => {
    const DROPPED_LATER = ["scheme_test_prices", "scheme_opd_fees", "scheme_medicine_prices"];
    const { rows } = await client.query(
      `SELECT c.table_name AS source, c.column_name AS column
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.column_name IN ('scheme_code', 'patient_category', 'parent_code')
          AND NOT (c.table_name = ANY($1))`,
      [DROPPED_LATER],
    );
    expect(rows.length).toBeGreaterThan(0);
    const covered = new Set(USAGE_KINDS.category.uses.map((u) => `${u.table}.${u.column}`));
    const missing = rows
      .map((r) => `${r.source}.${r.column}`)
      .filter((column) => !covered.has(column));
    expect(missing, "category columns the usage list doesn't check").toEqual([]);
  });
});
