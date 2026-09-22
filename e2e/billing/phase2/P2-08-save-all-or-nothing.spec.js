import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { commitUpload: commitWith } =
  await import("../../../server/services/billing/importCommit.js");
const commitUpload = (buffer, input, db = getPool()) => commitWith(buffer, input, db);
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const G = `P208G_${T}`;
const S = `P208S_${T}`;
const I1 = `P208-A_${T}`;
const I2 = `P208-B_${T}`;
const TOP = `p208_${tag}`;
const SUB = `p208_sub_${tag}`;
const ctx = { actorId: USERS.reception_admin.id, ip: "127.0.0.1" };
const admin = { canChangeDailyCap: true };

async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await templateBuffer({ examples: false }));
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.getWorksheet(name);
    const headers = ws.getRow(1).values.slice(1);
    for (const cells of rows) ws.addRow(headers.map((h) => cells[h] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const FULL = {
  Groups: [{ group_code: G, name: `P208 Group ${T}` }],
  Subgroups: [{ subgroup_code: S, group_code: G, name: `P208 Sub ${T}` }],
  Items: [
    {
      item_code: I1,
      name: `P208 Dressing ${T}`,
      subgroup_code: S,
      base_price: 150,
      kind: "procedure",
    },
    { item_code: I2, name: `P208 Kit ${T}`, subgroup_code: S, base_price: 90, kind: "other" },
  ],
  Categories: [
    { category_code: TOP, label: `P208 Scheme ${T}`, payer_name: "P208 Payer" },
    { category_code: SUB, label: "P208 Paid", parent_code: TOP },
  ],
  "Category rules": [{ category_code: SUB, rule_name: "Over 60", min_age: 60, mode: "suggest" }],
  "Category rates": [
    { category_code: TOP, item_code: I1, valid_from: "2026-04-01", rate: 120, bill_code: "PX208" },
  ],
};

async function snapshot() {
  const one = async (sql, params) => (await query(sql, params)).rows;
  return {
    groups: await one(
      `SELECT code, name, is_active FROM service_groups WHERE code ILIKE $1 ORDER BY code`,
      ["P208G%"],
    ),
    subgroups: await one(
      `SELECT code, name, is_active FROM service_subgroups WHERE code ILIKE $1 ORDER BY code`,
      ["P208S%"],
    ),
    items: await one(
      `SELECT code, name, base_price::text, is_active FROM service_items WHERE code ILIKE $1 ORDER BY code`,
      ["P208-%"],
    ),
    categories: await one(
      `SELECT code, label, parent_code, payer_name, daily_cap, is_active FROM patient_schemes WHERE code LIKE $1 ORDER BY code`,
      ["p208%"],
    ),
    rules: await one(
      `SELECT scheme_code, name, min_age FROM category_rules WHERE scheme_code LIKE $1 ORDER BY name`,
      ["p208%"],
    ),
    rates: await one(
      `SELECT scheme_code, valid_from::text, valid_to::text, rate::text, bill_code
         FROM category_item_rates WHERE scheme_code LIKE $1 ORDER BY valid_from`,
      ["p208%"],
    ),
  };
}

const importsNamed = async (file) =>
  (
    await query(
      `SELECT id, status, imported_by, counts FROM billing_imports WHERE file_name = $1 ORDER BY id`,
      [file],
    )
  ).rows;

function failingPool(pattern) {
  const pool = getPool();
  return {
    query: (...args) => pool.query(...args),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (text, params) =>
          pattern.test(String(text?.text ?? text))
            ? Promise.reject(new Error("the disk is full"))
            : client.query(text, params),
        release: () => client.release(),
      };
    },
  };
}

