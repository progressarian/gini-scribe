import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const rules = await import("../../../server/services/billing/paymentRules.js");
const schemes = await import("../../../server/services/patientSchemes.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.9.9.9" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p306_${name}_${tag}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);
const ids = {};

const DAY = "2026-10-15";
const resolve = (item, extra = {}) =>
  rules.ruleForLine({ category: c("paid"), item: ids[item], date: DAY, ...extra }, db);
const nameFor = async (item, extra) => (await resolve(item, extra)).rule?.name ?? null;
const addRule = (name, extra) =>
  rules
    .createPaymentRule(
      {
        scheme_code: c("paid"),
        name,
        patient_pays: "amount",
        patient_value: 100,
        valid_from: "2026-01-01",
        ...extra,
      },
      ctx,
      db,
    )
    .then((rule) => rule.id);

test.describe.serial("P3-06 payment rule resolver", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P306 CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("pensioner"), label: "Pensioner", parent_code: c("cghs") },
      db,
      ctx,
    );
    const group = (code) =>
      query(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
        `${code}-${T}`,
      ]).then((r) => r.rows[0].id);
    const subgroup = (groupId, code) =>
      query(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
        [groupId, `${code}-${T}`],
      ).then((r) => r.rows[0].id);
    const item = (code, subgroupId) =>
      query(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
         VALUES ($1, $1, $2, 1000, 'procedure') RETURNING id`,
        [`${code}-${T}`, subgroupId],
      ).then((r) => r.rows[0].id);
    ids.opd = await group("P306-OPD");
    ids.lab = await group("P306-LAB");
    ids.consults = await subgroup(ids.opd, "P306-CONSULTS");
    ids.procedures = await subgroup(ids.opd, "P306-PROCS");
    ids.tests = await subgroup(ids.lab, "P306-TESTS");
    ids.consult = await item("P306-CONSULT", ids.consults);
    ids.review = await item("P306-REVIEW", ids.consults);
    ids.dressing = await item("P306-DRESSING", ids.procedures);
    ids.sugar = await item("P306-SUGAR", ids.tests);
  });

  test("1. no rule means the patient pays in full", async () => {
    expect(await resolve("consult")).toEqual({
      rule: null,
      patient_pays: "full",
      patient_value: null,
      remainder: null,
      scope: null,
      from_parent: false,
    });
    const general = await rules.ruleForLine({ category: null, item: ids.consult, date: DAY }, db);
    expect(general.patient_pays, "no category (General) pays in full").toBe("full");
  });

  test("2. an item rule beats a subgroup rule, which beats a group rule, which beats a whole-category rule", async () => {
    await addRule("Whole Paid", { patient_pays: "percent", patient_value: 50 });
    expect(await resolve("sugar")).toMatchObject({
      patient_pays: "percent",
      patient_value: 50,
      remainder: "claim",
      scope: "category",
      from_parent: false,
    });
    await addRule("Consults subgroup", { subgroup_id: ids.consults });
    await addRule("Consult item", { service_item_id: ids.consult });
    expect(await nameFor("consult")).toBe("Consult item");
    expect(await nameFor("review")).toBe("Consults subgroup");
    expect(await nameFor("dressing"), "whole-category rule only").toBe("Whole Paid");
    await addRule("OPD group scoped", { group_id: ids.opd });
    expect(await nameFor("dressing")).toBe("OPD group scoped");
    expect((await resolve("dressing")).scope).toBe("group");
    expect(await nameFor("sugar"), "another group's items aren't covered").toBe("Whole Paid");
  });

  test("3. a Pensioner rule beats a CGHS rule, even a more specific one", async () => {
    await rules.createPaymentRule(
      {
        scheme_code: c("cghs"),
        name: "CGHS consult item",
        service_item_id: ids.consult,
        patient_pays: "amount",
        patient_value: 200,
        valid_from: "2026-01-01",
      },
      ctx,
      db,
    );
    const forPensioner = (item) =>
      rules.ruleForLine({ category: c("pensioner"), item: ids[item], date: DAY }, db);
    const inherited = await forPensioner("consult");
    expect([inherited.rule.name, inherited.from_parent], "the parent's rules apply").toEqual([
      "CGHS consult item",
      true,
    ]);
    await rules.createPaymentRule(
      {
        scheme_code: c("pensioner"),
        name: "Pensioner pays nothing",
        patient_pays: "nothing",
        valid_from: "2026-01-01",
      },
      ctx,
      db,
    );
    const own = await forPensioner("consult");
    expect(own).toMatchObject({
      patient_pays: "nothing",
      patient_value: null,
      scope: "category",
      from_parent: false,
    });
    expect(own.rule.name).toBe("Pensioner pays nothing");
    expect(await nameFor("consult"), "CGHS Paid keeps its own item rule").toBe("Consult item");
  });

  test("4. only rules for the visit type, or for any visit, apply", async () => {
    await addRule("Consult first visit", {
      service_item_id: ids.review,
      visit_types: ["New"],
    });
    expect(await nameFor("review", { visitType: "New" })).toBe("Consult first visit");
    expect(await nameFor("review", { visitType: "Follow Up" })).toBe("Consults subgroup");
    expect(await nameFor("review"), "a line with no visit type skips visit rules").toBe(
      "Consults subgroup",
    );
    const error = await failure(resolve("review", { visitType: "Tele" }));
    expect([error?.status, error?.message]).toEqual([
      400,
      "Visit type must be one of: New, Follow Up, Investigation",
    ]);
  });

  test("5. only active rules valid on the date apply", async () => {
    const later = await addRule("Dressing from November", {
      service_item_id: ids.dressing,
      valid_from: "2026-11-01",
    });
    const ended = await addRule("Dressing in September", {
      service_item_id: ids.dressing,
      valid_to: "2026-09-30",
    });
    expect(await nameFor("dressing"), "neither is valid on 15 October").toBe("OPD group scoped");
    expect(await nameFor("dressing", { date: "2026-11-01" })).toBe("Dressing from November");
    expect(await nameFor("dressing", { date: "2026-09-30" })).toBe("Dressing in September");
    await rules.setPaymentRuleActive(later, false, ctx, db);
    expect(await nameFor("dressing", { date: "2026-11-01" }), "a deactivated rule").toBe(
      "OPD group scoped",
    );
    expect(ended).toBeGreaterThan(0);
  });

  test("6. at the same level the lower priority wins, then the older rule", async () => {
    await addRule("Sugar low priority", { service_item_id: ids.sugar, priority: 50 });
    await addRule("Sugar high priority", { service_item_id: ids.sugar, priority: 10 });
    expect(await nameFor("sugar")).toBe("Sugar high priority");
    await addRule("Sugar same priority, newer", { service_item_id: ids.sugar, priority: 10 });
    expect(await nameFor("sugar"), "a tie goes to the rule saved first").toBe(
      "Sugar high priority",
    );
    await addRule("Sugar subgroup top priority", { subgroup_id: ids.tests, priority: 0 });
    expect(await nameFor("sugar"), "priority never beats a more specific level").toBe(
      "Sugar high priority",
    );
  });

  test("7. bad input is refused", async () => {
    const bad = [
      [{ category: c("paid"), item: 987654321, date: DAY }, 404, "That item doesn't exist"],
      [{ category: c("paid"), item: "x", date: DAY }, 400, "Choose a valid item"],
      [{ category: c("paid"), item: ids.consult, date: "15/10/2026" }, 400, /Date must be a date/],
    ];
    for (const [input, status, message] of bad) {
      const error = await failure(rules.ruleForLine(input, db));
      expect(error?.status, JSON.stringify(input)).toBe(status);
      expect(error.message).toMatch(message);
    }
    const today = await rules.ruleForLine({ category: c("paid"), item: ids.consult }, db);
    expect(today.rule.name, "the date defaults to today").toBe("Consult item");
  });

  test("8. review: the category must be one a line can be billed under", async () => {
    const line = (category) => rules.ruleForLine({ category, item: ids.consult, date: DAY }, db);
    const refusedWith = async (category, status, message) => {
      const error = await failure(line(category));
      expect([error?.status, error?.message], JSON.stringify(category)).toEqual([status, message]);
    };
    await refusedWith(`${c("paid")}x`, 404, "That category doesn't exist");
    await refusedWith(42, 400, "Category must be a category code");
    await refusedWith(
      c("cghs"),
      409,
      `P306 CGHS ${tag} has sub-categories, so a line can't be billed under it: choose one of its sub-categories`,
    );
    await schemes.createScheme({ code: c("old"), label: `P306 Old ${tag}` }, db, ctx);
    await schemes.updateScheme(c("old"), { is_active: false }, db, ctx);
    await refusedWith(c("old"), 409, `P306 Old ${tag} is retired`);
    expect((await line(`  ${c("paid").toUpperCase()} `)).rule.name, "code case and spaces").toBe(
      "Consult item",
    );
    for (const none of [null, undefined, "", "general", "GENERAL"]) {
      expect((await line(none)).patient_pays, `${none} means no category`).toBe("full");
    }
    const error = await failure(
      rules.ruleForLine({ category: "general", item: 987654321, date: DAY }, db),
    );
    expect(error?.status, "the item is checked even without a category").toBe(404);
  });
});
