import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { baselineMigrations, migrationFiles } from "./buildSchema.mjs";
import { one, query } from "../helpers/db.mjs";
import { repoRoot } from "./testEnv.mjs";

test.describe("PT-02 schema build", () => {
  test("every repo migration is either replayed or on the skip list", () => {
    const all = fs
      .readdirSync(path.join(repoRoot, "server", "migrations"))
      .filter((name) => name.endsWith(".sql") && !name.startsWith("_"));
    const replayed = migrationFiles().map((file) => path.basename(file));
    const skipped = [...baselineMigrations()];
    for (const name of skipped)
      expect(all, `${name} is on the skip list but missing`).toContain(name);
    expect(new Set([...replayed, ...skipped]).size).toBe(all.length);
    expect(replayed).toEqual([...replayed].sort());
  });

  test("core production tables exist", async () => {
    for (const table of [
      "patients",
      "doctors",
      "appointments",
      "giniflow_visits",
      "giniflow_lab_orders",
      "giniflow_test_catalog",
      "patient_schemes",
      "giniflow_patient_bills",
      "flow_step_catalog",
      "auth_sessions",
    ]) {
      const row = await one(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
      expect(row.t, table).toBe(table);
    }
  });

  test("migrations not yet in production are applied on top of the baseline", async () => {
    const row = await one(
      `SELECT COUNT(*)::int AS n FROM flow_step_catalog WHERE id IN ('lab_billing')`,
    );
    expect(row.n).toBe(1);
  });

  test("reference data survives the reset", async () => {
    const snapshot = await one(`SELECT COUNT(*)::int AS n FROM e2e_reference_snapshot`);
    expect(snapshot.n).toBeGreaterThan(0);
    const { rows } = await query(
      `SELECT table_name, jsonb_array_length(data) AS n FROM e2e_reference_snapshot`,
    );
    for (const { table_name: table, n } of rows) {
      const live = await one(`SELECT COUNT(*)::int AS n FROM ${table}`);
      expect(live.n, table).toBeGreaterThanOrEqual(n);
    }
  });

  test("row level security is on where production has it", async () => {
    const row = await one(
      `SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.giniflow_patient_bills'::regclass`,
    );
    expect(row.on).toBe(true);
  });
});
