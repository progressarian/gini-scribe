import { test, expect } from "@playwright/test";
import { loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";
import { USERS } from "../fixtures/data.mjs";

async function bookingWithPreferred(patient, setBy) {
  const appt = await one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type, preferred_date)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date, '12:30 PM to 1 PM', 'scheduled',
             'Follow-Up', (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 5)
     RETURNING id, preferred_date::text AS preferred_date`,
    [patient.id, patient.file_no, patient.name, patient.phone],
  );
  await query(
    `INSERT INTO appointment_change_log
       (appointment_id, field, field_label, old_value, new_value, changed_by, changed_by_id)
     VALUES ($1, 'preferred_date', 'Preferred Date', NULL, $2, $3, $4)`,
    [appt.id, appt.preferred_date, setBy.short_name, setBy.id],
  );
  return appt;
}

const preferredOf = async (id) =>
  (await one(`SELECT preferred_date::text AS d FROM appointments WHERE id = $1`, [id])).d;

test.describe("G21 changing a preferred date someone else set asks first", () => {
  let byOther, byMe;
  let otherAppt, myAppt;

  test.beforeAll(async () => {
    byOther = await buildPatient();
    byMe = await buildPatient();
    otherAppt = await bookingWithPreferred(byOther, USERS.reception);
    myAppt = await bookingWithPreferred(byMe, USERS.admin);
  });

  test.afterAll(async () => {
    const ids = [otherAppt.id, myAppt.id];
    await query(`DELETE FROM appointment_change_log WHERE appointment_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [[byOther.id, byMe.id]]);
  });

  const openRow = async (page, patient) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/ghm", () => page.getByRole("button", { name: "Search", exact: true }));
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByPlaceholder(/Search this date/).fill(patient.file_no);
    const row = page.locator("tr", { hasText: patient.name });
    await expect(row).toBeVisible();
    return row;
  };

  test("1. someone else's date: the warning names them, and Keep changes nothing", async ({
    page,
  }) => {
    const row = await openRow(page, byOther);
    await row.getByRole("button", { name: "Clear date" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Change the preferred date someone else set?");
    await expect(dialog).toContainText(byOther.name);
    await expect(dialog).toContainText(`${USERS.reception.short_name} set the preferred date`);
    await dialog.getByRole("button", { name: /^Keep / }).click();
    await expect(dialog).toBeHidden();
    expect(await preferredOf(otherAppt.id)).toBe(otherAppt.preferred_date);

    await row.getByRole("button", { name: "Clear date" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove preferred date" }).click();
    await expect.poll(() => preferredOf(otherAppt.id)).toBeNull();
  });

  test("2. a date you set yourself changes without a warning", async ({ page }) => {
    const row = await openRow(page, byMe);
    await row.getByRole("button", { name: "Clear date" }).click();
    await expect.poll(() => preferredOf(myAppt.id)).toBeNull();
    await expect(page.getByRole("dialog")).toBeHidden();
  });
});
