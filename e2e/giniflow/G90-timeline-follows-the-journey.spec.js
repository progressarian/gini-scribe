import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
let ids;

const CHIEF_JOURNEY = [
  ["wait_chief", "Wait for Chief", "ready_for_doctor"],
  ["mo_assessment", "Chief Endocrinologist Assessment", "with_sd"],
  ["rx_explain", "Prescription Explain", "with_rx"],
  ["pharmacy", "Pharmacy / Exit", "dispensed"],
];
const CONSULTANT_JOURNEY = [
  ["mo_assessment", "Chief Endocrinologist Assessment", "with_sd"],
  ["sd_consult", "SD Consultation", "with_doctor"],
  ["rx_explain", "Prescription Explain", "with_rx"],
  ["pharmacy", "Pharmacy / Exit", "dispensed"],
];

async function withChief(label, doctor, steps) {
  const { visit } = await extraVisit(ids, label, { doctorId: doctor.id });
  await query(`DELETE FROM giniflow_visit_steps WHERE visit_id = $1`, [visit]);
  for (const [i, [id, name, stop]] of steps.entries()) {
    await query(
      `INSERT INTO giniflow_visit_steps (visit_id, step_order, step_catalog_id, step_name,
                                         chain_status, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [visit, i + 1, id, name, stop, stop === "with_sd" ? "in_progress" : "pending"],
    );
  }
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'checked_in', 'reception', NOW() - interval '40 minutes'),
            ($1, 'with_sd', 'mo', NOW() - interval '10 minutes')`,
    [visit],
  );
  await query(`UPDATE giniflow_visits SET current_status = 'with_sd' WHERE id = $1`, [visit]);
  return visit;
}

async function stillToCome(page, visit) {
  await gotoReady(page, "/giniflow/manager", () => page.locator(`[data-card-id="${visit}"]`));
  await page.locator(`[data-card-id="${visit}"] .pc-open`).click();
  const box = page.locator(".tbox").filter({ has: page.locator(".tb-name") });
  await expect(box.locator(".ts-name.dim").first()).toBeVisible();
  return box.locator(".ts-name.dim").allInnerTexts();
}

test.describe.serial("G90 the visit timeline follows the patient's own journey", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a test cancelled because it is not on the HealthRay bill is left off the timeline", async () => {
    const { visit } = await extraVisit(ids, "Cancels", { healthray: false });
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at, meta)
       VALUES ($1, 'checked_in', 'reception', NOW() - interval '30 minutes', '{}'::jsonb),
              ($1, 'test_cancelled', 'system', NOW() - interval '29 minutes',
               '{"tests":["ABI"],"reason":"not_on_bill"}'::jsonb),
              ($1, 'test_cancelled', 'system', NOW() - interval '28 minutes',
               '{"reason":"not_on_bill"}'::jsonb),
              ($1, 'test_cancelled', 'lab', NOW() - interval '20 minutes',
               '{"tests":["Fundus"],"reason":"patient_declined"}'::jsonb)`,
      [visit],
    );
    const api = await apiAs("admin");
    try {
      const res = await api.get(`/api/giniflow/visits/${visit}/timeline`);
      expect(res.status()).toBe(200);
      const cancels = (await res.json()).steps
        .map((s) => s.label || "")
        .filter((l) => l.startsWith("Test cancelled"));
      expect(cancels).toEqual(["Test cancelled — Fundus · Patient declined"]);
    } finally {
      await api.dispose();
    }
  });

  test("2. Dr Banshali's patient is not shown a consultant still to come", async ({ page }) => {
    const visit = await withChief("ChiefOnly", CONSULTANTS.banshali, CHIEF_JOURNEY);
    await loginAs(page, "admin");
    const toCome = await stillToCome(page, visit);
    expect(toCome).not.toContain("With consultant");
    expect(toCome).toContain("Prescription being explained");
  });

  test("3. a patient whose journey has a consultant still sees that step to come", async ({
    page,
  }) => {
    const visit = await withChief("WithConsultant", CONSULTANTS.beant, CONSULTANT_JOURNEY);
    await loginAs(page, "admin");
    expect(await stillToCome(page, visit)).toContain("With consultant");
  });
});
