import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { CONSULTANTS } from "../fixtures/data.mjs";
import { gotoReady } from "../helpers/browser.mjs";

const doctor = CONSULTANTS.beant;
const istDay = async (offset) =>
  (
    await one(
      `SELECT skip_sunday((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`,
      [offset],
    )
  ).d;

test.describe
  .serial("G27 Reassign Needed lists every upcoming patient, with no date picked", () => {
  let soon;
  let later;
  let past;

  const cleanUp = async () => {
    await query(`DELETE FROM doctor_unavailability WHERE doctor_id = $1 AND reason LIKE 'G27%'`, [
      doctor.id,
    ]);
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE file_no LIKE 'G27-%')`,
    );
    await query(`DELETE FROM appointment_reassignments WHERE file_no LIKE 'G27-%'`);
    await query(`DELETE FROM appointments WHERE file_no LIKE 'G27-%'`);
  };

  test.beforeAll(async () => {
    await cleanUp();
    soon = await istDay(3);
    later = await istDay(20);
    past = (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 3)::text AS d`)).d;
    for (const [day, reason] of [
      [soon, "G27 conference"],
      [later, "G27 family"],
      [past, "G27 old leave"],
    ])
      await query(
        `INSERT INTO doctor_unavailability (doctor_id, doctor_name, type, start_date, end_date, reason, status)
         VALUES ($1, $2, 'leave', $3, $3, $4, 'active')`,
        [doctor.id, doctor.name, day, reason],
      );
    await query(
      `INSERT INTO appointments (patient_name, file_no, doctor_name, appointment_date, time_slot, status)
       VALUES ('G27 Soon patient', 'G27-1', $1, $2, '10 AM to 10:30 AM', 'booked'),
              ('G27 Later patient', 'G27-2', $1, $3, '11 AM to 11:30 AM', 'booked'),
              ('G27 Past patient', 'G27-3', $1, $4, '10 AM to 10:30 AM', 'booked')`,
      [doctor.name, soon, later, past],
    );
    await query(
      `INSERT INTO appointments (patient_name, file_no, doctor_name, appointment_date, status,
                                 preferred_date, preferred_time_slot, preferred_doctor)
       VALUES ('G27 Plan patient', 'G27-4', $1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
               'scheduled', $2, '12 PM to 12:30 PM', $3)`,
      [doctor.name, later, doctor.name],
    );
  });
  test.afterAll(cleanUp);

  test("1. with no date the API returns every conflict from today onwards", async () => {
    const api = await apiAs("admin");
    const body = await (await api.get(`/api/appointments/conflicts`)).json();
    const mine = body.conflicts.filter((c) => c.file_no?.startsWith("G27-"));
    expect(mine.map((c) => [c.file_no, c.plan, c.appointment_date, c.reason])).toEqual([
      ["G27-1", "booking", soon, "leave"],
      ["G27-2", "booking", later, "leave"],
      ["G27-4", "preferred", later, "leave"],
    ]);
    expect(body.to).toBeNull();
    const oneDay = await (await api.get(`/api/appointments/conflicts?date=${soon}`)).json();
    expect(oneDay.conflicts.filter((c) => c.file_no?.startsWith("G27-")).length).toBe(1);
    await api.dispose();
  });

  test("2. the tab shows both upcoming patients without choosing a date, and search narrows it", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/ghm?tab=reassign", () =>
      page.getByText(/from today onwards whose doctor is now/),
    );
    await expect(page.getByRole("button", { name: /Filters/ })).toHaveCount(0);
    const table = page.getByRole("table");
    await expect(table.getByRole("row", { name: /G27 Soon patient/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /G27 Later patient/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /G27 Past patient/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .getByPlaceholder("Search by patient name, file no, phone or doctor")
      .fill("G27 later");
    await expect(table.getByRole("row", { name: /G27 Later patient/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /G27 Soon patient/ })).toHaveCount(0);
    await expect(page.getByText(/1 patient across 1 day/)).toBeVisible();

    await page
      .getByPlaceholder("Search by patient name, file no, phone or doctor")
      .fill("G27 plan");
    await expect(
      table.getByRole("row", { name: /G27 Plan patient/ }).getByText("Preferred plan"),
    ).toBeVisible();
  });

  test("3. reassigning a preferred plan changes the preferred doctor only, and logs it", async () => {
    const plan = await one(
      `SELECT id, appointment_date::text AS d FROM appointments WHERE file_no = 'G27-4'`,
    );
    const api = await apiAs("admin");
    const other = CONSULTANTS.rahul;
    const r = await api.put(`/api/appointments/${plan.id}/reassign`, {
      data: {
        to_doctor_id: other.id,
        to_doctor_name: other.name,
        reason: "G27 test",
        trigger: "manual",
        plan: "preferred",
      },
    });
    expect(r.status()).toBe(200);
    expect((await r.json()).plan).toBe("preferred");
    const after = await one(
      `SELECT doctor_name, appointment_date::text AS d, preferred_doctor FROM appointments WHERE id = $1`,
      [plan.id],
    );
    expect(after).toEqual({ doctor_name: doctor.name, d: plan.d, preferred_doctor: other.name });
    const log = await one(
      `SELECT old_value, new_value FROM appointment_change_log
        WHERE appointment_id = $1 AND field = 'preferred_doctor' ORDER BY changed_at DESC LIMIT 1`,
      [plan.id],
    );
    expect(log).toEqual({ old_value: doctor.name, new_value: other.name });
    const moved = await one(
      `SELECT from_doctor_name, to_doctor_name, appointment_date::text AS d FROM appointment_reassignments
        WHERE appointment_id = $1`,
      [plan.id],
    );
    expect(moved).toEqual({ from_doctor_name: doctor.name, to_doctor_name: other.name, d: later });
    const body = await (await api.get(`/api/appointments/conflicts`)).json();
    expect(body.conflicts.some((c) => c.file_no === "G27-4")).toBe(false);
    await api.dispose();
  });
});
