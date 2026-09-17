import { test, expect } from "@playwright/test";
import { GuardError, TEST_DATABASE_URL, assertTestDatabase, isTestDatabaseUrl } from "./guard.mjs";
import { buildTestEnv } from "./testEnv.mjs";
import { getPool } from "../helpers/db.mjs";

const refused = [
  "postgresql://postgres.abc:secret@aws-1-ap-south-1.pooler.supabase.com:6543/postgres",
  "postgres://user:pass@localhost:5432/gini_scribe_test",
  "postgres://user:pass@localhost:5435/gini_scribe",
  "postgres://user:pass@10.0.0.5:5435/gini_scribe_test",
  "postgres://user:pass@localhost:5435/gini_scribe_test?host=db.prod.example.com",
  "mysql://user:pass@localhost:5435/gini_scribe_test",
  "not a url",
  "",
  undefined,
];

test.describe("PT-03 production guard", () => {
  test("accepts only the local test database", () => {
    expect(isTestDatabaseUrl(TEST_DATABASE_URL)).toBe(true);
    expect(isTestDatabaseUrl("postgres://user:pass@127.0.0.1:5435/gini_scribe_test")).toBe(true);
    expect(assertTestDatabase(TEST_DATABASE_URL)).toBe(TEST_DATABASE_URL);
  });

  refused.forEach((url, index) => {
    test(`refuses case ${index + 1}: ${url === undefined ? "missing URL" : JSON.stringify(url)}`, () => {
      expect(isTestDatabaseUrl(url)).toBe(false);
      expect(() => assertTestDatabase(url)).toThrow(GuardError);
      expect(() => assertTestDatabase(url)).toThrow(
        "E2E refused: DATABASE_URL is not the local test database",
      );
    });
  });

  test("the db helper refuses before connecting", () => {
    expect(() => getPool(refused[0])).toThrow(GuardError);
  });

  test("the test environment refuses a production DATABASE_URL override", () => {
    expect(() => buildTestEnv({ DATABASE_URL: refused[0] })).toThrow(GuardError);
  });

  test("the test environment blanks every key from the production .env", () => {
    const env = buildTestEnv();
    expect(env.DATABASE_URL).toBe(TEST_DATABASE_URL);
    for (const key of [
      "HEALTHRAY_PASSWORD",
      "LAB_HEALTHRAY_PASSWORD",
      "SUPABASE_SERVICE_KEY",
      "GENIE_SUPABASE_SERVICE_KEY",
      "ANTHROPIC_API_KEY",
      "DEEPGRAM_API_KEY",
      "OPENAI_API_KEY",
    ]) {
      expect(env[key] ?? "", key).toBe("");
    }
    expect(env.RUN_CRON_IN_API).toBeUndefined();
    expect(env.GINIFLOW_SYNC_DISABLED).toBe("1");
  });
});
