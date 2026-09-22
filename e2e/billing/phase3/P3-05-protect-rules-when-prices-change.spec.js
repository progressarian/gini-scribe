import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const rules = await import("../../../server/services/billing/paymentRules.js");
const items = await import("../../../server/services/billing/serviceItems.js");
const rates = await import("../../../server/services/billing/categoryRates.js");
const schemes = await import("../../../server/services/patientSchemes.js");
const { commitUpload } = await import("../../../server/services/billing/importCommit.js");
const { previewUpload } = await import("../../../server/services/billing/importPreview.js");
const groups = await import("../../../server/services/billing/serviceGroups.js");
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.8.8.8" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p305_${name}_${tag}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);
const ids = {};

const refused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, label).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};
const priceOf = async (id) =>
  Number(
    (await query(`SELECT base_price FROM service_items WHERE id = $1`, [id])).rows[0].base_price,
  );
const ratesOf = (scheme, id) =>
  query(
    `SELECT rate::float8 AS rate, valid_from::text AS valid_from FROM category_item_rates
      WHERE scheme_code = $1 AND service_item_id = $2 ORDER BY valid_from`,
    [scheme, id],
  ).then((r) => r.rows);
const newItem = (code, name, subgroup, price) =>
  items.createItem(
    { code: `${code}-${T}`, name, subgroup_id: subgroup, base_price: price, kind: "procedure" },
    ctx,
    db,
  );

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

