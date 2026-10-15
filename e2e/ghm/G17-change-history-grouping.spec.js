import { test, expect } from "@playwright/test";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const IST = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

test.describe("GHM: change history groups one action and pages older lines", () => {
  let patient;
  let apptId;

  test.beforeAll(async () => {
    patient = await buildPatient();
    ({ id: apptId } = await one(
      `INSERT INTO appointments (patient_id, file_no, patient_name, phone, doctor_name, time_slot,
                                 status, visit_type, appointment_date, created_at)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', '10:00', 'no_show', 'Follow-Up', ${IST} - 2,
               ((${IST} - 4)::timestamp AT TIME ZONE 'Asia/Kolkata'))
       RETURNING id`,
      [patient.id, patient.file_no, patient.name, patient.phone],
    ));
    const log = (field, label, oldV, newV, by, minutesAgo) =>
      query(
        `INSERT INTO appointment_change_log
           (appointment_id, field, field_label, old_value, new_value, changed_by, changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() - make_interval(mins => $7))`,
        [apptId, field, label, oldV, newV, by, minutesAgo],
      );
    await log("preferred_doctor", "Preferred Doctor", null, "Dr. Anil Bhansali", "Jaspreet", 10);
    await log("preferred_date", "Preferred Date", null, "2026-12-01", "Jaspreet", 10);
    await log("preferred_time_slot", "Preferred Time", null, "5 PM to 6 PM", "Jaspreet", 9);
    for (let i = 1; i <= 11; i++)
      await log("call_status", "Call Status", "pending", `attempt ${i}`, "Nancy", 60 * i);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM appointment_change_log WHERE appointment_id = $1`, [apptId]);
    await query(`DELETE FROM appointments WHERE id = $1`, [apptId]);
    await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
  });

  test("one booking reads as one line, and older lines wait behind Show older", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/ghm?tab=missed", () =>
      page.getByRole("group", { name: "Missed date range" }),
    );
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByPlaceholder(/Search missed patients/).fill(patient.file_no);
    const patientRow = page.locator("tr", { hasText: patient.name }).first();
    await patientRow.getByRole("button", { name: "Show call history" }).click();

    const history = page.locator(".chg-section", { hasText: "Change History" });
    const booking = history.locator(".hist-item", { hasText: "Jaspreet" });
    await expect(booking).toHaveCount(1);
    await expect(booking).toContainText("Dr. Anil Bhansali");
    await expect(booking).toContainText("2026-12-01");
    await expect(booking).toContainText("5 PM to 6 PM");
    await expect(booking.getByRole("button", { name: /Delete this .* change/ })).toHaveCount(3);

    await expect(history.locator(".hist-item")).toHaveCount(10);
    await expect(history.getByText("attempt 11")).toHaveCount(0);
    await history.getByRole("button", { name: /Show older \(\d+\)/ }).click();
    await expect(history.getByText("attempt 11")).toBeVisible();
    await expect(history.getByRole("button", { name: "Show fewer" })).toBeVisible();
  });
});
