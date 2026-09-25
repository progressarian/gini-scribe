import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { newTag } from "../phase4/p4-bills-fixture.mjs";
import { db, linesOfMine, paiseOf, SEED_WAIT_MS, seedReports, unseed } from "./p5-reports-seed.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const reports = await import("../../../server/services/billing/reports.js");

const tag = newTag();
let ids;

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

const run = (extra = {}) =>
  reports.runReport("discounts", { from: ids.privateDay, to: ids.privateDay, ...extra }, db);

async function stepsOfMine(status = ["final"]) {
  const { rows } = await db.query(
    `SELECT d.*, b.id AS bill_id, b.status, b.bill_type
       FROM bill_line_discounts d
       JOIN bill_lines l ON l.id = d.bill_line_id
       JOIN bills b ON b.id = l.bill_id
      WHERE b.id = ANY($1::uuid[]) AND b.status = ANY($2::text[])`,
    [ids.allBills, status],
  );
  return rows;
}

const amountOf = (steps) => steps.reduce((total, step) => total + paiseOf(step.amount), 0);

test.describe.serial("P5-09 discount report", () => {
  test.beforeAll(async () => {
    test.setTimeout(SEED_WAIT_MS + 60000);
    ids = await seedReports(tag);
  });

  test.afterAll(async () => {
    await unseed(ids);
  });

  test("1. every breakdown totals exactly what bill_line_discounts holds for final bills", async () => {
    const steps = await stepsOfMine();
    const given = amountOf(steps);
    expect(given).toBeGreaterThan(0);
    const withCancelled = amountOf(await stepsOfMine(["final", "cancelled"]));
    expect(withCancelled).toBeGreaterThan(given);

    const result = await run();
    const byKey = Object.fromEntries(result.sections.map((part) => [part.key, part]));
    for (const key of ["rules", "methods", "categories", "consultants", "users"]) {
      const part = byKey[key];
      expect(part.total, key).toEqual({
        steps: steps.length,
        bills: new Set(steps.map((step) => step.bill_id)).size,
        amount: given,
      });
      const top = part.rows.filter((row) => (row.depth ?? 1) === 1);
      expect(sum(top, "amount"), key).toBe(given);
      expect(sum(top, "steps"), key).toBe(steps.length);
    }
    const code = byKey.rules.rows.find((row) => row.label === `P4 ${ids.code} ${tag}`);
    const auto = byKey.rules.rows.find((row) => row.label === `P4 auto ${tag}`);
    expect(code).toMatchObject({
      code: ids.code,
      method: "code",
      amount: amountOf(steps.filter((s) => s.rule_id === ids.codeRule)),
    });
    expect(auto).toMatchObject({
      code: null,
      method: "auto",
      amount: amountOf(steps.filter((s) => s.rule_id === ids.autoRule)),
    });
    expect(Object.fromEntries(byKey.methods.rows.map((row) => [row.label, row.amount]))).toEqual({
      Code: code.amount,
      Automatic: auto.amount,
    });
    const [category, pensioner] = byKey.categories.rows;
    expect(category).toMatchObject({ level: "category", amount: given });
    expect(pensioner).toMatchObject({ level: "sub_category", label: "Pensioner", amount: given });
    expect(byKey.users.rows).toEqual([
      expect.objectContaining({ label: USERS.reception_admin.name, amount: given }),
    ]);
    expect(byKey.consultants.rows).toEqual([
      expect.objectContaining({ label: CONSULTANTS.banshali.name, amount: given }),
    ]);
  });

  test("2. discount as a % of actual per group, with what credit notes gave back", async () => {
    const lines = (await linesOfMine(ids)).filter((line) => line.status === "final");
    const given = amountOf(await stepsOfMine());
    const invoiced = lines
      .filter((line) => line.bill_type === "invoice")
      .reduce((t, line) => t + paiseOf(line.actual_amount), 0);
    const creditLines = lines.filter((line) => line.bill_type === "credit_note");
    const creditedDiscount = creditLines.reduce((t, line) => t + paiseOf(line.discount), 0);
    const creditedActual = creditLines.reduce((t, line) => t + paiseOf(line.actual_amount), 0);
    expect(creditedDiscount).toBeGreaterThan(0);

    const part = (await run()).sections.find((section) => section.key === "groups");
    const [group] = part.rows;
    const pct = (a, b) => Math.round((10000 * a) / b) / 100;
    expect(group).toMatchObject({
      label: `P4 Group ${tag}`,
      actual: invoiced,
      amount: given,
      percent: pct(given, invoiced),
      credited_discount: creditedDiscount,
      net_discount: given - creditedDiscount,
      net_percent: pct(given - creditedDiscount, invoiced - creditedActual),
    });
    expect(part.total).toMatchObject({ actual: invoiced, amount: given });
  });

  test("3. the filters narrow the discounts the same way as everywhere else", async () => {
    const all = await run();
    const rahul = await run({ consultant: CONSULTANTS.rahul.id });
    expect(rahul.sections[0].total.amount).toBe(0);
    const me = await run({ user: USERS.reception_admin.id });
    expect(me.sections[0].total).toEqual(all.sections[0].total);
    const claimOnly = await run({ sub_category: ids.paid });
    expect(claimOnly.sections[0].total.amount).toBe(0);
    const group = await run({ group: `P4G-${tag}` });
    expect(group.sections.at(-1).total).toEqual(all.sections.at(-1).total);
  });
});
