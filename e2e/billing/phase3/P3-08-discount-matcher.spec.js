import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/discountRules.js");
const schemes = await import("../../../server/services/patientSchemes.js");
const { indiaToday } = await import("../../../server/services/billing/categoryResolver.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.8.8.8" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p308_${name}_${tag}`;
const code = (name) => `${name}${T}`;
const ids = {};
const mine = new Set();

const DAY = "2026-10-15";
const NEXT_DAY = "2026-10-16";
const base = {
  category: null,
  patient: { id: 900001, age: 40, gender: "Male" },
  date: DAY,
  role: "reception",
  codesOnBill: 0,
};
const context = (extra = {}) => ({
  ...base,
  ...extra,
  patient: { ...base.patient, ...extra.patient },
});
const lineFor = (item, extra = {}) => ({
  item_id: ids[item],
  subgroup_id: ids[`${item}Subgroup`],
  group_id: ids[`${item}Group`],
  doctor_id: null,
  visit_type: null,
  ...extra,
});
const addRule = (name, extra) =>
  svc
    .createDiscountRule(
      { name: `${name} ${tag}`, method: "auto", kind: "percent", value: 5, ...extra },
      ctx,
      db,
    )
    .then((rule) => mine.add(rule.id) && rule.id);
const addCode = (name, extra) => addRule(name, { method: "code", code: code(name), ...extra });
const autoIds = async (line, extra, client = db) =>
  (await svc.autoRulesFor(line, context(extra), client))
    .map((rule) => rule.id)
    .filter((id) => mine.has(id));
const matches = async (rule, line, extra) => (await autoIds(line, extra)).includes(ids[rule]);
const refusal = async (text, line, extra, client = db) => {
  const result = await svc.checkCode(text, line, context(extra), client);
  return result.ok ? { ok: true } : { reason: result.reason, message: result.message };
};

async function scratchUsage(work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE bills (id SERIAL PRIMARY KEY, patient_id INT, bill_date DATE, status TEXT);
      CREATE TABLE bill_lines (id SERIAL PRIMARY KEY, bill_id INT, doctor_id INT,
                               is_live BOOLEAN NOT NULL DEFAULT TRUE);
      CREATE TABLE bill_line_discounts (id SERIAL PRIMARY KEY, bill_line_id INT, rule_id INT);`);
    const use = async (
      ruleId,
      { patient = 900001, date = DAY, doctor = null, status = "final" },
    ) => {
      const bill = await client.query(
        `INSERT INTO bills (patient_id, bill_date, status) VALUES ($1, $2, $3) RETURNING id`,
        [patient, date, status],
      );
      const line = await client.query(
        `INSERT INTO bill_lines (bill_id, doctor_id) VALUES ($1, $2) RETURNING id`,
        [bill.rows[0].id, doctor],
      );
      await client.query(
        `INSERT INTO bill_line_discounts (bill_line_id, rule_id) VALUES ($1, $2)`,
        [line.rows[0].id, ruleId],
      );
      return bill.rows[0].id;
    };
    return await work(client, use);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

