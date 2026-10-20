import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { LAB_ONLY_DOCTOR } = await import("../../shared/labOnly.js");

const tag = newTag();
let ids;

async function booked(label, doctorName) {
  const made = await extraVisit(ids, label, { healthray: false });
  await query(`UPDATE appointments SET doctor_name = $2 WHERE id = $1`, [
    made.appointment,
    doctorName,
  ]);
  if (doctorName === LAB_ONLY_DOCTOR)
    await query(`UPDATE giniflow_visits SET assigned_doctor_id = NULL WHERE id = $1`, [made.visit]);
  return `P4 ${label} ${tag}`;
}

test.describe.serial("G109 reception Expected list labels lab-only patients", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a lab-only booking shows 'Lab only'; a consultation booking does not", async ({
    page,
  }) => {
    const lab = await booked("LoLab", LAB_ONLY_DOCTOR);
    const consult = await booked("LoConsult", CONSULTANTS.banshali.name);
    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception", () =>
      page.getByRole("tab", { name: /^Arrivals/ }),
    );
    const expected = page.locator(".ar-col").first();
    const rowOf = (name) => expected.locator(".ar-row").filter({ hasText: name });
    await expect(rowOf(lab).getByText("🧪 Lab only")).toBeVisible({ timeout: 20000 });
    await expect(rowOf(consult)).toBeVisible();
    await expect(rowOf(consult).getByText("🧪 Lab only")).toHaveCount(0);
  });
});
