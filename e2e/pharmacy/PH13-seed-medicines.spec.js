import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { TEST_DATABASE_URL, assertTestDatabase } from "../setup/guard.mjs";

assertTestDatabase(TEST_DATABASE_URL);

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "..", "..", "server", "scripts", "pharmacy-seed-medicines.mjs");
const TAG = `PH13${Date.now().toString(36).toUpperCase()}`;
const item = (n) => `${TAG} ${n}`;

function seed(...flags) {
  const result = spawnSync(process.execPath, [SCRIPT, ...flags], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    encoding: "utf8",
    timeout: 120000,
  });
  return { code: result.status, out: `${result.stdout}\n${result.stderr}` };
}

const tagged = () =>
  query(
    `SELECT name, form, unit_label, manufacturer, generic_name, medicine_key, needs_review, pack_size
       FROM pharmacy_medicines WHERE name LIKE $1 ORDER BY name`,
    [`${TAG}%`],
  ).then((r) => r.rows);

test.describe.configure({ mode: "serial" });

test.describe("PH13 seed the medicine master from DARPAN stock", () => {
  test.beforeAll(async () => {
    await query(
      `INSERT INTO pharmacy_stock_items (item_key, item_name, qty, company, generic_name, item_type)
       VALUES ($1, $1, 40, 'Sun Pharma', 'Atorvastatin 10 mg', 'TAB'),
              ($2, $2, 12, 'Cipla', 'NA', 'CAP'),
              ($3, $3, 5, NULL, NULL, NULL)`,
      [item("ATORVA 10 TAB"), item("OMEZ 20 CAP"), item("ALREADY THERE")],
    );
    await query(
      `INSERT INTO pharmacy_stock_links (item_key, medicine_key, status)
       VALUES ($1, 'ATORVA 10', 'confirmed')`,
      [item("ATORVA 10 TAB")],
    );
    await query(
      `INSERT INTO pharmacy_medicines (name, form, medicine_key, gst_rate_pct, pack_size)
       VALUES ($1, 'TAB', 'ALREADY THERE', 12, 10)`,
      [item("ALREADY THERE")],
    );
  });

  test.afterAll(async () => {
    await query(`DELETE FROM pharmacy_stock_items WHERE item_key LIKE $1`, [`${TAG}%`]);
    await query(`DELETE FROM pharmacy_medicines WHERE name LIKE $1`, [`${TAG}%`]);
  });

  test("a dry run reports counts and saves nothing", async () => {
    const { code, out } = seed();
    expect(code, out).toBe(0);
    expect(out).toMatch(/To add: \d+/);
    expect(out).toContain("Nothing was saved");
    expect((await tagged()).map((m) => m.name)).toEqual([item("ALREADY THERE")]);
  });

  test("--apply adds stock items flagged for review and keeps existing rows", async () => {
    const { code, out } = seed("--apply", "--batch=100");
    expect(code, out).toBe(0);
    expect(out).toMatch(/Batch 1: /);

    const rows = await tagged();
    expect(rows).toEqual([
      {
        name: item("ALREADY THERE"),
        form: "TAB",
        unit_label: "unit",
        manufacturer: null,
        generic_name: null,
        medicine_key: "ALREADY THERE",
        needs_review: false,
        pack_size: 10,
      },
      {
        name: item("ATORVA 10 TAB"),
        form: "TAB",
        unit_label: "tab",
        manufacturer: "Sun Pharma",
        generic_name: "Atorvastatin 10 mg",
        medicine_key: "ATORVA 10",
        needs_review: true,
        pack_size: 1,
      },
      {
        name: item("OMEZ 20 CAP"),
        form: "CAP",
        unit_label: "cap",
        manufacturer: "Cipla",
        generic_name: null,
        medicine_key: item("OMEZ 20 CAP").toUpperCase(),
        needs_review: true,
        pack_size: 1,
      },
    ]);

    const audit = await one(
      `SELECT count(*)::int AS n FROM billing_audit a
         JOIN pharmacy_medicines m ON a.entity_id = m.id::text
        WHERE a.entity = 'pharmacy_medicines' AND a.action = 'import' AND m.name LIKE $1`,
      [`${TAG}%`],
    );
    expect(audit.n).toBe(2);
  });

  test("running it again adds nothing twice", async () => {
    const { code, out } = seed("--apply");
    expect(code, out).toBe(0);
    expect(await tagged()).toHaveLength(3);
  });

  test("saving a seeded medicine clears the review flag", async () => {
    const admin = await apiAs("pharmacy_admin");
    const row = await one(`SELECT * FROM pharmacy_medicines WHERE name = $1`, [
      item("OMEZ 20 CAP"),
    ]);
    const response = await admin.put(`/api/pharmacy/medicines/${row.id}`, {
      data: {
        code: row.code,
        name: row.name,
        form: "CAP",
        pack_size: 15,
        unit_label: "cap",
        pack_label: "strip",
        gst_rate_pct: 12,
        hsn_code: "3004",
        version: row.version,
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    expect((await response.json()).needs_review).toBe(false);

    const review = await (
      await admin.get("/api/pharmacy/medicines", { params: { q: TAG, review: true } })
    ).json();
    expect(review.rows.map((m) => m.name)).toEqual([item("ATORVA 10 TAB")]);
    await admin.dispose();
  });
});
