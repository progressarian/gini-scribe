import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/categoryRules.js");
const schemes = await import("../../../server/services/patientSchemes.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.5.5.5" };
const tag = crypto.randomBytes(3).toString("hex");
const c = (name) => `${name}_${tag}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);
const ids = {};

const refused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, label).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};

test.describe.serial("P1-20 category rules service", () => {
  test.beforeAll(async () => {
    await schemes.createScheme({ code: c("senior"), label: `Senior ${tag}` }, db, ctx);
    await schemes.createScheme({ code: c("cghs"), label: `CGHS ${tag}` }, db, ctx);
    await schemes.createScheme(
      { code: c("pensioner"), label: "Pensioner", parent_code: c("cghs") },
      db,
      ctx,
    );
    await schemes.createScheme({ code: c("retired"), label: `Retired ${tag}` }, db, ctx);
    await schemes.updateScheme(c("retired"), { is_active: false }, db, ctx);
  });

  test("1. create a rule: defaults, audit, and the category's display name in the list", async () => {
    const rule = await svc.createRule(
      { scheme_code: c("senior"), name: "Age 60 and over", min_age: "60" },
      ctx,
      db,
    );
    expect(rule).toMatchObject({
      min_age: 60,
      max_age: null,
      gender: null,
      requires_card: false,
      mode: "suggest",
      priority: 100,
      is_active: true,
    });
    ids.senior = rule.id;
    const card = await svc.createRule(
      {
        scheme_code: c("pensioner"),
        name: "Card holders 60+",
        min_age: 60,
        requires_card: true,
        mode: "auto",
        priority: 10,
      },
      ctx,
      db,
    );
    ids.pensioner = card.id;
    const list = await svc.listRules({ schemeCode: c("pensioner") }, db);
    expect(list.map((r) => [r.name, r.category_label, r.mode])).toEqual([
      ["Card holders 60+", `CGHS ${tag} › Pensioner`, "auto"],
    ]);
    const audit = await query(
      `SELECT action, actor_id FROM billing_audit WHERE entity = 'category_rules' AND entity_id = $1`,
      [String(rule.id)],
    );
    expect(audit.rows).toEqual([{ action: "create", actor_id: ctx.actorId }]);
  });

  test("2. a rule on a category that has sub-categories is refused", async () => {
    await refused(
      svc.createRule({ scheme_code: c("cghs"), name: "All CGHS", requires_card: true }, ctx, db),
      409,
      /has sub-categories, so it can't be billed on its own: put the rule on one of its sub-categories/,
    );
  });

  test("3. bad rules are refused with a clear message", async () => {
    const cases = [
      [{ name: "Nothing" }, 400, /at least one condition/],
      [{ name: "Backwards", min_age: 70, max_age: 60 }, 400, /can't be more than the maximum/],
      [{ name: "Too old", max_age: 151 }, 400, /0 to 150/],
      [{ name: "Fraction", min_age: 60.5 }, 400, /whole number of years/],
      [{ name: "Not a number", min_age: true }, 400, /whole number of years/],
      [{ name: "Gender", gender: "M" }, 400, /Gender must be one of: Male, Female, Other/],
      [{ name: "Mode", min_age: 1, mode: "force" }, 400, /Mode must be one of: suggest, auto/],
      [{ name: "Card", requires_card: "true" }, 400, /must be true or false/],
      [
        { name: "Priority", min_age: 1, priority: -1 },
        400,
        /Priority must be a whole number, 0 or more/,
      ],
      [{ name: " ", min_age: 1 }, 400, /Name can't be blank/],
      [
        { name: "age 60 AND over", min_age: 65 },
        409,
        /already has a rule called "Age 60 and over"/,
      ],
      [{ name: "Orphan", min_age: 1, scheme_code: "nope_nope" }, 404, /doesn't exist/],
      [{ name: "Retired", min_age: 1, scheme_code: c("retired") }, 409, /is retired/],
      [{ name: "No category", min_age: 1, scheme_code: "" }, 400, /Choose a category/],
    ];
    for (const [overrides, status, message] of cases) {
      await refused(
        svc.createRule({ scheme_code: c("senior"), ...overrides }, ctx, db),
        status,
        message,
        JSON.stringify(overrides),
      );
    }
  });

  test("4. update changes only what is sent and is re-checked as a whole", async () => {
    const updated = await svc.updateRule(ids.senior, { max_age: 120, gender: "Female" }, ctx, db);
    expect(updated).toMatchObject({ min_age: 60, max_age: 120, gender: "Female" });
    await refused(
      svc.updateRule(ids.senior, { min_age: 130 }, ctx, db),
      400,
      /can't be more than the maximum/,
    );
    await refused(
      svc.updateRule(ids.senior, { min_age: null, max_age: null, gender: null }, ctx, db),
      400,
      /at least one condition/,
    );
    await refused(
      svc.updateRule(ids.senior, { scheme_code: c("cghs") }, ctx, db),
      409,
      /has sub-categories/,
    );
    const moved = await svc.updateRule(
      ids.senior,
      { scheme_code: c("pensioner"), name: "Women 60+" },
      ctx,
      db,
    );
    expect(moved.scheme_code).toBe(c("pensioner"));
    await refused(
      svc.updateRule(ids.senior, { name: "CARD HOLDERS 60+" }, ctx, db),
      409,
      /already has a rule/,
    );
    await refused(svc.updateRule(ids.senior, {}, ctx, db), 400, /Nothing to change/);
    await refused(svc.updateRule(999999999, { name: "X" }, ctx, db), 404);
    const audit = await query(
      `SELECT action, before, after FROM billing_audit WHERE entity = 'category_rules' AND entity_id = $1 ORDER BY id`,
      [String(ids.senior)],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["create", "update", "update"]);
    expect(audit.rows[2].before.scheme_code).toBe(c("senior"));
    expect(audit.rows[2].after.scheme_code).toBe(c("pensioner"));
  });

  test("5. deactivate and reactivate; reactivating re-checks the category", async () => {
    const off = await svc.setRuleActive(ids.pensioner, false, ctx, db);
    expect(off.is_active).toBe(false);
    expect(
      (await svc.listRules({ schemeCode: c("pensioner"), activeOnly: true }, db)).map((r) => r.id),
    ).not.toContain(ids.pensioner);
    await refused(svc.setRuleActive(ids.pensioner, "true", ctx, db), 400, /true or false/);
    await query(`UPDATE patient_schemes SET is_active = FALSE WHERE code = $1`, [c("cghs")]);
    await refused(svc.setRuleActive(ids.pensioner, true, ctx, db), 409, /is retired/);
    await query(`UPDATE patient_schemes SET is_active = TRUE WHERE code = $1`, [c("cghs")]);
    const on = await svc.setRuleActive(ids.pensioner, true, ctx, db);
    expect(on.is_active).toBe(true);
  });

  test("6. the list is ordered by priority and can be filtered", async () => {
    await svc.createRule(
      { scheme_code: c("senior"), name: "Over 80", min_age: 80, priority: 5 },
      ctx,
      db,
    );
    const list = await svc.listRules({}, db);
    const mine = list.filter((r) => r.scheme_code.endsWith(tag));
    const priorities = mine.map((r) => r.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect((await svc.listRules({ schemeCode: c("senior") }, db)).map((r) => r.name)).toEqual([
      "Over 80",
    ]);
  });

  test("7. delete removes the rule and is audited", async () => {
    const spare = await svc.createRule(
      { scheme_code: c("senior"), name: "Spare", min_age: 1 },
      ctx,
      db,
    );
    expect(await svc.deleteRule(spare.id, ctx, db)).toEqual({ deleted: true, id: spare.id });
    expect((await query(`SELECT 1 FROM category_rules WHERE id = $1`, [spare.id])).rows).toEqual(
      [],
    );
    const audit = await query(
      `SELECT action FROM billing_audit WHERE entity = 'category_rules' AND entity_id = $1 ORDER BY id`,
      [String(spare.id)],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["create", "delete"]);
    await refused(svc.deleteRule(999999999, ctx, db), 404);
  });

  test("8. a rule and a first sub-category added at the same moment don't slip past each other", async () => {
    await schemes.createScheme({ code: c("insurer"), label: `Insurer ${tag}` }, db, ctx);
    const outer = await db.connect();
    try {
      await outer.query("BEGIN");
      await svc.createRule(
        { scheme_code: c("insurer"), name: "Policy holders", requires_card: true },
        ctx,
        outer,
      );
      const sub = failure(
        schemes.createScheme(
          { code: c("insurer_gold"), label: "Gold", parent_code: c("insurer") },
          db,
          ctx,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await outer.query("COMMIT");
      const result = await sub;
      expect(result, "the sub-category waited for the rule and was then created").toBeNull();
    } finally {
      await outer.query("ROLLBACK").catch(() => {});
      outer.release();
    }
    const gold = (await schemes.listSchemes({ all: true }, db)).find(
      (s) => s.code === c("insurer_gold"),
    );
    expect(gold.parent_code).toBe(c("insurer"));
    await refused(
      svc.createRule({ scheme_code: c("insurer"), name: "Another", requires_card: true }, ctx, db),
      409,
      /has sub-categories/,
    );
  });

  test("9. a sub-category created first, while a rule is being added, still blocks the rule", async () => {
    await schemes.createScheme({ code: c("corp"), label: `Corporate ${tag}` }, db, ctx);
    const outer = await db.connect();
    try {
      await outer.query("BEGIN");
      await schemes.createScheme(
        { code: c("corp_a"), label: "Company A", parent_code: c("corp") },
        outer,
        ctx,
      );
      const rule = failure(
        svc.createRule({ scheme_code: c("corp"), name: "Employees", requires_card: true }, ctx, db),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await outer.query("COMMIT");
      const error = await rule;
      expect(error?.status, "the rule saw the new sub-category after waiting").toBe(409);
      expect(error.message).toMatch(/has sub-categories/);
    } finally {
      await outer.query("ROLLBACK").catch(() => {});
      outer.release();
    }
    expect(await svc.listRules({ schemeCode: c("corp") }, db)).toEqual([]);
  });

  test("10. inside a caller's transaction it joins it", async () => {
    const outer = await db.connect();
    try {
      await outer.query("BEGIN");
      await svc.createRule({ scheme_code: c("senior"), name: "Tx rule", min_age: 1 }, ctx, outer);
      await outer.query("ROLLBACK");
    } finally {
      outer.release();
    }
    expect(
      (
        await query(`SELECT 1 FROM category_rules WHERE name = 'Tx rule' AND scheme_code = $1`, [
          c("senior"),
        ])
      ).rows,
    ).toEqual([]);
  });

  test("11. an automatic rule for a card category must require a card", async () => {
    await schemes.createScheme(
      { code: c("echs"), label: `ECHS ${tag}`, requires_ref: true },
      db,
      ctx,
    );
    const error = await failure(
      svc.createRule(
        { scheme_code: c("echs"), name: "Veterans 60+", min_age: 60, mode: "auto" },
        ctx,
        db,
      ),
    );
    expect(error?.status).toBe(409);
    expect(error.message).toBe(
      `ECHS ${tag} needs a card number, so an automatic rule for it must also require a card. Tick "card required", or make the rule a suggestion the desk confirms.`,
    );
    const suggestion = await svc.createRule(
      { scheme_code: c("echs"), name: "Veterans 60+", min_age: 60 },
      ctx,
      db,
    );
    expect(suggestion.mode).toBe("suggest");
    await refused(
      svc.updateRule(suggestion.id, { mode: "auto" }, ctx, db),
      409,
      /needs a card number/,
    );
    const withCard = await svc.updateRule(
      suggestion.id,
      { mode: "auto", requires_card: true },
      ctx,
      db,
    );
    expect(withCard).toMatchObject({ mode: "auto", requires_card: true });
    await refused(
      svc.updateRule(suggestion.id, { requires_card: false }, ctx, db),
      409,
      /needs a card number/,
    );

    await schemes.updateScheme(c("cghs"), { requires_ref: true }, db, ctx);
    await refused(
      svc.createRule(
        { scheme_code: c("pensioner"), name: "Any 60+", min_age: 60, mode: "auto" },
        ctx,
        db,
      ),
      409,
      /CGHS .* › Pensioner needs a card number/,
    );
  });

  test("12. rules of a retired category are marked in the list", async () => {
    await schemes.createScheme({ code: c("promo"), label: `Promo ${tag}` }, db, ctx);
    const rule = await svc.createRule(
      { scheme_code: c("promo"), name: "Women", gender: "Female" },
      ctx,
      db,
    );
    expect((await svc.listRules({ schemeCode: c("promo") }, db))[0].category_active).toBe(true);
    await schemes.updateScheme(c("promo"), { is_active: false }, db, ctx);
    const [row] = await svc.listRules({ schemeCode: c("promo") }, db);
    expect(row).toMatchObject({ id: rule.id, is_active: true, category_active: false });
  });

  test("13. deleting a rule something still refers to gives a friendly 409", async () => {
    const rule = await svc.createRule(
      { scheme_code: c("senior"), name: "Referenced", min_age: 1 },
      ctx,
      db,
    );
    const outer = await db.connect();
    try {
      await outer.query("BEGIN");
      await outer.query(
        `CREATE TABLE e2e_rule_ref_${tag} (rule_id INT REFERENCES category_rules(id))`,
      );
      await outer.query(`INSERT INTO e2e_rule_ref_${tag} VALUES ($1)`, [rule.id]);
      const error = await failure(svc.deleteRule(rule.id, ctx, outer));
      expect(error?.status).toBe(409);
      expect(error.message).toBe(
        `The rule "Referenced" can't be deleted because it is still referenced. Deactivate it instead.`,
      );
      const still = await outer.query(`SELECT 1 FROM category_rules WHERE id = $1`, [rule.id]);
      expect(
        still.rows,
        "the outer transaction is still usable and the rule is still there",
      ).toHaveLength(1);
    } finally {
      await outer.query("ROLLBACK").catch(() => {});
      outer.release();
    }
  });
});
