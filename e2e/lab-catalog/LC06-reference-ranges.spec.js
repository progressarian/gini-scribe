import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { getPool, query } from "../helpers/db.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { LAB_FIELDS, removeLabCatalog, seedLabCatalog } from "../fixtures/labCatalog.mjs";
import { catalogRowsFor } from "../../server/services/giniflow/labCatalog.js";
import { flagFor } from "../../shared/labFormula.js";

const HBA1C = String(LAB_FIELDS.hba1c.id);
const ids = {};

const catalogIdOf = async (name) =>
  (await query(`SELECT id FROM giniflow_test_catalog WHERE test_name = $1`, [name])).rows[0].id;

const hba1cField = async () => {
  const api = await apiAs("admin");
  const body = await (await api.get(`/api/lab-catalog/tests/${ids.hba1c}`)).json();
  return body.report.fields[0];
};

const save = async (ranges, { stamp, role = "admin" } = {}) => {
  const f = await hba1cField();
  const api = await apiAs(role);
  const response = await api.put(`/api/lab-catalog/fields/${HBA1C}/ranges`, {
    data: { expectedUpdatedAt: stamp ?? f.updatedAt, ranges },
  });
  return { status: response.status(), body: await response.json() };
};

const benchRange = async (patient) =>
  (await catalogRowsFor(["HbA1c"], patient, getPool())).get("HbA1c")[0].refRange || null;

const asInput = (r) => ({
  id: r.id,
  gender: r.gender,
  minAgeDays: r.minAgeDays,
  maxAgeDays: r.maxAgeDays,
  min: r.min,
  max: r.max,
  minCritical: r.minCritical,
  maxCritical: r.maxCritical,
  text: r.text,
});