test.describe.serial("P2-08 save all or nothing", () => {
  test.afterAll(async () => {
    await query(`DELETE FROM category_item_rates WHERE scheme_code LIKE $1`, ["p208%"]);
    await query(`DELETE FROM category_rules WHERE scheme_code LIKE $1`, ["p208%"]);
    await query(`DELETE FROM patient_schemes WHERE parent_code LIKE $1`, ["p208%"]);
    await query(`DELETE FROM patient_schemes WHERE code LIKE $1`, ["p208%"]);
    await query(`DELETE FROM service_items WHERE code ILIKE $1`, ["P208-%"]);
    await query(`DELETE FROM doctors WHERE name = $1`, [`Dr P208 ${T}`]);
    await query(`DELETE FROM service_subgroups WHERE code ILIKE $1`, ["P208S%"]);
    await query(`DELETE FROM service_groups WHERE code ILIKE $1`, ["P208G%"]);
  });

  test("1. a failure halfway through the save leaves the database unchanged", async () => {
    const before = await snapshot();
    const file = `p208-fail-${tag}.xlsx`;
    const tagged = async () =>
      (
        await query(
          `SELECT count(*)::int AS n FROM billing_audit
            WHERE after::text ILIKE $1 OR before::text ILIKE $1`,
          [`%${tag}%`],
        )
      ).rows[0].n;
    const auditBefore = await tagged();
    const error = await commitUpload(
      await workbook(FULL),
      { fileName: file, ctx, options: admin },
      failingPool(/INSERT INTO category_item_rates/),
    ).catch((e) => e);
    expect(error.message).toBe("the disk is full");
    expect(await snapshot(), "no group, item, category, rule or rate was kept").toEqual(before);
    expect(await tagged(), "no audit row survives").toBe(auditBefore);
    expect(await importsNamed(file), "the failed attempt is recorded").toMatchObject([
      { status: "failed", imported_by: ctx.actorId },
    ]);
  });

  test("2. a clean file saves every sheet in one go, with its import record and audit trail", async () => {
    const file = `p208-${tag}.xlsx`;
    const result = await commitUpload(await workbook(FULL), {
      fileName: file,
      ctx,
      options: admin,
    });
    expect(result.saved).toBe(true);
    const saved = await snapshot();
    expect(saved.groups).toEqual([{ code: G, name: `P208 Group ${T}`, is_active: true }]);
    expect(saved.items.map((i) => [i.code, i.base_price])).toEqual([
      [I1, "150.00"],
      [I2, "90.00"],
    ]);
    expect(saved.categories).toMatchObject([
      { code: TOP, parent_code: null, payer_name: "P208 Payer" },
      { code: SUB, parent_code: TOP },
    ]);
    expect(saved.rules).toEqual([{ scheme_code: SUB, name: "Over 60", min_age: 60 }]);
    expect(saved.rates).toEqual([
      {
        scheme_code: TOP,
        valid_from: "2026-04-01",
        valid_to: null,
        rate: "120.00",
        bill_code: "PX208",
      },
    ]);

    const [record] = await importsNamed(file);
    expect(record).toMatchObject({
      id: result.importId,
      status: "saved",
      imported_by: ctx.actorId,
    });
    expect(record.counts.Items).toEqual({ new: 2, update: 0, unchanged: 0 });
    const audit = (
      await query(
        `SELECT entity, action, actor_id FROM billing_audit WHERE import_id = $1 ORDER BY id`,
        [result.importId],
      )
    ).rows;
    expect(audit[0]).toMatchObject({ entity: "billing_imports", action: "import" });
    expect(new Set(audit.map((a) => a.entity))).toEqual(
      new Set([
        "billing_imports",
        "service_groups",
        "service_subgroups",
        "service_items",
        "patient_schemes",
        "category_rules",
        "category_item_rates",
      ]),
    );
    expect(audit.every((a) => a.actor_id === ctx.actorId)).toBe(true);
    const history = (
      await query(
        `SELECT h.reason FROM service_item_price_history h JOIN service_items i ON i.id = h.service_item_id
          WHERE i.code = $1`,
        [I1],
      )
    ).rows;
    expect(history).toEqual([{ reason: "Created" }]);
  });

  test("3. uploading the same file again saves nothing", async () => {
    const before = await snapshot();
    const result = await commitUpload(await workbook(FULL), {
      fileName: `p208-again-${tag}.xlsx`,
      ctx,
      options: admin,
    });
    expect(result.saved).toBe(false);
    expect(result.preview.counts).toMatchObject({ new: 0, update: 0, unchanged: 8 });
    expect(await snapshot()).toEqual(before);
    expect(await importsNamed(`p208-again-${tag}.xlsx`)).toEqual([]);
  });

  test("4. updates: codes match ignoring case, a price change writes history, and a new open rate ends the old one", async () => {
    const file = `p208-update-${tag}.xlsx`;
    const result = await commitUpload(
      await workbook({
        Items: [{ ...FULL.Items[0], item_code: I1.toLowerCase(), base_price: 175.5 }],
        Categories: [
          { ...FULL.Categories[0], category_code: TOP.toUpperCase(), payer_name: "New Payer" },
        ],
        "Category rates": [
          {
            category_code: TOP,
            item_code: I1,
            valid_from: "2027-04-01",
            rate: 130,
            bill_code: "PX208",
          },
        ],
      }),
      { fileName: file, ctx, options: admin },
    );
    expect(result.saved).toBe(true);
    const saved = await snapshot();
    expect(saved.items.find((i) => i.code === I1).base_price, "updated, not duplicated").toBe(
      "175.50",
    );
    expect(saved.items).toHaveLength(2);
    expect(saved.categories[0].payer_name).toBe("New Payer");
    expect(saved.rates).toEqual([
      {
        scheme_code: TOP,
        valid_from: "2026-04-01",
        valid_to: "2027-03-31",
        rate: "120.00",
        bill_code: "PX208",
      },
      {
        scheme_code: TOP,
        valid_from: "2027-04-01",
        valid_to: null,
        rate: "130.00",
        bill_code: "PX208",
      },
    ]);
    const history = (
      await query(
        `SELECT h.old_price::text, h.new_price::text, h.reason FROM service_item_price_history h
           JOIN service_items i ON i.id = h.service_item_id WHERE i.code = $1 ORDER BY h.id`,
        [I1],
      )
    ).rows;
    expect(history.at(-1)).toEqual({
      old_price: "150.00",
      new_price: "175.50",
      reason: `Bulk import: ${file}`,
    });
  });

  test("5. active = no deactivates, children before parents; nothing is deleted", async () => {
    const result = await commitUpload(
      await workbook({
        Groups: [{ ...FULL.Groups[0], active: "no" }],
        Subgroups: [{ ...FULL.Subgroups[0], active: "no" }],
        Items: FULL.Items.map((i, n) => ({
          ...i,
          base_price: n === 0 ? 175.5 : i.base_price,
          active: "no",
        })),
        Categories: [
          { ...FULL.Categories[0], payer_name: "New Payer", active: "no" },
          { ...FULL.Categories[1], active: "no" },
        ],
      }),
      { fileName: `p208-off-${tag}.xlsx`, ctx, options: admin },
    );
    expect(result.saved).toBe(true);
    const saved = await snapshot();
    expect(saved.groups.map((g) => g.is_active)).toEqual([false]);
    expect(saved.subgroups.map((s) => s.is_active)).toEqual([false]);
    expect(saved.items.map((i) => i.is_active)).toEqual([false, false]);
    expect(saved.categories.map((c) => c.is_active)).toEqual([false, false]);
    expect(saved.rules, "rows are never deleted").toHaveLength(1);
    expect(saved.rates).toHaveLength(2);
  });

  test("6. a file with an error row, or a daily cap change by a non-admin, saves nothing", async () => {
    const before = await snapshot();
    const bad = await commitUpload(
      await workbook({
        Groups: [{ group_code: `P208G_NEW_${T}`, name: `P208 New ${T}` }],
        Items: [
          {
            item_code: `P208-X_${T}`,
            name: "X",
            subgroup_code: "P208_NONE",
            base_price: 1,
            kind: "other",
          },
        ],
      }),
      { fileName: `p208-bad-${tag}.xlsx`, ctx, options: admin },
    );
    expect(bad.saved).toBe(false);
    expect(bad.preview.counts.error).toBe(1);
    const capped = await commitUpload(
      await workbook({
        Categories: [
          { ...FULL.Categories[0], daily_cap: 5, active: "no", payer_name: "New Payer" },
        ],
      }),
      { fileName: `p208-cap-${tag}.xlsx`, ctx, options: {} },
    );
    expect(capped.saved).toBe(false);
    expect(capped.preview.sheets[0].rows[0].errors[0].message).toMatch(/Only an admin/);
    expect(await snapshot()).toEqual(before);
    expect(await importsNamed(`p208-bad-${tag}.xlsx`)).toEqual([]);
  });

  test("7. an import needs a file name and the person importing", async () => {
    const file = await workbook(FULL);
    await expect(commitUpload(file, { fileName: " ", ctx })).rejects.toMatchObject({ status: 400 });
    await expect(commitUpload(file, { fileName: "x.xlsx", ctx: {} })).rejects.toMatchObject({
      status: 400,
    });
  });

  test("8. review: the save takes the same few queries for 5 items or 300", async () => {
    const counted = async (n, prefix) => {
      const pool = getPool();
      let queries = 0;
      const counting = {
        query: (...args) => pool.query(...args),
        connect: async () => {
          const client = await pool.connect();
          return {
            query: (text, params) => {
              queries += 1;
              return client.query(text, params);
            },
            release: () => client.release(),
          };
        },
      };
      const items = Array.from({ length: n }, (_, i) => ({
        item_code: `P208-${prefix}${i}_${T}`,
        name: `P208 ${prefix} ${i} ${T}`,
        subgroup_code: S,
        base_price: 10 + i,
        kind: "other",
      }));
      const result = await commitWith(
        await workbook({
          Groups: [{ ...FULL.Groups[0], active: "yes" }],
          Subgroups: [{ ...FULL.Subgroups[0], active: "yes" }],
          Items: items,
        }),
        { fileName: `p208-${prefix}-${tag}.xlsx`, ctx, options: admin },
        counting,
      );
      expect(result.saved).toBe(true);
      return queries;
    };
    const small = await counted(5, "S");
    const large = await counted(300, "L");
    expect(large, "one statement per table, not one per row").toBeLessThanOrEqual(small + 2);
    expect(large).toBeLessThan(40);
  });

  test("9. review: a doctor's old fee is switched off and a new one added in the same file", async () => {
    const doctor = `Dr P208 ${T}`;
    await query(`INSERT INTO doctors (name, role, is_active) VALUES ($1, 'consultant', TRUE)`, [
      doctor,
    ]);
    const fee = (code, name, active) => ({
      item_code: code,
      name,
      subgroup_code: S,
      base_price: 500,
      kind: "consultation",
      doctor,
      visit_type: "Follow Up",
      active,
    });
    const first = await commitUpload(
      await workbook({ Items: [fee(`P208-FEE1_${T}`, `P208 Fee one ${T}`, "yes")] }),
      { fileName: `p208-fee1-${tag}.xlsx`, ctx, options: admin },
    );
    expect(first.saved).toBe(true);
    const swap = await commitUpload(
      await workbook({
        Items: [
          fee(`P208-FEE1_${T}`, `P208 Fee one ${T}`, "no"),
          fee(`P208-FEE2_${T}`, `P208 Fee two ${T}`, "yes"),
        ],
      }),
      { fileName: `p208-fee2-${tag}.xlsx`, ctx, options: admin },
    );
    expect(swap.saved).toBe(true);
    const fees = (
      await query(`SELECT code, is_active FROM service_items WHERE code ILIKE $1 ORDER BY code`, [
        `P208-FEE%`,
      ])
    ).rows;
    expect(fees).toEqual([
      { code: `P208-FEE1_${T}`, is_active: false },
      { code: `P208-FEE2_${T}`, is_active: true },
    ]);
    const actions = (
      await query(
        `SELECT action FROM billing_audit WHERE import_id = $1 AND entity = 'service_items' ORDER BY action`,
        [swap.importId],
      )
    ).rows.map((r) => r.action);
    expect(actions).toEqual(["create", "deactivate"]);

    const back = await commitUpload(
      await workbook({
        Items: [
          fee(`P208-FEE1_${T}`, `P208 Fee one ${T}`, "yes"),
          fee(`P208-FEE2_${T}`, `P208 Fee two ${T}`, "no"),
        ],
      }),
      { fileName: `p208-fee3-${tag}.xlsx`, ctx, options: admin },
    );
    expect(back.saved, "two existing fees swap: the switch-off is written first").toBe(true);
    const swapped = (
      await query(`SELECT code, is_active FROM service_items WHERE code ILIKE $1 ORDER BY code`, [
        `P208-FEE%`,
      ])
    ).rows;
    expect(swapped.map((r) => r.is_active)).toEqual([true, false]);
  });

  test("10. review: a clash with a change made meanwhile is a plain 409, and nothing is kept", async () => {
    const before = await snapshot();
    const pool = getPool();
    const clashing = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (text, params) =>
            /INSERT INTO service_items/.test(String(text))
              ? Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }))
              : client.query(text, params),
          release: () => client.release(),
        };
      },
    };
    const error = await commitWith(
      await workbook({
        Items: [
          {
            item_code: `P208-NEW_${T}`,
            name: `P208 New ${T}`,
            subgroup_code: S,
            base_price: 1,
            kind: "other",
          },
        ],
      }),
      { fileName: `p208-clash-${tag}.xlsx`, ctx, options: admin },
      clashing,
    ).catch((e) => e);
    expect(error).toMatchObject({
      status: 409,
      message:
        "Scribe's billing data changed while the file was being saved, so nothing was saved; check the file again and upload it once more",
    });
    expect(await snapshot()).toEqual(before);
  });
});
