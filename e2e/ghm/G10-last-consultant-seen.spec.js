import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { query } from "../helpers/db.mjs";
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

test.describe("GHM: Last Consultant Seen counts only visits the patient came to", () => {
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

  test("1. a no-show today or a future booking is not shown as seen", async () => {
    const res = await admin.post("/api/ghm-appointments/last-mo", {
      data: { patient_ids: [patient.id] },
    });
    expect(res.status()).toBe(200);
    const seen = (await res.json())[patient.id];
    expect(seen.name).toBe("Dr E2E Came");
    expect(seen.kind).toBe("doctor");
  });
});