test.describe.serial("LC06 reference ranges", () => {
  test.beforeAll(async () => {
    await seedLabCatalog(query);
    ids.hba1c = await catalogIdOf("HbA1c");
  });
  test.afterAll(async () => {
    await removeLabCatalog(query);
  });

  test("1. the bench never borrows a Male or Female range for an unknown or Other sex", async () => {
    expect(await benchRange({ sex: "Male", ageYears: 40 })).toBe("4 - 6");
    expect(await benchRange({ sex: "Female", ageYears: 40 })).toBe("4.5 - 6.5");
    expect(await benchRange({ sex: "Other", ageYears: 40 })).toBeNull();
    expect(await benchRange({ sex: null, ageYears: 40 })).toBeNull();
  });

  test("2. edit one range in place, add a Both range; unknown sex now gets Both", async () => {
    const before = (await hba1cField()).ranges;
    const female = before.find((r) => r.gender === "Female");
    const male = before.find((r) => r.gender === "Male");
    const result = await save([
      asInput(male),
      { ...asInput(female), min: "4.6" },
      { gender: "Both", minAgeDays: 0, maxAgeDays: 36500, min: 4, max: 6.5 },
    ]);
    expect(result.status).toBe(200);
    const after = (await hba1cField()).ranges;
    expect(after.find((r) => r.gender === "Female")).toMatchObject({ id: female.id, min: 4.6 });
    expect(await benchRange({ sex: "Female", ageYears: 40 })).toBe("4.6 - 6.5");
    expect(await benchRange({ sex: "Other", ageYears: 40 })).toBe("4 - 6.5");
  });

  test("3. an unknown age only gets an all-ages range; a known age gets the narrowest band", async () => {
    const now = (await hba1cField()).ranges.map(asInput);
    const result = await save([
      ...now,
      { gender: "Male", minAgeDays: 0, maxAgeDays: 6570, min: 3, max: 5 },
    ]);
    expect(result.status, JSON.stringify(result.body)).toBe(400);
    expect(result.body.error).toBe(
      "Range 4: Overlaps range 3 for Male in age — narrow one of them",
    );

    const male = now.find((r) => r.gender === "Male");
    const split = await save([
      ...now.filter((r) => r.gender !== "Male"),
      { ...male, minAgeDays: 6570 },
      { gender: "Male", minAgeDays: 0, maxAgeDays: 6570, min: 3, max: 5 },
    ]);
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    expect(await benchRange({ sex: "Male", ageYears: 10 })).toBe("3 - 5");
    expect(await benchRange({ sex: "Male", ageYears: 40 })).toBe("4 - 6");
    expect(await benchRange({ sex: "Male", ageYears: null })).toBe("4 - 6.5");
  });

  test("4. bad ranges are refused with the row and the reason", async () => {
    const cases = [
      [
        { gender: "Both", minAgeDays: 0, maxAgeDays: 36500, min: 7, max: 6 },
        "Low must not be above high",
      ],
      [
        { gender: "Both", minAgeDays: 0, maxAgeDays: 36500, min: 4, max: 6, minCritical: 5 },
        "Critical low must be at or below low",
      ],
      [
        { gender: "Both", minAgeDays: 0, maxAgeDays: 36500 },
        "Enter a low or high limit, or what the report prints",
      ],
      [
        { gender: "Both", minAgeDays: 9000, maxAgeDays: 100, min: 1 },
        "The age “from” must not be after the age “to”",
      ],
    ];
    for (const [range, message] of cases) {
      const result = await save([range]);
      expect(result.status).toBe(400);
      expect(result.body.error).toBe(`Range 1: ${message}`);
    }
  });

  test("5. pregnancy and HealthRay ranges survive a save; a stale save is refused", async () => {
    await query(
      `INSERT INTO lab_test_ranges (test_id, gender, min_value, max_value, is_pregnant, healthray_ref_id, source)
       VALUES ($1, 'Female', 4, 6, TRUE, 9900061, 'healthray')`,
      [HBA1C],
    );
    await query(
      `UPDATE lab_test_ranges SET healthray_ref_id = 9900062
        WHERE test_id = $1 AND gender = 'Female' AND NOT is_pregnant`,
      [HBA1C],
    );
    const stale = (await hba1cField()).updatedAt;
    const now = (await hba1cField()).ranges.filter((r) => !r.pregnant).map(asInput);
    const result = await save(now.map((r) => (r.gender === "Female" ? { ...r, max: 6.4 } : r)));
    expect(result.status).toBe(200);
    const { rows } = await query(
      `SELECT healthray_ref_id::int AS ref, is_pregnant, max_value::float AS max
         FROM lab_test_ranges WHERE test_id = $1 AND healthray_ref_id IS NOT NULL ORDER BY 1`,
      [HBA1C],
    );
    expect(rows).toEqual([
      { ref: 9900061, is_pregnant: true, max: 6 },
      { ref: 9900062, is_pregnant: false, max: 6.4 },
    ]);
    const again = await save(now, { stamp: stale });
    expect(again.status).toBe(409);
  });

  test("6. a man's 7.4 flags H, and every range change is in the history", async () => {
    const rows = (await catalogRowsFor(["HbA1c"], { sex: "Male", ageYears: 40 }, getPool())).get(
      "HbA1c",
    );
    expect(flagFor(7.4, rows[0].range).flag).toBe("H");
    const api = await apiAs("admin");
    const history = await (await api.get(`/api/lab-catalog/tests/${ids.hba1c}/history`)).json();
    const ranges = history.filter((h) => h.entity === "ranges");
    expect(ranges.length).toBe(3);
    expect(ranges[0]).toMatchObject({ action: "replace", actor: "E2E Admin" });
    expect(ranges[0].after.ranges.length).toBeGreaterThan(0);
  });

  test("7. the bench role cannot change ranges", async () => {
    const f = await hba1cField();
    const result = await save(f.ranges.filter((r) => !r.pregnant).map(asInput), { role: "lab" });
    expect(result.status).toBe(403);
  });

  test("8. on screen: add a range, see the problem, fix it and save", async ({ page }) => {
    await loginAs(page, "lab_admin");
    await gotoReady(page, `/settings/tests/${ids.hba1c}`, () =>
      page.getByRole("heading", { level: 2, name: "HbA1c", exact: true }),
    );
    await page.getByRole("button", { name: "Edit ranges of HbA1c" }).click();
    const editor = page.getByRole("form", { name: "Ranges for HbA1c" });
    const count = await editor.getByRole("button", { name: /^Remove range/ }).count();
    await editor.getByRole("button", { name: "+ Add range" }).click();
    const n = count + 1;
    await editor.getByLabel(`Range ${n} sex`).selectOption("Female");
    await editor.getByLabel(`Range ${n} age to`, { exact: true }).fill("12");
    await editor.getByLabel(`Range ${n} low`, { exact: true }).fill("5");
    await editor.getByLabel(`Range ${n} high`, { exact: true }).fill("4");
    await editor.getByRole("button", { name: "Save ranges" }).click();
    await expect(editor.getByText(`Range ${n}: Low must not be above high`)).toBeVisible();
    await expect(editor.getByText(new RegExp(`Range ${n}: Overlaps range`))).toBeVisible();

    await editor.getByLabel(`Range ${n} low`, { exact: true }).fill("3.5");
    await editor.getByLabel(`Range ${n} high`, { exact: true }).fill("5.5");
    const female = (await hba1cField()).ranges.find((r) => r.gender === "Female" && !r.pregnant);
    const femaleIndex =
      (await hba1cField()).ranges.filter((r) => !r.pregnant).findIndex((r) => r.id === female.id) +
      1;
    await editor.getByLabel(`Range ${femaleIndex} age from`, { exact: true }).fill("12");
    await editor.getByRole("button", { name: "Save ranges" }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole("row", { name: /^1 HbA1c/ })).toContainText("Up to 12 y");
    expect(await benchRange({ sex: "Female", ageYears: 8 })).toBe("3.5 - 5.5");
  });
});
