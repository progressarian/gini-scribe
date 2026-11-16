import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";
import { USERS } from "../fixtures/data.mjs";

const SLOT = "12:30 PM to 1 PM";

async function appointmentToday(patient) {
  return one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        preferred_time_slot, status, visit_type)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date, $5::text, $5::text, 'scheduled', 'Follow-Up')
     RETURNING id`,
    [patient.id, patient.file_no, patient.name, patient.phone, SLOT],
  );
}

const setSlotAccess = (user, on) =>
  query(`UPDATE doctors SET can_assign_slots = $2 WHERE id = $1`, [user.id, on]);

const ownerOf = async (patientId) =>
  (
    await one(
      `SELECT assigned_to_id FROM obt_call_assignments
        WHERE patient_id = $1 AND work_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
      [patientId],
    )
  )?.assigned_to_id ?? null;

async function openSheet(page, role, patient) {
  await loginAs(page, role);
  await gotoReady(page, "/ghm", () => page.getByRole("button", { name: "Search", exact: true }));
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const searched = page.waitForResponse(
    (r) => r.url().includes("/api/ghm-appointments?") && r.url().includes(`q=${patient.file_no}`),
  );
  await page.getByPlaceholder(/Search this date/).fill(patient.file_no);
  await searched;
  const row = page.locator("tbody tr", { hasText: patient.name }).first();
  await expect(row).toBeVisible();
  return row;
}

const headers = (page) => page.locator("table thead th");

