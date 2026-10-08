import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const pharmacy = await import("../../server/services/giniflow/pharmacyStation.js");

const tag = newTag();
let ids;
let waiting;
let done;
let owed;

async function visitAt(label, status) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [made.visit, status]);
  return made;
}

const queue = (q) => pharmacy.getPharmacyQueue(ids.day, new Date(), db, { q });
const names = (rows) => rows.map((row) => row.name);

test.describe.serial("G74 the pharmacy station searches on the server", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    waiting = await visitAt("PhWait", "pharmacy_pending");
    done = await visitAt("PhDone", "dispensed");
    owed = await visitAt("PhOwed", "with_doctor");
    await query(`INSERT INTO medications (patient_id, name, is_active) VALUES ($1, $2, true)`, [
      owed.patient,
      `Metformin ${tag}`,
    ]);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM medications WHERE patient_id = ANY($1)`, [
      [waiting.patient, done.patient, owed.patient],
    ]);
    await tearDown(ids);
  });

  test("1. a name search returns only that patient, while the tiles keep the whole day", async () => {
    const all = await queue(null);
    const found = await queue(`PhWait ${tag}`);
    expect(names(found.toDispense)).toEqual([`P4 PhWait ${tag}`]);
    expect(found.dispensed).toEqual([]);
    expect(found.pendingHandover).toEqual([]);
    expect(found.groupCounts).toEqual({ toDispense: 1, onFloor: 0, dispensed: 0, gone: 0 });
    expect(found.counts).toEqual(all.counts);
    expect(found.q).toBe(`PhWait ${tag}`);
  });

  test("2. file number and HealthRay-prescribed patients are searched too", async () => {
    const byFile = await queue(`F4PhDone-${tag}`);
    expect(names(byFile.dispensed)).toEqual([`P4 PhDone ${tag}`]);
    expect(byFile.toDispense).toEqual([]);

    const prescribed = await queue(`phowed ${tag}`);
    expect(names(prescribed.pendingHandover)).toEqual([`P4 PhOwed ${tag}`]);
    expect(prescribed.groupCounts.onFloor).toBe(1);
  });

  test("3. a one-letter search is ignored", async () => {
    const all = await queue(null);
    const short = await queue("P");
    expect(short.q).toBeNull();
    expect(short.groupCounts).toEqual(all.groupCounts);
  });

  test("4. the station's search box narrows the lists and says when nobody matches", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/giniflow/station/pharmacy", () =>
      page.getByLabel("Search today's pharmacy patients"),
    );
    const box = page.getByLabel("Search today's pharmacy patients");
    await box.fill(`PhWait ${tag}`);
    await expect(page.getByRole("status").filter({ hasText: "1 matching" })).toBeVisible();
    await expect(page.getByText(`P4 PhWait ${tag}`)).toBeVisible();
    await expect(page.getByText(`P4 PhDone ${tag}`)).toHaveCount(0);

    await box.fill(`nobody-${tag}`);
    await expect(page.getByText(`Nobody today matches “nobody-${tag}”.`)).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(box).toHaveValue("");
  });
});
