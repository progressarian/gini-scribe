import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { newTag, refused } from "../phase4/p4-bills-fixture.mjs";
import { db, privateDay, SEED_WAIT_MS, seedReports, unseed } from "./p5-reports-seed.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const reports = await import("../../../server/services/billing/reports.js");
const filters = await import("../../../server/services/billing/reportsFilters.js");
const { indiaToday } = await import("../../../server/services/billing/categoryResolver.js");

const tag = newTag();
let ids;

const NOTHING = {
  category: "zz_nobody",
  sub_category: "zz_nobody",
  group: "ZZ-NOBODY",
  subgroup: "ZZ-NOBODY",
  consultant: "2147483000",
  user: "2147483000",
};

const QUANTITIES = new Set(["money", "count", "quantity"]);

const quantitiesOf = (part, row) =>
  part.columns.filter((c) => QUANTITIES.has(c.kind)).map((c) => row?.[c.key] ?? 0);

const isEmpty = (part) =>
  [...part.rows, part.total].every((row) => quantitiesOf(part, row).every((v) => v === 0));

const hasData = (result) =>
  result.sections.some((part) => quantitiesOf(part, part.total).some((v) => v !== 0));

const run = (key, input) => reports.runReport(key, input, db);

test.describe.serial("P5-06 reports service — one filter builder for every report", () => {
  test.beforeAll(async () => {
    test.setTimeout(SEED_WAIT_MS + 60000);
    ids = await seedReports(tag);
  });

  test.afterAll(async () => {
    await unseed(ids);
  });

  test("1. the builder cleans every filter the same way for every report", () => {
    const revenue = reports.REPORTS.revenue_items;
    const today = indiaToday();
    expect(filters.cleanFilters({}, revenue)).toEqual({
      from: `${today.slice(0, 8)}01`,
      to: today,
      period: "none",
    });
    expect(filters.cleanFilters({ to: "2026-02-14", group: " LAB " }, revenue)).toMatchObject({
      from: "2026-02-01",
      to: "2026-02-14",
      group: "LAB",
    });
    expect(filters.cleanFilters({ to: "2026-02-14" }, reports.REPORTS.dues).from).toBeNull();
    const cases = [
      [{ from: "2026-02-30" }, /From must be a date/],
      [{ from: "2026-03-02", to: "2026-03-01" }, /start date is after the end date/],
      [{ from: "2025-01-01", to: "2026-03-01" }, /at most 366 days/],
      [{ period: "fortnight" }, /By must be one of/],
      [{ consultant: "Dr X" }, /Consultant must be an id/],
      [{ group: "two words" }, /Group must be a code without spaces/],
      [{ colour: "red" }, /Unknown filter: colour/],
    ];
    for (const [input, message] of cases) {
      expect(() => filters.cleanFilters(input, revenue), JSON.stringify(input)).toThrow(message);
    }
    for (const key of reports.REPORT_KEYS) {
      const report = reports.REPORTS[key];
      for (const filter of Object.keys(NOTHING)) {
        if (report.filters.includes(filter)) continue;
        expect(
          () => filters.cleanFilters({ [filter]: NOTHING[filter] }, report),
          `${key} ${filter}`,
        ).toThrow(`The ${report.title} report can't be filtered by`);
      }
    }
  });

  test("2. every report reads only the days asked for, and every section obeys them", async () => {
    const day = ids.privateDay;
    const next = privateDay(tag, 1);
    for (const key of reports.REPORT_KEYS) {
      const on = await run(key, { from: day, to: day });
      expect(hasData(on), `${key} has data on its day`).toBe(true);
      const after = await run(key, { from: next, to: next });
      for (const part of after.sections) {
        expect(isEmpty(part), `${key}/${part.key} is empty the day after`).toBe(true);
      }
      const before = await run(key, { from: privateDay(tag, -1), to: privateDay(tag, -1) });
      for (const part of before.sections) {
        expect(isEmpty(part), `${key}/${part.key} is empty the day before`).toBe(true);
      }
    }
  });

  test("3. every filter a report offers reaches every one of its sections", async () => {
    const day = ids.privateDay;
    for (const key of reports.REPORT_KEYS) {
      const report = reports.REPORTS[key];
      for (const filter of report.filters) {
        if (!NOTHING[filter]) continue;
        const result = await run(key, { from: day, to: day, [filter]: NOTHING[filter] });
        for (const part of result.sections) {
          expect(isEmpty(part), `${key}/${part.key} filtered by ${filter}`).toBe(true);
        }
      }
    }
  });

  test("4. a report's own filter value keeps its rows, and codes match ignoring case", async () => {
    const day = ids.privateDay;
    const all = await run("revenue_items", { from: day, to: day });
    const same = await run("revenue_items", {
      from: day,
      to: day,
      category: ids.parent,
      group: `p4g-${tag}`,
      subgroup: `P4S-${tag.toUpperCase()}`,
    });
    expect(same.sections[0].total).toEqual(all.sections[0].total);
    const pensioner = await run("revenue_categories", {
      from: day,
      to: day,
      sub_category: ids.pensioner,
    });
    expect(pensioner.sections[0].rows.map((r) => r.code)).toEqual([ids.parent, ids.pensioner]);
  });

  test("5. an unknown report is a 404, and no report reads a date outside the builder", async () => {
    await refused(run("everything", {}), 404, /no such billing report/, "unknown report");
    const source = fs.readFileSync(
      path.join(repoRoot, "server", "services", "billing", "reports.js"),
      "utf8",
    );
    expect(source.match(/cleanFilters\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/cleanDate|\$\{filters\.(from|to)\}/);
  });
});
