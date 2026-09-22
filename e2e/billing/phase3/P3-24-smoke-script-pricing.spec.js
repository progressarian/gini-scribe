import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { buildTestEnv, repoRoot } from "../../setup/testEnv.mjs";

const CHECKS = [
  "1a",
  "1b",
  "1c",
  "1d",
  "1e",
  "2a",
  "2b",
  "2c",
  "3a",
  "3b",
  "4",
  "5a",
  "5b",
  "6",
  "7b",
  "7c",
  "7d",
  "7e",
  "8",
  "9",
  "10",
];

const counts = () =>
  one(
    `SELECT (SELECT count(*) FROM service_groups)::int AS groups,
            (SELECT count(*) FROM service_items)::int AS items,
            (SELECT count(*) FROM tax_codes)::int AS tax_codes,
            (SELECT count(*) FROM patient_schemes)::int AS categories,
            (SELECT count(*) FROM category_item_rates)::int AS rates,
            (SELECT count(*) FROM category_payment_rules)::int AS payment_rules,
            (SELECT count(*) FROM discount_rules)::int AS discounts,
            (SELECT count(*) FROM discount_rules WHERE method = 'auto' AND is_active)::int AS auto_on,
            (SELECT count(*) FROM doctors)::int AS doctors,
            (SELECT row_to_json(s)::text FROM billing_settings s) AS settings,
            to_regclass('public.bill_line_discounts') IS NOT NULL AS usage_table`,
  );

const runSmoke = (env) =>
  spawnSync("npm", ["run", "-s", "smoke:billing-pricing"], {
    cwd: path.join(repoRoot, "server"),
    env,
    encoding: "utf8",
    timeout: 240_000,
  });

test.describe("P3-24 the pricing smoke script", () => {
  test.setTimeout(300_000);

  test("1. npm run smoke:billing-pricing passes against the test database and leaves nothing", async () => {
    const before = await counts();
    const result = runSmoke(buildTestEnv());
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("localhost:5435/gini_scribe_test");
    expect(result.stdout).toMatch(/ALL OK \((\d+)\/\1\)/);
    expect(result.stdout).not.toContain("✗");
    for (const n of CHECKS) expect(result.stdout).toMatch(new RegExp(`✓ ${n}\\. `));
    for (const reason of [
      "unknown",
      "inactive",
      "role",
      "not_yet_valid",
      "expired",
      "too_many_codes",
      "category",
      "patient",
      "items",
      "doctor",
      "visit_type",
      "total_limit",
      "patient_limit",
      "daily_limit",
      "doctor_daily_limit",
    ]) {
      expect(result.stdout).toContain(`✓ 7. code refused: ${reason}\n`);
    }
    expect(await counts(), "the rolled-back run changed nothing").toEqual(before);
  });

  test("2. it refuses a database that isn't a test database, before connecting", async () => {
    const result = runSmoke({
      ...buildTestEnv(),
      DATABASE_URL: "postgres://user:pass@localhost:5999/gini_live",
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Refused: gini_live is not a test database");
    expect(result.stdout).not.toContain("pass@");
  });
});
