import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { buildVisitPayloadFromDb } = await import("../../server/services/prescriptionAutoSave.js");
const { buildPrescriptionHtml } = await import("../../server/templates/prescriptionTemplate.js");

const tag = newTag();
let ids;
let made;

const addDays = (ymd, days) => {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

const notSunday = (ymd) => (new Date(`${ymd}T00:00:00Z`).getUTCDay() === 0 ? addDays(ymd, 1) : ymd);

const payload = () => buildVisitPayloadFromDb(made.patient, { appointmentId: made.appointment });

test.describe.serial("G121 the prescription prints the next visit set on the floor", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    made = await extraVisit(ids, "RxNext", { healthray: false });
    await query(
      `UPDATE appointments SET status = 'completed', healthray_follow_up = $2::jsonb WHERE id = $1`,
      [made.appointment, JSON.stringify({ date: addDays(ids.day, 30), timing: "1 month" })],
    );
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. with no floor plan, HealthRay's follow-up still prints", async () => {
    const data = await payload();
    expect(data.appt_plan.follow_up.date).toBe(addDays(ids.day, 30));
    expect(data.appt_plan.investigations_to_order).toEqual([]);
  });

  test("2. the care plan's date and the next-visit tests win over HealthRay", async () => {
    const nextVisit = notSunday(addDays(ids.day, 10));
    await query(
      `INSERT INTO giniflow_care_plans (visit_id, next_visit_date, next_visit_interval)
       VALUES ($1, $2::date, '10 days')`,
      [made.visit, nextVisit],
    );
    const order = (
      await query(
        `INSERT INTO giniflow_lab_orders (visit_id, urgency) VALUES ($1, 'next_visit') RETURNING id`,
        [made.visit],
      )
    ).rows[0].id;
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name)
       VALUES ($1, 'HbA1c'), ($1, 'Lipid Profile'), ($1, 'HbA1c')`,
      [order],
    );
    const today = (
      await query(
        `INSERT INTO giniflow_lab_orders (visit_id, urgency) VALUES ($1, 'today') RETURNING id`,
        [made.visit],
      )
    ).rows[0].id;
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name) VALUES ($1, 'CBC')`,
      [today],
    );

    const data = await payload();
    expect(data.appt_plan.follow_up).toMatchObject({ date: nextVisit, timing: "10 days" });
    expect(data.appt_plan.investigations_to_order.map((t) => t.name)).toEqual([
      "HbA1c",
      "Lipid Profile",
    ]);

    const html = buildPrescriptionHtml(data);
    const section = html.slice(html.indexOf("Referrals &amp; tests for next visit"));
    expect(section.length).toBeLessThan(html.length);
    expect(section).toContain("in 10 days");
    expect(section).toContain("HbA1c");
    expect(section).toContain("Lipid Profile");
    expect(section).not.toContain(">CBC<");
  });
});