test.describe("G29 GHM: live changes, the last editor takes the row, slots need permission", () => {
  const patients = [];
  const appts = [];

  test.beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const p = await buildPatient();
      patients.push(p);
      appts.push((await appointmentToday(p)).id);
    }
    await setSlotAccess(USERS.obt_two, false);
  });

  test.afterAll(async () => {
    await setSlotAccess(USERS.obt_two, false);
    const ids = patients.map((p) => p.id);
    await query(`DELETE FROM obt_call_assignments WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE patient_id = ANY($1::int[]))`,
      [ids],
    );
    await query(`DELETE FROM call_attempts WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(
      `DELETE FROM call_claim_sessions WHERE appointment_id IN
         (SELECT id FROM appointments WHERE patient_id = ANY($1::int[]))`,
      [ids],
    );
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
  });

  test("1. another person's change appears live with their name, and the row becomes theirs", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const row = await openSheet(page, "obt_two", patients[0]);
    await expect(row.locator(".last-change")).toHaveCount(0);

    const obtOne = await apiAs("obt_one");
    const res = await obtOne.patch(`/api/ghm-appointments/${appts[0]}`, {
      data: { call_notes: "Asked to call back after lunch" },
    });
    expect(res.ok()).toBe(true);

    await expect(row).toContainText("Asked to call back after lunch", { timeout: 8000 });
    const pill = row.locator(".last-change");
    await expect(pill).toContainText(USERS.obt_one.short_name);
    await expect(pill).toHaveAttribute("title", /Last changed by OBT One/);
    expect(await ownerOf(patients[0].id)).toBe(USERS.obt_one.id);

    const notes = row.getByText("Asked to call back after lunch");
    await notes.click();
    const box = row.locator("textarea");
    await box.fill("Will come on Friday");
    await box.blur();
    await expect
      .poll(
        async () =>
          (
            await one(
              `SELECT changed_by_id FROM appointment_change_log
                WHERE appointment_id = $1 AND field = 'call_notes'
                ORDER BY changed_at DESC, id DESC LIMIT 1`,
              [appts[0]],
            )
          )?.changed_by_id,
      )
      .toBe(USERS.obt_two.id);
    await expect(pill).toContainText(USERS.obt_two.short_name, { timeout: 8000 });
    await expect.poll(() => ownerOf(patients[0].id)).toBe(USERS.obt_two.id);
  });

  test("2. the Assigned To column is hidden; without permission Time Slot is read-only", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const obtRow = await openSheet(page, "obt_two", patients[1]);
    const texts = (await headers(page).allInnerTexts()).map((t) => t.trim().toUpperCase());
    expect(texts).not.toContain("ASSIGNED TO");
    expect(texts).toContain("TIME SLOT");
    const slotCell = obtRow.getByRole("button", { name: "Preferred time" });
    await expect(slotCell).toBeDisabled();
    await expect(slotCell).toContainText(SLOT);

    await page.getByRole("button", { name: "New Appointment" }).click();
    const modal = page.locator(".modal");
    await expect(modal).toBeVisible();
    const slotField = modal.getByLabel("Time Slot");
    await expect(slotField).toBeDisabled();
    await expect(slotField).toHaveValue("");
    await modal.getByRole("button", { name: "Close" }).click();

    const receptionRow = await openSheet(page, "reception", patients[1]);
    await expect(receptionRow.getByRole("button", { name: "Preferred time" })).toBeDisabled();

    const adminRow = await openSheet(page, "admin", patients[1]);
    await expect(adminRow.getByRole("button", { name: "Preferred time" })).toBeEnabled();
    const adminTexts = (await headers(page).allInnerTexts()).map((t) => t.trim().toUpperCase());
    expect(adminTexts).not.toContain("ASSIGNED TO");
  });

  test("3. without the permission a booking needs no slot and a slot change is refused", async () => {
    const obtTwo = await apiAs("obt_two");
    const patient = await buildPatient();
    patients.push(patient);
    const tomorrow = (
      await one(`SELECT skip_sunday((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 1)::text AS d`)
    ).d;
    const booked = await obtTwo.post("/api/ghm-appointments", {
      data: {
        patient_name: patient.name,
        file_no: patient.file_no,
        phone: patient.phone,
        doctor_name: "Dr E2E Banshali",
        appointment_date: tomorrow,
        visit_type: "Follow Up",
      },
    });
    expect(booked.status(), await booked.text()).toBe(201);
    expect((await booked.json()).time_slot ?? null).toBeNull();

    const refused = await obtTwo.patch(`/api/ghm-appointments/${appts[1]}`, {
      data: { preferred_time_slot: "10 AM to 11 AM" },
    });
    expect(refused.status()).toBe(403);

    const admin = await apiAs("admin");
    const noSlot = await admin.post("/api/ghm-appointments", {
      data: {
        patient_name: patient.name,
        file_no: patient.file_no,
        phone: patient.phone,
        doctor_name: "Dr E2E Banshali",
        appointment_date: tomorrow,
        visit_type: "Follow Up",
        allow_duplicate: true,
      },
    });
    expect(noSlot.status()).toBe(400);
  });

  test("4. the admin turns slot access on in Slot settings and the column and form field appear", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await loginAs(page, "admin");
    await gotoReady(page, `/settings/slots?doctor=${USERS.obt_two.id}&tab=settings`, () =>
      page.getByLabel("Can assign time slots"),
    );
    const toggle = page.getByLabel("Can assign time slots");
    await expect(toggle).not.toBeChecked();
    await page.goto(`/settings/slots?doctor=${USERS.reception.id}&tab=settings`);
    await expect(page.getByText(USERS.reception.name).first()).toBeVisible();
    await expect(page.getByLabel("Can assign time slots")).not.toBeChecked();
    await page.goto(`/settings/slots?doctor=${USERS.obt_two.id}&tab=settings`);
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect
      .poll(
        async () =>
          (await one(`SELECT can_assign_slots FROM doctors WHERE id = $1`, [USERS.obt_two.id]))
            .can_assign_slots,
      )
      .toBe(true);

    await page.context().clearCookies();
    await openSheet(page, "obt_two", patients[1]);
    const enabledRow = page.locator("tbody tr", { hasText: patients[1].name }).first();
    await expect(enabledRow.getByRole("button", { name: "Preferred time" })).toBeEnabled();
    await page.getByRole("button", { name: "New Appointment" }).click();
    await expect(page.locator(".modal").getByLabel("Time Slot *")).toBeEnabled();

    const obtTwo = await apiAs("obt_two");
    const moved = await obtTwo.patch(`/api/ghm-appointments/${appts[1]}`, {
      data: { preferred_time_slot: "10 AM to 11 AM" },
    });
    expect(moved.ok()).toBe(true);
  });
});
