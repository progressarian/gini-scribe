import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const resolver = await import("../../../server/services/billing/categoryResolver.js");
const schemes = await import("../../../server/services/patientSchemes.js");
const rules = await import("../../../server/services/billing/categoryRules.js");

const db = getPool();
const ctx = { actorId: USERS.admin.id, ip: null };
const tag = crypto.randomBytes(3).toString("hex");
const c = (name) => `${name}_${tag}`;
const DATE = "2026-10-01";
const ids = {};

const mineOnly = async () => {
  const data = await resolver.loadResolverData(db);
  return {
    schemes: new Map([...data.schemes].filter(([code]) => code.endsWith(tag))),
    rules: data.rules.filter((r) => r.scheme_code.endsWith(tag)),
  };
};
const resolve = async (patient, appointment = {}, date = DATE) =>
  resolver.resolveCategory({ patient, appointment, date }, await mineOnly());
const bornYearsAgo = (years, monthDay = "10-01") => `${2026 - years}-${monthDay}`;

test.describe.serial("P1-21 category resolver", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      {
        code: c("cghs"),
        label: `CGHS ${tag}`,
        requires_ref: true,
        payer_name: "CGHS Wellness Centre",
      },
      db,
      ctx,
    );
    for (const [code, label] of [
      [c("paid"), "CGHS Paid"],
      [c("pensioner"), "Pensioner"],
    ]) {
      await schemes.createScheme({ code, label, parent_code: c("cghs") }, db, ctx);
    }
    await schemes.createScheme({ code: c("senior"), label: `Senior ${tag}` }, db, ctx);
    await schemes.createScheme({ code: c("women"), label: `Women ${tag}` }, db, ctx);
    await schemes.createScheme({ code: c("old"), label: `Old ${tag}` }, db, ctx);
    await schemes.createScheme({ code: c("insurer"), label: `Insurer ${tag}` }, db, ctx);
    ids.senior60 = (
      await rules.createRule(
        { scheme_code: c("senior"), name: "60 and over", min_age: 60, mode: "auto", priority: 50 },
        ctx,
        db,
      )
    ).id;
    ids.pensioner = (
      await rules.createRule(
        {
          scheme_code: c("pensioner"),
          name: "Card 60+",
          min_age: 60,
          requires_card: true,
          mode: "auto",
          priority: 10,
        },
        ctx,
        db,
      )
    ).id;
    ids.women = (
      await rules.createRule({ scheme_code: c("women"), name: "Women", gender: "Female" }, ctx, db)
    ).id;
    ids.old = (
      await rules.createRule(
        { scheme_code: c("old"), name: "Over 90", min_age: 90, mode: "auto", priority: 1 },
        ctx,
        db,
      )
    ).id;
    await schemes.updateScheme(c("old"), { is_active: false }, db, ctx);
    ids.insurer = (
      await rules.createRule(
        { scheme_code: c("insurer"), name: "Any adult", min_age: 18, priority: 90 },
        ctx,
        db,
      )
    ).id;
    await schemes.createScheme(
      { code: c("insurer_gold"), label: "Gold", parent_code: c("insurer") },
      db,
      ctx,
    );
  });

  test("1. a category recorded on the appointment wins, even over a matching automatic rule", async () => {
    const r = await resolve(
      { dob: bornYearsAgo(70), sex: "Female", scheme_ref: "CARD-1", scheme_code: c("senior") },
      { patient_category: c("pensioner") },
    );
    expect(r).toMatchObject({ source: "appointment", needs_sub_category: false });
    expect(r.category).toMatchObject({
      code: c("pensioner"),
      display_label: `CGHS ${tag} › Pensioner`,
    });
    expect(r.parent).toMatchObject({ code: c("cghs"), payer_name: "CGHS Wellness Centre" });
  });

  test("2. otherwise the patient's recorded category wins", async () => {
    const r = await resolve(
      { dob: bornYearsAgo(75), scheme_code: c("women") },
      { patient_category: "" },
    );
    expect(r).toMatchObject({ source: "patient" });
    expect(r.category.code).toBe(c("women"));
    expect(r.parent).toBeNull();
  });

  test("3. otherwise the first matching automatic rule, in priority order", async () => {
    const withCard = await resolve({ dob: bornYearsAgo(65), sex: "M", scheme_ref: "CARD-2" });
    expect(withCard).toMatchObject({
      source: "rule",
      rule: { id: ids.pensioner, name: "Card 60+" },
      age: 65,
      age_source: "date_of_birth",
    });
    expect(withCard.category.code).toBe(c("pensioner"));
    expect(withCard.suggestions.map((s) => [s.category.code, s.reason])).toContainEqual([
      c("senior"),
      "lower_priority_auto_rule",
    ]);
    const noCard = await resolve({ dob: bornYearsAgo(65), sex: "M" });
    expect(noCard.rule.id).toBe(ids.senior60);
    const birthdayTomorrow = await resolve({ dob: bornYearsAgo(60, "10-02") });
    expect(birthdayTomorrow.source, "59 until tomorrow").toBe("general");
    const birthdayToday = await resolve({ dob: bornYearsAgo(60, "10-01") });
    expect(birthdayToday.rule.id).toBe(ids.senior60);
  });

  test("4. matching suggestion rules are offered; with nothing matching the patient is General", async () => {
    const r = await resolve({ dob: bornYearsAgo(30), sex: "female" });
    expect(r.source).toBe("general");
    expect(r.category).toBeNull();
    expect(
      r.suggestions.map((s) => [s.category.code, s.reason]),
      "in rule priority order",
    ).toEqual([
      [c("insurer"), "move_rule_to_sub_category"],
      [c("women"), "suggest_rule"],
    ]);
    const nobody = await resolve({ dob: bornYearsAgo(10), sex: "Male" });
    expect(nobody).toMatchObject({ source: "general", category: null, suggestions: [] });
  });

  test("5. safeguards from the reviews", async () => {
    const tie = await resolver.resolveCategory(
      { patient: { dob: bornYearsAgo(70) }, date: DATE },
      {
        schemes: (await mineOnly()).schemes,
        rules: [
          {
            id: 20,
            scheme_code: c("women"),
            name: "Later",
            min_age: 60,
            max_age: null,
            gender: null,
            requires_card: false,
            mode: "auto",
            priority: 5,
          },
          {
            id: 10,
            scheme_code: c("senior"),
            name: "Older",
            min_age: 60,
            max_age: null,
            gender: null,
            requires_card: false,
            mode: "auto",
            priority: 5,
          },
        ].sort((a, b) => a.priority - b.priority || a.id - b.id),
      },
    );
    expect(tie.rule.id, "equal priority: the oldest rule wins").toBe(10);
    const ninety = await resolve({ dob: bornYearsAgo(95) });
    expect(ninety.rule.id, "a retired category's rule is ignored").toBe(ids.senior60);
    expect(ninety.suggestions.map((s) => s.category.code)).not.toContain(c("old"));
    await schemes.updateScheme(c("senior"), { requires_ref: true }, db, ctx);
    const cardless = await resolve({ dob: bornYearsAgo(70) });
    expect(cardless.source, "a card category is never applied automatically without a card").toBe(
      "general",
    );
    expect(cardless.suggestions.map((s) => [s.category.code, s.reason])).toContainEqual([
      c("senior"),
      "needs_card",
    ]);
    await schemes.updateScheme(c("senior"), { requires_ref: false }, db, ctx);
  });

  test("6. a recorded category that is retired, unknown or a bare parent", async () => {
    const retired = await resolve({ dob: bornYearsAgo(70), scheme_code: c("old") });
    expect(retired.source).toBe("rule");
    expect(retired.warnings).toEqual([
      `The recorded category Old ${tag} is retired, so it was not used`,
    ]);
    const unknown = await resolve({ scheme_code: "nope_nope" });
    expect(unknown.warnings).toEqual([
      'The recorded category "nope_nope" doesn\'t exist, so it was not used',
    ]);
    const bare = await resolve({ scheme_code: c("cghs") });
    expect(bare).toMatchObject({ source: "patient", needs_sub_category: true });
    expect(bare.suggestions.map((s) => [s.category.display_label, s.reason])).toEqual([
      [`CGHS ${tag} › CGHS Paid`, "choose_sub_category"],
      [`CGHS ${tag} › Pensioner`, "choose_sub_category"],
    ]);
  });

  test("7. gender is normalised and age falls back to the recorded age", async () => {
    expect(
      ["M", "male", " MALE ", "F", "Female", "", null, "Transgender"].map(resolver.normalizeGender),
    ).toEqual(["Male", "Male", "Male", "Female", "Female", null, null, "Other"]);
    const women = await resolve({ dob: bornYearsAgo(30), sex: "F" });
    expect(women.suggestions.map((s) => s.category.code)).toContain(c("women"));
    const recorded = await resolve({ age: 66 });
    expect(recorded).toMatchObject({
      age: 66,
      age_source: "recorded_age",
      rule: { id: ids.senior60 },
    });
    const unknownAge = await resolve({ sex: "Male" });
    expect(unknownAge).toMatchObject({ age: null, source: "general" });
    expect(resolver.ageOn("2000-02-29", "2026-02-28")).toBe(25);
    expect(resolver.ageOn("2000-02-29", "2026-03-01")).toBe(26);
    expect(resolver.ageOn("2030-01-01", DATE)).toBeNull();
    expect(resolver.indiaToday(new Date("2026-09-30T20:00:00Z"))).toBe("2026-10-01");
  });

  test("8. resolveCategoryFor reads the live data", async () => {
    const r = await resolver.resolveCategoryFor(
      { patient: { scheme_code: c("pensioner") }, date: DATE },
      db,
    );
    expect(r).toMatchObject({ source: "patient", category: { code: c("pensioner") } });
  });
});
