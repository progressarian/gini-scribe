import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

async function appointment(patient, { daysAgo, doctor, status }) {
  await query(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type)
     VALUES ($1, $2, $3, $4, $5, (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $6::int,
             '12:30 PM to 1 PM', $7, 'Follow-Up')`,
    [patient.id, patient.file_no, patient.name, patient.phone, doctor, daysAgo, status],
  );
}

test.describe("GHM: Last Visit is the latest visit the patient came to, with who saw them", () => {
  let patient;
  let admin;

  test.beforeAll(async () => {
    patient = await buildPatient();
    await appointment(patient, { daysAgo: 30, doctor: "Dr E2E Came", status: "seen" });
    await appointment(patient, { daysAgo: 0, doctor: "Dr E2E Booked Today", status: "no_show" });
    await appointment(patient, { daysAgo: -7, doctor: "Dr E2E Next Week", status: "scheduled" });
    admin = await apiAs("admin");
  });

  test.afterAll(async () => {
    await query(`DELETE FROM appointments WHERE patient_id = $1`, [patient.id]);
    await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
  });

  test("1. a no-show today or a future booking is not the last visit", async () => {
    const res = await admin.post("/api/ghm-appointments/last-visit", {
      data: { patient_ids: [patient.id] },
    });
    expect(res.status()).toBe(200);
    const visit = (await res.json())[patient.id];
    const expected = (
      await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 30)::text AS d`)
    ).d;
    expect(visit.date).toBe(expected);
    expect(visit.doctor).toBe("Dr E2E Came");
    expect(visit.mo).toBeNull();
  });

  test("2. a tests-only visit after it is a note, not the last visit", async () => {
    await query(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
          status, visit_type)
       VALUES ($1, $2, $3, $4, 'Dr. Hospital Admin',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 2, '09:00', 'seen', 'Investigation')`,
      [patient.id, patient.file_no, patient.name, patient.phone],
    );
    const res = await admin.post("/api/ghm-appointments/last-visit", {
      data: { patient_ids: [patient.id] },
    });
    const visit = (await res.json())[patient.id];
    const days = await one(
      `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 30)::text AS consult,
              ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 2)::text AS tests`,
    );
    expect(visit.date).toBe(days.consult);
    expect(visit.doctor).toBe("Dr E2E Came");
    expect(visit.testsDate).toBe(days.tests);
  });
});
