import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
process.env.SCHEME_CAP_ENFORCEMENT = "strict";
const svc = await import("../../../server/services/patientSchemes.js");
const cap = await import("../../../server/services/schemeCap.js");
const categories = await import("../../../shared/patientCategories.js");

const db = getPool();
const ctx = { actorId: USERS.admin.id, ip: "10.4.4.4" };
const tag = crypto.randomBytes(3).toString("hex");
const c = (name) => `${name}_${tag}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);
const DAY = "2030-01-15";

const book = (category, status = "scheduled", date = DAY) =>
  query(
    `INSERT INTO appointments (patient_name, patient_category, appointment_date, status)
     VALUES ('E2E Cap', $1, $2, $3)`,
    [category, date, status],
  );

test.describe.serial("P1-19 categories and sub-categories service", () => {
  test("1. CGHS with CGHS Paid, CGHS Referral and Pensioner can be created, and is listed as a tree", async () => {
    const cghs = await svc.createScheme(
      { code: c("cghs"), label: `CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      db,
      ctx,
    );
    expect(cghs).toMatchObject({
      parent_code: null,
      display_label: `CGHS ${tag}`,
      payer_name: "CGHS Wellness Centre",
    });
    for (const [code, label, extra] of [
      [c("paid"), "CGHS Paid", {}],
      [c("referral"), "CGHS Referral", { requires_referral: true, requires_referral_doc: true }],
      [c("pensioner"), "Pensioner", { print_category_on_bill: true }],
    ]) {
      const sub = await svc.createScheme(
        { code, label, parent_code: c("cghs"), ...extra },
        db,
        ctx,
      );
      expect(sub).toMatchObject({
        parent_code: c("cghs"),
        display_label: `CGHS ${tag} › ${label}`,
        ...extra,
      });
    }
    const tree = (await svc.listSchemeTree({ all: true }, db)).find((t) => t.code === c("cghs"));
    expect(tree.sub_categories.map((s) => s.label)).toEqual([
      "CGHS Paid",
      "CGHS Referral",
      "Pensioner",
    ]);
    const flat = (await svc.listSchemes({ all: true }, db)).map((s) => s.code);
    const at = flat.indexOf(c("cghs"));
    expect(flat.slice(at, at + 4)).toEqual([c("cghs"), c("paid"), c("referral"), c("pensioner")]);
    expect(await svc.isKnownScheme(c("pensioner"), db)).toBe(true);
    const audit = await query(
      `SELECT action, actor_id FROM billing_audit WHERE entity = 'patient_schemes' AND entity_id = $1`,
      [c("pensioner")],
    );
    expect(audit.rows).toEqual([{ action: "create", actor_id: ctx.actorId }]);
  });

  test("2. bad categories are refused with a clear message", async () => {
    const cases = [
      [
        { code: c("deep"), label: "Deep", parent_code: c("pensioner") },
        409,
        /already a sub-category/,
      ],
      [{ code: "general", label: "General" }, 400, /reserved/],
      [{ code: "Bad Code", label: "X" }, 400, /a–z, 0–9 and _ only/],
      [
        { code: c("dup"), label: "cghs paid", parent_code: c("cghs") },
        409,
        /already exists under that category/,
      ],
      [{ code: c("dup2"), label: `cghs ${tag}` }, 409, /A category called/],
      [{ code: c("orphan"), label: "Orphan", parent_code: "nope_nope" }, 404, /doesn't exist/],
      [{ code: c("flag"), label: "Flag", requires_referral: "true" }, 400, /must be true or false/],
      [{ code: c("payer"), label: "Payer", payer_name: 5 }, 400, /Payer name must be text/],
      [{ code: c("cghs"), label: "Again" }, 409, /already exists/],
    ];
    for (const [input, status, message] of cases) {
      const error = await failure(svc.createScheme(input, db, ctx));
      expect(error?.status, JSON.stringify(input)).toBe(status);
      expect(error.message, JSON.stringify(input)).toMatch(message);
    }
    const ok = await svc.createScheme({ code: c("echs"), label: `ECHS ${tag}` }, db, ctx);
    const samePaid = await svc.createScheme(
      { code: c("echs_paid"), label: "CGHS Paid", parent_code: ok.code },
      db,
      ctx,
    );
    expect(samePaid.display_label, "the same label under another parent is fine").toBe(
      `ECHS ${tag} › CGHS Paid`,
    );
  });

  test("3. adding the first sub-category to a category with rules returns those rules", async () => {
    await svc.createScheme({ code: c("senior"), label: `Senior ${tag}` }, db, ctx);
    await query(
      `INSERT INTO category_rules (scheme_code, name, min_age) VALUES ($1, 'Age 60 and over', 60)`,
      [c("senior")],
    );
    const first = await svc.createScheme(
      { code: c("senior_70"), label: "70 plus", parent_code: c("senior") },
      db,
      ctx,
    );
    expect(first.rules_to_move.map((r) => r.name)).toEqual(["Age 60 and over"]);
    const second = await svc.createScheme(
      { code: c("senior_80"), label: "80 plus", parent_code: c("senior") },
      db,
      ctx,
    );
    expect(second.rules_to_move).toBeUndefined();
  });

  test("4. update: strict fields, moving, and retiring", async () => {
    const updated = await svc.updateScheme(
      c("cghs"),
      { payer_name: "  ", allow_pay_later: true, requires_ref: true },
      db,
      ctx,
    );
    expect(updated).toMatchObject({ payer_name: null, allow_pay_later: true, requires_ref: true });
    expect(
      (await failure(svc.updateScheme(c("cghs"), { is_active: "false" }, db, ctx))).status,
    ).toBe(400);
    expect(
      (await failure(svc.updateScheme(c("cghs"), { allow_pay_later: "yes" }, db, ctx))).status,
    ).toBe(400);
    const cleared = await svc.updateScheme(c("cghs"), { allow_pay_later: null }, db, ctx);
    expect(cleared.allow_pay_later).toBeNull();
    const moved = await svc.updateScheme(c("echs_paid"), { parent_code: c("senior") }, db, ctx);
    expect(moved.display_label).toBe(`Senior ${tag} › CGHS Paid`);
    const deep = await failure(
      svc.updateScheme(c("echs"), { parent_code: c("pensioner") }, db, ctx),
    );
    expect(deep.status).toBe(409);
    const hasChildren = await failure(
      svc.updateScheme(c("senior"), { parent_code: c("echs") }, db, ctx),
    );
    expect(hasChildren.status, "a category with sub-categories can't become one").toBe(409);
    expect(hasChildren.message).toMatch(/only two levels/);
    const retire = await failure(svc.updateScheme(c("senior"), { is_active: false }, db, ctx));
    expect(retire.status).toBe(409);
    expect(retire.message).toMatch(
      /still has 3 active sub-categories: 70 plus, 80 plus, CGHS Paid/,
    );
    for (const code of [c("senior_70"), c("senior_80"), c("echs_paid")]) {
      await svc.updateScheme(code, { is_active: false }, db, ctx);
    }
    await svc.updateScheme(c("senior"), { is_active: false }, db, ctx);
    const back = await failure(svc.updateScheme(c("senior_70"), { is_active: true }, db, ctx));
    expect(back.status, "a sub-category can't come back under a retired parent").toBe(409);
    const active = (await svc.listSchemes({}, db)).map((s) => s.code);
    expect(active).not.toContain(c("senior_70"));
    expect((await failure(svc.updateScheme("nope_nope", { label: "X" }, db, ctx))).status).toBe(
      404,
    );
    const audit = await query(
      `SELECT count(*)::int AS n FROM billing_audit WHERE entity = 'patient_schemes' AND entity_id = $1 AND action = 'update'`,
      [c("cghs")],
    );
    expect(audit.rows[0].n, "two successful updates; the refused ones left no row").toBe(2);
  });

  test("5. delete: refused while used, allowed when not", async () => {
    const used = await failure(svc.deleteScheme(c("cghs"), db, ctx));
    expect(used.status).toBe(409);
    expect(used.message).toBe(
      `CGHS ${tag} can't be deleted because it is still used: 3 sub-categories under CGHS ${tag}. Deactivate it instead.`,
    );
    await svc.createScheme({ code: c("spare"), label: `Spare ${tag}` }, db, ctx);
    expect(await svc.deleteScheme(c("spare"), db, ctx)).toEqual({ deleted: true, id: c("spare") });
    expect(
      (await query(`SELECT 1 FROM patient_schemes WHERE code = $1`, [c("spare")])).rows,
    ).toEqual([]);
    const audit = await query(
      `SELECT action FROM billing_audit WHERE entity = 'patient_schemes' AND entity_id = $1 ORDER BY id`,
      [c("spare")],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["create", "delete"]);
    await book(c("echs"));
    const booked = await failure(svc.deleteScheme(c("echs"), db, ctx));
    expect(booked.message).toMatch(/1 appointment is booked as ECHS/);
  });

  test("6. the CGHS cap counts CGHS and all its sub-categories together", async () => {
    await svc.updateScheme(c("cghs"), { daily_cap: 2 }, db, ctx);
    await book(c("pensioner"));
    await book(c("paid"));
    await book(c("paid"), "cancelled");
    const paid = await cap.schemeDayCount(c("paid"), DAY, db);
    expect(paid).toMatchObject({
      cap: 2,
      booked: 2,
      scope_code: c("cghs"),
      includes_sub_categories: true,
    });
    const parent = await cap.schemeDayCount(c("cghs"), DAY, db);
    expect(parent).toMatchObject({ cap: 2, booked: 2 });
    const refused = await cap.checkSchemeCap({ schemeCode: c("referral"), date: DAY }, db);
    expect(refused.blocked, "a third CGHS-family booking is refused").toBe(true);
    expect(refused.detail).toBe(
      `CGHS ${tag} is full for ${DAY} — 2/2 booked, counting its sub-categories`,
    );
    const next = await cap.nextDatesWithRoom(c("referral"), DAY, { days: 3 }, db);
    expect(next.map((d) => d.date)).toEqual(["2030-01-16", "2030-01-17", "2030-01-18"]);
  });

  test("7. a sub-category's own cap is enforced as well, and only counts itself", async () => {
    const OTHER = "2030-02-01";
    await svc.updateScheme(c("cghs"), { daily_cap: 10 }, db, ctx);
    await svc.updateScheme(c("pensioner"), { daily_cap: 1 }, db, ctx);
    await book(c("pensioner"), "scheduled", OTHER);
    await book(c("paid"), "scheduled", OTHER);
    const own = await cap.schemeDayCount(c("pensioner"), OTHER, db);
    expect(own).toMatchObject({
      cap: 1,
      booked: 1,
      scope_code: c("pensioner"),
      includes_sub_categories: false,
    });
    const refused = await cap.checkSchemeCap({ schemeCode: c("pensioner"), date: OTHER }, db);
    expect(refused.blocked).toBe(true);
    expect(refused.detail).toBe(`Pensioner is full for ${OTHER} — 1/1 booked`);
    expect(await cap.checkSchemeCap({ schemeCode: c("paid"), date: OTHER }, db)).toBeNull();
    const top = await cap.schemeDayCount(c("cghs"), OTHER, db);
    expect(top).toMatchObject({ cap: 10, booked: 2 });
  });

  test("8. the shared category list shows sub-categories as Parent › Child", async () => {
    const rows = await svc.listSchemes({}, db);
    categories.hydrateCategories(rows);
    expect(categories.categoryLabel(c("pensioner"))).toBe(`CGHS ${tag} › Pensioner`);
    expect(categories.categoryLabel(c("cghs"))).toBe(`CGHS ${tag}`);
    expect(categories.isValidCategory(c("pensioner"))).toBe(true);
  });

  test("9. inside a caller's transaction it joins it", async () => {
    const outer = await db.connect();
    try {
      await outer.query("BEGIN");
      await svc.createScheme({ code: c("tx"), label: `Tx ${tag}` }, outer, ctx);
      await outer.query("ROLLBACK");
    } finally {
      outer.release();
    }
    expect((await query(`SELECT 1 FROM patient_schemes WHERE code = $1`, [c("tx")])).rows).toEqual(
      [],
    );
  });

  test("10. the daily cap only takes a whole number, 0 or more, or blank for no limit", async () => {
    for (const value of [true, false, [], {}, "abc", "1.5", -1, 2.5]) {
      const error = await failure(svc.updateScheme(c("echs"), { daily_cap: value }, db, ctx));
      expect(error?.status, JSON.stringify(value)).toBe(400);
      expect(error.message).toBe("Daily cap must be a whole number, 0 or more");
    }
    expect((await svc.updateScheme(c("echs"), { daily_cap: " 12 " }, db, ctx)).daily_cap).toBe(12);
    expect((await svc.updateScheme(c("echs"), { daily_cap: 0 }, db, ctx)).daily_cap).toBe(0);
    expect((await svc.updateScheme(c("echs"), { daily_cap: "" }, db, ctx)).daily_cap).toBeNull();
    const created = await failure(
      svc.createScheme({ code: c("capx"), label: `Cap ${tag}`, daily_cap: [] }, db, ctx),
    );
    expect(created?.status).toBe(400);
  });

  test("11. a sub-category is only valid for booking while its parent is active", async () => {
    await query(`UPDATE patient_schemes SET is_active = FALSE WHERE code = $1`, [c("echs")]);
    await svc.createScheme(
      { code: c("child_ok"), label: `Child ${tag}`, parent_code: c("cghs") },
      db,
      ctx,
    );
    expect(await svc.isKnownScheme(c("child_ok"), db)).toBe(true);
    await query(`UPDATE patient_schemes SET is_active = FALSE WHERE code = $1`, [c("cghs")]);
    expect(
      await svc.isKnownScheme(c("child_ok"), db),
      "parent retired behind the service's back",
    ).toBe(false);
    await query(`UPDATE patient_schemes SET is_active = TRUE WHERE code = $1`, [c("cghs")]);
    expect(await svc.isKnownScheme(c("child_ok"), db)).toBe(true);
  });
});