test.describe.serial("P3-05 protect rules when prices change", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P305 CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      db,
      ctx,
    );
    ids.group = (
      await query(`INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`, [
        `P305G-${T}`,
        `P305 OPD ${tag}`,
      ])
    ).rows[0].id;
    const subgroup = (code, name) =>
      query(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
        [ids.group, `${code}-${T}`, name],
      ).then((r) => r.rows[0].id);
    ids.consults = await subgroup("P305S1", "Consults");
    ids.other = await subgroup("P305S2", "Other");
    ids.consult = (await newItem("P305-CONS", "P305 Consultant meet", ids.consults, 1000)).id;
    ids.dressing = (await newItem("P305-DRESS", "P305 Dressing", ids.consults, 600)).id;
    ids.kit = (await newItem("P305-KIT", "P305 Kit", ids.consults, 800)).id;
    await rates.saveRate(
      { scheme_code: c("cghs"), service_item_id: ids.consult, rate: 650, valid_from: "2026-01-01" },
      ctx,
      db,
    );
    await rates.saveRate(
      { scheme_code: c("paid"), service_item_id: ids.consult, rate: 900, valid_from: "2026-01-01" },
      ctx,
      db,
    );
    ids.ruleA = (
      await rules.createPaymentRule(
        {
          scheme_code: c("paid"),
          name: "Paid consult ₹700",
          service_item_id: ids.consult,
          patient_pays: "amount",
          patient_value: 700,
        },
        ctx,
        db,
      )
    ).id;
    ids.ruleB = (
      await rules.createPaymentRule(
        {
          scheme_code: c("cghs"),
          name: "CGHS consults ₹500",
          subgroup_id: ids.consults,
          patient_pays: "amount",
          patient_value: 500,
        },
        ctx,
        db,
      )
    ).id;
  });

  test("1. an item's price can't drop below the amount of a rule that covers it", async () => {
    await refused(
      items.updateItem(ids.dressing, { base_price: 450, reason: "cheaper" }, ctx, db),
      409,
      new RegExp(
        `P305 Dressing \\(₹450\\) is below the ₹500 the payment rule "CGHS consults ₹500" \\(P305 CGHS ${tag}\\) has the patient pay\\. Change or deactivate that rule first`,
      ),
    );
    expect(await priceOf(ids.dressing), "nothing was saved").toBe(600);
    const history = await query(
      `SELECT count(*)::int AS n FROM service_item_price_history WHERE service_item_id = $1`,
      [ids.dressing],
    );
    expect(history.rows[0].n, "no price history row was left behind").toBe(1);
    const equal = await items.updateItem(
      ids.dressing,
      { base_price: 500, reason: "fits" },
      ctx,
      db,
    );
    expect(equal.base_price, "a price equal to the amount is fine").toBe(500);
    const renamed = await items.updateItem(ids.dressing, { name: "P305 Dressing kit" }, ctx, db);
    expect(renamed.name, "other changes don't run the check").toBe("P305 Dressing kit");
    await items.updateItem(ids.dressing, { name: "P305 Dressing" }, ctx, db);
  });

  test("2. a cheap item can't be added to, moved into or brought back under a covered subgroup", async () => {
    await refused(
      newItem("P305-GAUZE", "P305 Gauze", ids.consults, 300),
      409,
      /P305 Gauze \(₹300\) is below the ₹500/,
    );
    const gauze = await newItem("P305-GAUZE", "P305 Gauze", ids.other, 300);
    expect(gauze.subgroup_id, "an uncovered subgroup is fine").toBe(ids.other);
    await refused(
      items.updateItem(gauze.id, { subgroup_id: ids.consults }, ctx, db),
      409,
      /P305 Gauze \(₹300\)/,
    );
    await items.setItemActive(gauze.id, false, ctx, db);
    await items.updateItem(gauze.id, { subgroup_id: ids.consults }, ctx, db);
    await refused(
      items.setItemActive(gauze.id, true, ctx, db),
      409,
      /P305 Gauze \(₹300\)/,
      "a deactivated item isn't billed, but bringing it back is checked",
    );
  });

  test("3. a category rate can't drop below a rule's amount, for the category or a sub-category", async () => {
    await refused(
      rates.saveRate(
        {
          scheme_code: c("paid"),
          service_item_id: ids.consult,
          rate: 650,
          valid_from: "2026-01-01",
        },
        ctx,
        db,
      ),
      409,
      /P305 Consultant meet \(₹650\) is below the ₹700 the payment rule "Paid consult ₹700" \(P305 CGHS \w+ › CGHS Paid\)/,
    );
    await refused(
      rates.saveRate(
        {
          scheme_code: c("cghs"),
          service_item_id: ids.consult,
          rate: 450,
          valid_from: "2026-01-01",
        },
        ctx,
        db,
      ),
      409,
      /P305 Consultant meet \(₹450\) is below the ₹500 the payment rule "CGHS consults ₹500"/,
    );
    expect(await ratesOf(c("paid"), ids.consult), "nothing was saved").toEqual([
      { rate: 900, valid_from: "2026-01-01" },
    ]);
    const fine = await rates.saveRate(
      { scheme_code: c("paid"), service_item_id: ids.consult, rate: 700, valid_from: "2026-01-01" },
      ctx,
      db,
    );
    expect(fine.rate.rate).toBe(700);
  });

  test("4. clearing a sub-category's own rate can't fall back to a lower parent rate", async () => {
    await refused(
      rates.deleteRate(
        { scheme_code: c("paid"), service_item_id: ids.consult, valid_from: "2026-01-01" },
        ctx,
        db,
      ),
      409,
      /P305 Consultant meet \(₹650\) is below the ₹700 the payment rule "Paid consult ₹700"/,
    );
    expect(await ratesOf(c("paid"), ids.consult)).toEqual([
      { rate: 700, valid_from: "2026-01-01" },
    ]);
  });

  test("5. the import refuses a price or rate below a rule's amount, and saves nothing", async () => {
    const buffer = await workbook({
      Items: [
        {
          item_code: `P305-KIT-${T}`,
          name: "P305 Kit",
          subgroup_code: `P305S1-${T}`,
          base_price: 400,
          kind: "procedure",
        },
      ],
      "Category rates": [
        {
          category_code: c("paid"),
          item_code: `P305-CONS-${T}`,
          valid_from: "2026-01-01",
          rate: 600,
        },
      ],
    });
    const error = await refused(
      commitUpload(buffer, { fileName: "p305.xlsx", ctx }, db),
      409,
      /P305 Kit \(₹400\) is below the ₹500.*P305 Consultant meet \(₹600\) is below the ₹700/,
    );
    expect(error.conflicts.map((x) => x.name)).toEqual(["P305 Kit", "P305 Consultant meet"]);
    expect(await priceOf(ids.kit), "the whole import was rolled back").toBe(800);
    expect(await ratesOf(c("paid"), ids.consult)).toEqual([
      { rate: 700, valid_from: "2026-01-01" },
    ]);
  });

  test("6. deactivated and non-amount rules don't hold prices", async () => {
    await rules.setPaymentRuleActive(ids.ruleB, false, ctx, db);
    const cheaper = await items.updateItem(
      ids.dressing,
      { base_price: 450, reason: "rule off" },
      ctx,
      db,
    );
    expect(cheaper.base_price).toBe(450);
    await refused(
      rules.setPaymentRuleActive(ids.ruleB, true, ctx, db),
      409,
      /P305 Dressing \(₹450\)/,
      "turning the rule back on is checked the other way",
    );
    await rules.updatePaymentRule(
      ids.ruleB,
      { patient_pays: "percent", patient_value: 20 },
      ctx,
      db,
    );
    await rules.setPaymentRuleActive(ids.ruleB, true, ctx, db);
    const lower = await items.updateItem(ids.dressing, { base_price: 100, reason: "20%" }, ctx, db);
    expect(lower.base_price, "a percent rule has no amount to hold").toBe(100);
  });

  test("7. the Category rates screen shows the refusal in the row", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings/category-rates", () =>
      page.getByLabel("Category", { exact: true }),
    );
    await page.getByLabel("Category", { exact: true }).selectOption(c("paid"));
    const grid = page.getByRole("table", { name: "Rates" });
    const name = "P305 Consultant meet";
    await grid.getByRole("button", { name: `Edit rate for ${name}`, exact: true }).click();
    await grid.getByLabel(`Rate for ${name}`, { exact: true }).fill("600");
    const row = grid.getByRole("row", { name: new RegExp(name) });
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(row).toContainText(
      /is below the ₹700 the payment rule "Paid consult ₹700".*Change or deactivate that rule first/,
    );
    expect(await ratesOf(c("paid"), ids.consult)).toEqual([
      { rate: 700, valid_from: "2026-01-01" },
    ]);
  });

  test.describe.serial("review", () => {
    const scan = "P305 Scan";
    const scanRate = (scheme, extra) =>
      rates.saveRate({ scheme_code: c(scheme), service_item_id: ids.scan, ...extra }, ctx, db);

    test.beforeAll(async () => {
      await schemes.createScheme(
        { code: c("echs"), label: `P305 ECHS ${tag}`, payer_name: "ECHS Polyclinic" },
        db,
        ctx,
      );
      await schemes.createScheme(
        { code: c("vet"), label: "Veteran", parent_code: c("echs") },
        db,
        ctx,
      );
      const group = (code, name) =>
        query(`INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`, [
          `${code}-${T}`,
          `${name} ${tag}`,
        ]).then((r) => r.rows[0].id);
      const subgroup = (groupId, code) =>
        query(
          `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
          [groupId, `${code}-${T}`],
        ).then((r) => r.rows[0].id);
      ids.scans = await group("P305G2", "P305 Scans");
      ids.scanSub = await subgroup(ids.scans, "P305S3");
      ids.scan = (await newItem("P305-SCAN", scan, ids.scanSub, 2000)).id;
      ids.stores = await group("P305G3", "P305 Stores");
      ids.storeSub = await subgroup(ids.stores, "P305S4");
      ids.swab = (await newItem("P305-SWAB", "P305 Swab", ids.storeSub, 50)).id;
      await scanRate("echs", { rate: 1000, valid_from: "2026-01-01" });
      await scanRate("vet", { rate: 1500, valid_from: "2026-12-01" });
    });

    test("8. review: a rule is checked on every day it applies, not only where a rate exists", async () => {
      await refused(
        rules.createPaymentRule(
          {
            scheme_code: c("vet"),
            name: "Veteran scan ₹1,200",
            service_item_id: ids.scan,
            patient_pays: "amount",
            patient_value: 1200,
            valid_from: "2026-10-01",
          },
          ctx,
          db,
        ),
        409,
        /P305 Scan \(₹1,000\)/,
        "until its own rate starts in December, Veteran pays the parent's ₹1,000",
      );
      await refused(
        rules.createPaymentRule(
          {
            scheme_code: c("echs"),
            name: "ECHS scan ₹1,200 later",
            service_item_id: ids.scan,
            patient_pays: "amount",
            patient_value: 1200,
            valid_from: "2026-12-01",
          },
          ctx,
          db,
        ),
        409,
        /P305 Scan \(₹1,000\)/,
        "ECHS itself stays at ₹1,000",
      );
      ids.ruleV = (
        await rules.createPaymentRule(
          {
            scheme_code: c("vet"),
            name: "Veteran scan ₹1,200",
            service_item_id: ids.scan,
            patient_pays: "amount",
            patient_value: 1200,
            valid_from: "2026-12-01",
          },
          ctx,
          db,
        )
      ).id;
    });

    test("9. review: ending a rate early can't expose a lower price later in a rule's dates", async () => {
      await scanRate("vet", { rate: 1300, valid_from: "2027-02-01" });
      const error = await refused(
        rates.deleteRate(
          { scheme_code: c("vet"), service_item_id: ids.scan, valid_from: "2027-02-01" },
          ctx,
          db,
        ),
        409,
        /P305 Scan \(₹1,000 from 2027-02-01\) is below the ₹1,200 the payment rule "Veteran scan ₹1,200"/,
      );
      expect(error.conflicts[0]).toMatchObject({ from: "2027-02-01", price: 1000 });
      expect((await ratesOf(c("vet"), ids.scan)).map((r) => r.rate)).toEqual([1500, 1300]);
    });

    test("10. review: a subgroup can't move under a group whose rule its items are cheaper than", async () => {
      await rules.createPaymentRule(
        {
          scheme_code: c("cghs"),
          name: "CGHS scans ₹100",
          group_id: ids.scans,
          patient_pays: "amount",
          patient_value: 100,
        },
        ctx,
        db,
      );
      await refused(
        groups.updateSubgroup(ids.storeSub, { group_id: ids.scans }, ctx, db),
        409,
        /P305 Swab \(₹50\) is below the ₹100 the payment rule "CGHS scans ₹100"/,
      );
      const { rows } = await query(`SELECT group_id FROM service_subgroups WHERE id = $1`, [
        ids.storeSub,
      ]);
      expect(rows[0].group_id, "nothing was moved").toBe(ids.stores);
    });

    test("11. review: a sub-category can't move under, or come back under, a parent's rule with a lower rate", async () => {
      await schemes.createScheme({ code: c("other"), label: `P305 Other ${tag}` }, db, ctx);
      await schemes.createScheme(
        { code: c("cheap"), label: "Cheap", parent_code: c("other") },
        db,
        ctx,
      );
      await scanRate("cheap", { rate: 80, valid_from: "2026-01-01" });
      await refused(
        schemes.updateScheme(c("cheap"), { parent_code: c("cghs") }, db, ctx),
        409,
        /P305 Scan \(₹80 for Cheap\) is below the ₹100 the payment rule "CGHS scans ₹100"/,
      );
      await schemes.updateScheme(c("cheap"), { is_active: false }, db, ctx);
      await schemes.updateScheme(c("cheap"), { parent_code: c("cghs") }, db, ctx);
      await refused(
        schemes.updateScheme(c("cheap"), { is_active: true }, db, ctx),
        409,
        /P305 Scan \(₹80 for Cheap\)/,
        "a retired sub-category isn't billed, but bringing it back is checked",
      );
    });

    test("12. review: the import preview shows the refusal on the row, before saving", async () => {
      const buffer = await workbook({
        Items: [
          {
            item_code: `P305-KIT-${T}`,
            name: "P305 Kit",
            subgroup_code: `P305S1-${T}`,
            base_price: 750,
            kind: "procedure",
          },
        ],
        "Category rates": [
          {
            category_code: c("paid"),
            item_code: `P305-CONS-${T}`,
            valid_from: "2026-01-01",
            rate: 600,
          },
        ],
      });
      const preview = await previewUpload(buffer, db);
      expect(preview.canImport).toBe(false);
      const rateRow = preview.sheets.find((x) => x.name === "Category rates").rows[0];
      expect(rateRow.status).toBe("error");
      expect(rateRow.errors).toEqual([
        {
          column: "rate",
          message: expect.stringMatching(
            /P305 Consultant meet \(₹600\) is below the ₹700 the payment rule "Paid consult ₹700"/,
          ),
        },
      ]);
      const itemRow = preview.sheets.find((x) => x.name === "Items").rows[0];
      expect(itemRow.status, "a row that breaks no rule stays as it was").toBe("update");
      expect(await priceOf(ids.kit), "the preview saved nothing").toBe(800);
      expect(await ratesOf(c("paid"), ids.consult)).toEqual([
        { rate: 700, valid_from: "2026-01-01" },
      ]);
    });
  });
});
