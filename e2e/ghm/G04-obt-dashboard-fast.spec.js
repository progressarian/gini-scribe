import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { dayWindowWhere, ownFu } = await import("../../server/services/ghmDayWindow.js");

const TAG = `G04${Date.now().toString(36).toUpperCase()}`;
const DAY = "2031-03-17";
let patient;

const oldWindow = () =>
  dayWindowWhere("a")
    .replace(
      /\(\s*a\.appointment_date = \$1 OR a\.preferred_date = \$1 OR a\.own_follow_up_date = \$1\s*\)\s*AND/,
      "",
    )
    .replace("a.own_follow_up_date = $1", () => `${ownFu("a")} = $1`)
    .replace("prev.own_follow_up_date IS NOT NULL", () => `${ownFu("prev")} IS NOT NULL`);

async function visit(fileNo, fields) {
  const columns = ["patient_id", "patient_name", "file_no", "status", ...Object.keys(fields)];
  const values = [patient, `G04 ${TAG}`, fileNo, "completed", ...Object.values(fields)];
  return await one(
    `INSERT INTO appointments (${columns.join(", ")})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id, own_follow_up_date::text`,
    values,
  );
}

test.describe.serial("G04 the OBT dashboard finds the day's patients through an index", () => {
  test.beforeAll(async () => {
    patient = (
      await one(`INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`, [
        `G04 ${TAG}`,
        `F${TAG}`,
      ])
    ).id;
  });

  test.afterAll(async () => {
    await query(`DELETE FROM appointments WHERE patient_id = $1`, [patient]);
    await query(`DELETE FROM patients WHERE id = $1`, [patient]);
  });

  test("1. every follow-up source is stored on the row, and a bad value never blocks the write", async () => {
    const own = await visit(`A${TAG}`, { appointment_date: "2031-01-01", follow_up_date: DAY });
    const synced = await visit(`B${TAG}`, {
      appointment_date: "2031-01-02",
      biomarkers: JSON.stringify({ followup: DAY }),
    });
    const noted = await visit(`C${TAG}`, {
      appointment_date: "2031-01-03",
      healthray_follow_up: JSON.stringify({ date: DAY }),
    });
    const timed = await visit(`D${TAG}`, {
      appointment_date: "2031-03-03",
      healthray_follow_up: JSON.stringify({ timing: "2 weeks" }),
    });
    const junk = await visit(`E${TAG}`, {
      appointment_date: "2031-01-05",
      biomarkers: JSON.stringify({ followup: "next tuesday" }),
    });
    expect([own, synced, noted, timed].map((row) => row.own_follow_up_date)).toEqual([
      DAY,
      DAY,
      DAY,
      DAY,
    ]);
    expect(junk.own_follow_up_date).toBeNull();
    await query(`UPDATE appointments SET follow_up_date = $2 WHERE id = $1`, [junk.id, DAY]);
    expect(
      (await one(`SELECT own_follow_up_date::text AS d FROM appointments WHERE id = $1`, [junk.id]))
        .d,
    ).toBe(DAY);
  });

  test("2. the stored date matches the original calculation on every appointment", async () => {
    const { mismatched } = await one(
      `SELECT COUNT(*)::int AS mismatched FROM appointments a
        WHERE a.own_follow_up_date IS DISTINCT FROM ${ownFu("a")}
          AND COALESCE(a.biomarkers->>'followup', '') !~ '[a-zA-Z]'`,
    );
    expect(mismatched).toBe(0);
  });

  test("3. the day's list is exactly the same patients as the original rule", async () => {
    const ids = async (where) =>
      (await query(`SELECT a.id FROM appointments a ${where} ORDER BY a.id`, [DAY])).rows.map(
        (row) => row.id,
      );
    const fast = await ids(dayWindowWhere("a"));
    expect(fast.length).toBeGreaterThan(0);
    expect(fast).toEqual(await ids(oldWindow()));
  });

  test("4. the summary and visit-type endpoints load separately and agree with the combined one", async () => {
    const api = await apiAs("admin");
    const [both, summary, types] = await Promise.all(
      ["", "/summary", "/visit-types"].map((part) =>
        api.get(`/api/obt-dashboard${part}`, { params: { date: DAY } }).then((r) => r.json()),
      ),
    );
    await api.dispose();
    expect(summary.summary).toEqual(both.summary);
    expect(types.visitTypes).toEqual(both.visitTypes);
    expect(both.summary.total).toBeGreaterThan(0);
  });

  test("5. the page shows each section as soon as its own figures arrive", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/obt-dashboard", () =>
      page.getByRole("heading", { name: /OBT Dashboard/ }),
    );
    await page.getByLabel("Dashboard date").fill(DAY);
    await expect(page.getByText("Appointments", { exact: true })).toBeVisible();
    await expect(page.getByText("Needs home collection")).toBeVisible();
    await expect(page.getByRole("status", { name: /Loading/ })).toHaveCount(0);
  });
});