test.describe.serial("P3-08 discount matcher", () => {
  test.afterAll(async () => {
    await query(
      `UPDATE discount_rules SET is_active = FALSE WHERE method = 'auto' AND id = ANY($1::int[])`,
      [[...mine]],
    );
  });

  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P308 CGHS ${tag}`, payer_name: "CGHS" },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("pens"), label: "Pensioner", parent_code: c("cghs") },
      db,
      ctx,
    );
    await schemes.createScheme({ code: c("echs"), label: `P308 ECHS ${tag}` }, db, ctx);
    const one = (sql, params) => query(sql, params).then((r) => r.rows[0].id);
    const group = (name) =>
      one(`INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`, [
        `P308${name}-${T}`,
        `P308 ${name} ${tag}`,
      ]);
    const subgroup = (groupId, name) =>
      one(`INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $3) RETURNING id`, [
        groupId,
        `P308${name}-${T}`,
        `P308 ${name}`,
      ]);
    const item = async (key, groupId, subgroupId) => {
      ids[`${key}Group`] = groupId;
      ids[`${key}Subgroup`] = subgroupId;
      ids[key] = await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
         VALUES ($1, $2, $3, 1000, 'procedure') RETURNING id`,
        [`P308-${key}-${T}`, `P308 ${key}`, subgroupId],
      );
    };
    const opd = await group("OPD");
    const lab = await group("LAB");
    const consults = await subgroup(opd, "CONS");
    const tests = await subgroup(lab, "TESTS");
    await item("consult", opd, consults);
    await item("dressing", opd, consults);
    await item("sugar", lab, tests);
    ids.labGroup = lab;
    const doctor = (name) =>
      one(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
        [name],
      );
    ids.drA = await doctor(`Dr P308 A ${tag}`);
    ids.drB = await doctor(`Dr P308 B ${tag}`);
  });

  test("1. automatic rules: targets are a union, all-empty targets cover every line", async () => {
    ids.union = await addRule("Union", {
      group_ids: [ids.labGroup],
      service_item_ids: [ids.consult],
    });
    ids.everything = await addRule("Everything", { value: 1 });
    expect(await matches("union", lineFor("consult")), "listed item").toBe(true);
    expect(await matches("union", lineFor("sugar")), "item in a listed group").toBe(true);
    expect(await matches("union", lineFor("dressing")), "neither").toBe(false);
    expect(await matches("everything", lineFor("dressing"))).toBe(true);
    const found = (await svc.autoRulesFor(lineFor("sugar"), context(), db)).find(
      (rule) => rule.id === ids.union,
    );
    expect(found).toMatchObject({
      method: "auto",
      value: 5,
      max_discount: null,
      applies_per: "line",
    });
  });

  test("2. automatic rules: a parent category covers its sub-categories, general means no category", async () => {
    ids.parent = await addRule("Parent", { scheme_codes: [c("cghs")] });
    ids.child = await addRule("Child", { scheme_codes: [c("paid")] });
    ids.general = await addRule("General", { scheme_codes: ["general"] });
    const line = lineFor("consult");
    const on = async (category) => {
      const found = await autoIds(line, { category });
      return ["parent", "child", "general", "everything"].filter((k) => found.includes(ids[k]));
    };
    expect(await on(c("paid"))).toEqual(["parent", "child", "everything"]);
    expect(await on(` ${c("pens").toUpperCase()} `)).toEqual(["parent", "everything"]);
    expect(await on(c("cghs"))).toEqual(["parent", "everything"]);
    expect(await on(c("echs"))).toEqual(["everything"]);
    expect(await on(null)).toEqual(["general", "everything"]);
    expect(await on("General")).toEqual(["general", "everything"]);
    const error = await svc
      .autoRulesFor(line, context({ category: c("nope") }), db)
      .catch((e) => e);
    expect([error.status, error.message]).toEqual([404, "That category doesn't exist"]);
  });

  test("3. automatic rules: age and gender, and unknown age or gender doesn't match", async () => {
    ids.seniors = await addRule("Seniors", { min_age: 70 });
    ids.women = await addRule("Women", { gender: "Female" });
    ids.kids = await addRule("Kids", { max_age: 12 });
    const line = lineFor("consult");
    expect(await matches("seniors", line, { patient: { age: 69 } })).toBe(false);
    expect(await matches("seniors", line, { patient: { age: 70 } })).toBe(true);
    expect(await matches("seniors", line, { patient: { age: 71 } })).toBe(true);
    expect(await matches("seniors", line, { patient: { age: null } }), "age unknown").toBe(false);
    expect(await matches("kids", line, { patient: { age: 12 } })).toBe(true);
    expect(await matches("kids", line, { patient: { age: 13 } })).toBe(false);
    expect(await matches("kids", line, { patient: { age: null } }), "age unknown").toBe(false);
    expect(await matches("women", line, { patient: { gender: "F" } })).toBe(true);
    expect(await matches("women", line, { patient: { gender: "Male" } })).toBe(false);
    expect(await matches("women", line, { patient: { gender: null } }), "gender unknown").toBe(
      false,
    );
  });

  test("4. automatic rules: dates are inclusive, inactive rules and bill-level rules stay out", async () => {
    ids.october = await addRule("October", { valid_from: "2026-10-01", valid_to: "2026-10-31" });
    ids.off = await addRule("Off", {});
    await svc.setDiscountRuleActive(ids.off, false, ctx, db);
    ids.billAuto = await addRule("Bill auto", { kind: "flat", value: 50, applies_per: "bill" });
    const line = lineFor("consult");
    expect(await matches("october", line, { date: "2026-09-30" })).toBe(false);
    expect(await matches("october", line, { date: "2026-10-01" })).toBe(true);
    expect(await matches("october", line, { date: "2026-10-31" })).toBe(true);
    expect(await matches("october", line, { date: "2026-11-01" })).toBe(false);
    expect(await matches("off", line)).toBe(false);
    expect(await matches("billAuto", line), "a bill-level rule isn't a line's").toBe(false);
    const forBill = await autoIds(null, {});
    expect(forBill).toContain(ids.billAuto);
    expect(forBill).not.toContain(ids.everything);
  });

  test("5. automatic rules: visit type and doctor, ordered by priority then id", async () => {
    ids.newOnly = await addRule("New only", { visit_types: ["New"], priority: 5 });
    ids.drAOnly = await addRule("Dr A only", { doctor_ids: [ids.drA], priority: 5 });
    ids.first = await addRule("First", { priority: 1 });
    const line = lineFor("consult");
    expect(await matches("newOnly", { ...line, visit_type: "New" })).toBe(true);
    expect(await matches("newOnly", { ...line, visit_type: "Follow Up" })).toBe(false);
    expect(await matches("newOnly", line), "no visit type").toBe(false);
    expect(await matches("drAOnly", { ...line, doctor_id: ids.drA })).toBe(true);
    expect(await matches("drAOnly", { ...line, doctor_id: ids.drB })).toBe(false);
    expect(await matches("drAOnly", line), "no doctor").toBe(false);
    const order = await autoIds({ ...line, visit_type: "New", doctor_id: ids.drA }, {});
    const mine = [ids.first, ids.newOnly, ids.drAOnly, ids.everything];
    expect(order.filter((id) => mine.includes(id))).toEqual(mine);
  });

  test("6. codes match ignoring case and spaces; a good code returns its rule", async () => {
    ids.staff = await addCode("STAFF", {});
    const result = await svc.checkCode(
      `  ${code("staff").toLowerCase()} `,
      lineFor("consult"),
      context(),
      db,
    );
    expect(result.ok).toBe(true);
    expect(result.rule).toMatchObject({ id: ids.staff, code: code("STAFF"), value: 5 });
    ids.billCode = await addCode("BILLCODE", {
      kind: "flat",
      value: 100,
      applies_per: "bill",
      group_ids: [ids.labGroup],
    });
    const bill = await svc.checkCode(code("BILLCODE"), lineFor("consult"), context(), db);
    expect([bill.ok, bill.rule.applies_per]).toEqual([true, "bill"]);
    expect(await refusal(code("BILLCODE"), null, {})).toEqual({ ok: true });
  });

  test("7. every refusal that doesn't need usage", async () => {
    const line = lineFor("consult");
    expect(await refusal(code("NOPE"), line, {})).toEqual({
      reason: "unknown",
      message: `There's no discount with the code ${code("NOPE")}`,
    });
    ids.gone = await addCode("GONE", {});
    await svc.setDiscountRuleActive(ids.gone, false, ctx, db);
    expect(await refusal(code("GONE"), line, {})).toEqual({
      reason: "inactive",
      message: `The code ${code("GONE")} is switched off`,
    });
    ids.adminOnly = await addCode("ADMINONLY", { allowed_roles: ["reception_admin"] });
    expect(await refusal(code("ADMINONLY"), line, {})).toEqual({
      reason: "role",
      message: `The code ${code("ADMINONLY")} can only be entered by reception_admin, not reception`,
    });
    expect(await refusal(code("ADMINONLY"), line, { role: "reception_admin" })).toEqual({
      ok: true,
    });
    expect((await refusal(code("STAFF"), line, { role: "nurse" })).reason, "not a desk role").toBe(
      "role",
    );
    ids.later = await addCode("LATER", { valid_from: NEXT_DAY });
    expect(await refusal(code("LATER"), line, {})).toEqual({
      reason: "not_yet_valid",
      message: `The code ${code("LATER")} can't be used before ${NEXT_DAY}`,
    });
    ids.old = await addCode("OLD", { valid_to: "2026-10-14" });
    expect(await refusal(code("OLD"), line, {})).toEqual({
      reason: "expired",
      message: `The code ${code("OLD")} expired: it was valid until 2026-10-14`,
    });
    ids.forCghs = await addCode("FORCGHS", { scheme_codes: [c("cghs")] });
    expect(await refusal(code("FORCGHS"), line, { category: c("echs") })).toEqual({
      reason: "category",
      message: `The code ${code("FORCGHS")} isn't for P308 ECHS ${tag}`,
    });
    expect((await refusal(code("FORCGHS"), line, {})).message).toBe(
      `The code ${code("FORCGHS")} isn't for patients with no category`,
    );
    expect(await refusal(code("FORCGHS"), line, { category: c("pens") })).toEqual({ ok: true });
    ids.senior = await addCode("SENIOR", { min_age: 70, gender: "Female" });
    expect(await refusal(code("SENIOR"), line, { patient: { age: 60, gender: "Female" } })).toEqual(
      {
        reason: "patient",
        message: `The code ${code("SENIOR")} is only for female patients aged 70 and over`,
      },
    );
    expect(
      (await refusal(code("SENIOR"), line, { patient: { age: null, gender: null } })).message,
    ).toBe(
      `The code ${code("SENIOR")} is only for female patients aged 70 and over, and this patient's age and gender aren't recorded`,
    );
    ids.labCode = await addCode("LAB", { group_ids: [ids.labGroup] });
    expect(await refusal(code("LAB"), line, {})).toEqual({
      reason: "items",
      message: `The code ${code("LAB")} isn't for these items`,
    });
    ids.coupon = await addCode("COUPON", { doctor_ids: [ids.drA] });
    expect(await refusal(code("COUPON"), { ...line, doctor_id: ids.drB }, {})).toEqual({
      reason: "doctor",
      message: `The code ${code("COUPON")} isn't for this doctor; it is only for Dr P308 A ${tag}`,
    });
    expect(await refusal(code("COUPON"), line, {}), "a line with no doctor").toEqual({
      reason: "doctor",
      message: `The code ${code("COUPON")} is only for Dr P308 A ${tag}, and this line has no doctor`,
    });
    ids.followUp = await addCode("FOLLOWUP", { visit_types: ["Follow Up"] });
    expect(await refusal(code("FOLLOWUP"), { ...line, visit_type: "New" }, {})).toEqual({
      reason: "visit_type",
      message: `The code ${code("FOLLOWUP")} is only for Follow Up visits`,
    });
  });

  test("8. too many codes on this bill, against billing settings", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE billing_settings SET max_codes_per_bill = 2`);
      const line = lineFor("consult");
      expect(await refusal(code("STAFF"), line, { codesOnBill: 1 }, client)).toEqual({ ok: true });
      expect(await refusal(code("STAFF"), line, { codesOnBill: 2 }, client)).toEqual({
        reason: "too_many_codes",
        message: "A bill can have at most 2 discount codes, and this bill already has 2",
      });
      await client.query(`UPDATE billing_settings SET max_codes_per_bill = NULL`);
      expect(await refusal(code("STAFF"), line, { codesOnBill: 50 }, client)).toEqual({ ok: true });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("9. usage limits: total, patient, daily, per doctor per day; cancelled bills give uses back", async () => {
    ids.total = await addCode("TOTAL", { max_uses_total: 2 });
    ids.perPatient = await addCode("PERPATIENT", { max_uses_per_patient: 1 });
    ids.daily = await addCode("DAILY", { max_uses_per_day: 2 });
    ids.drDaily = await addCode("DRDAILY", { max_uses_per_doctor_per_day: 1 });
    ids.autoCapped = await addRule("Auto capped", { max_uses_total: 1 });
    const line = lineFor("consult", { doctor_id: ids.drA });
    expect(await refusal(code("TOTAL"), line, {}), "no bills table yet: nothing used").toEqual({
      ok: true,
    });
    await scratchUsage(async (client, use) => {
      await use(ids.total, { patient: 1, date: "2026-10-01" });
      expect(await refusal(code("TOTAL"), line, {}, client)).toEqual({ ok: true });
      await use(ids.total, { patient: 2, date: "2026-10-02" });
      expect(await refusal(code("TOTAL"), line, {}, client)).toEqual({
        reason: "total_limit",
        message: "Total limit reached — 2 of 2 used",
      });

      await use(ids.perPatient, { patient: 900001 });
      expect(await refusal(code("PERPATIENT"), line, {}, client)).toEqual({
        reason: "patient_limit",
        message: "Limit for this patient reached — 1 of 1 used",
      });
      expect(await refusal(code("PERPATIENT"), line, { patient: { id: 900002 } }, client)).toEqual({
        ok: true,
      });

      await use(ids.daily, { patient: 5 });
      expect(await refusal(code("DAILY"), line, {}, client)).toEqual({ ok: true });
      const second = await use(ids.daily, { patient: 6 });
      expect(await refusal(code("DAILY"), line, {}, client)).toEqual({
        reason: "daily_limit",
        message: "Daily limit reached — 2 of 2 used today",
      });
      expect(await refusal(code("DAILY"), line, { date: NEXT_DAY }, client), "next day").toEqual({
        ok: true,
      });
      await client.query(`UPDATE bills SET status = 'cancelled' WHERE id = $1`, [second]);
      expect(await refusal(code("DAILY"), line, {}, client), "cancelled bill").toEqual({
        ok: true,
      });
      await use(ids.daily, { patient: 7, status: "draft" });
      expect(await refusal(code("DAILY"), line, {}, client), "draft bill").toEqual({ ok: true });

      await use(ids.drDaily, { doctor: ids.drA });
      expect(await refusal(code("DRDAILY"), line, {}, client)).toEqual({
        reason: "doctor_daily_limit",
        message: `Daily limit for Dr P308 A ${tag} reached — 1 of 1 used today`,
      });
      expect(
        await refusal(code("DRDAILY"), { ...line, doctor_id: ids.drB }, {}, client),
        "another doctor",
      ).toEqual({ ok: true });

      expect(await autoIds(line, {}, client)).toContain(ids.autoCapped);
      await use(ids.autoCapped, {});
      expect(await autoIds(line, {}, client), "an auto rule past its limit").not.toContain(
        ids.autoCapped,
      );
    });
  });

  test("10. usageToday counts today's uses overall and per doctor", async () => {
    expect(await svc.usageToday(ids.drDaily, db)).toEqual({
      date: indiaToday(),
      count: 0,
      by_doctor: [],
    });
    await scratchUsage(async (client, use) => {
      const today = indiaToday();
      await use(ids.drDaily, { date: today, doctor: ids.drA });
      await use(ids.drDaily, { date: today, doctor: ids.drA });
      await use(ids.drDaily, { date: today, doctor: ids.drB });
      await use(ids.drDaily, { date: today });
      await use(ids.drDaily, { date: "2026-01-01", doctor: ids.drA });
      await use(ids.drDaily, { date: today, doctor: ids.drB, status: "cancelled" });
      expect(await svc.usageToday(ids.drDaily, client)).toEqual({
        date: today,
        count: 4,
        by_doctor: [
          { doctor_id: ids.drA, name: `Dr P308 A ${tag}`, count: 2 },
          { doctor_id: ids.drB, name: `Dr P308 B ${tag}`, count: 1 },
        ],
      });
    });
  });

  test("11. review: an age that can't be real counts as unknown instead of stopping the line", async () => {
    const line = lineFor("consult");
    expect(await matches("kids", line, { patient: { age: 0 } }), "a newborn").toBe(true);
    expect(await matches("seniors", line, { patient: { age: 150 } })).toBe(true);
    expect(await matches("seniors", line, { patient: { age: "72" } }), "age as text").toBe(true);
    for (const age of [176, -1, 2.5]) {
      expect(await matches("seniors", line, { patient: { age } }), String(age)).toBe(false);
      expect(await matches("everything", line, { patient: { age } }), String(age)).toBe(true);
      expect(
        (await refusal(code("SENIOR"), line, { patient: { age, gender: "Female" } })).message,
        String(age),
      ).toBe(
        `The code ${code("SENIOR")} is only for female patients aged 70 and over, and this patient's age isn't recorded`,
      );
    }
    const error = await svc
      .autoRulesFor(line, context({ patient: { age: "old" } }), db)
      .catch((e) => e);
    expect([error.status, error.message]).toEqual([400, "Age must be a number"]);
  });

  test("12. review: usage for every automatic rule on a line is read in one query", async () => {
    ids.capTotal = await addRule("Cap total", { max_uses_total: 1 });
    ids.capDaily = await addRule("Cap daily", { max_uses_per_day: 1, max_uses_per_patient: 5 });
    const line = lineFor("consult", { doctor_id: ids.drA });
    await scratchUsage(async (client, use) => {
      await use(ids.capTotal, { date: "2026-10-01" });
      await use(ids.capDaily, { date: "2026-10-01" });
      let count = 0;
      const counting = { query: (...args) => (count++, client.query(...args)) };
      const found = await autoIds(line, {}, counting);
      expect([found.includes(ids.capTotal), found.includes(ids.capDaily)]).toEqual([false, true]);
      expect(count, "rules, the usage table check, one usage query").toBe(3);
      await use(ids.capDaily, {});
      expect(await autoIds(line, {}, client)).not.toContain(ids.capDaily);
      expect(await autoIds(line, { date: NEXT_DAY }, client)).toContain(ids.capDaily);
    });
  });
});
