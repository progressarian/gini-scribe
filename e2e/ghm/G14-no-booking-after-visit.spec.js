import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const today = async () =>
  (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`)).d;

async function todaysVisit(patient, { doctor, status }) {
  await query(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type)
     VALUES ($1, $2, $3, $4, $5, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, '08:10', $6,
             'Follow-Up')`,
    [patient.id, patient.file_no, patient.name, patient.phone, doctor, status],
  );
}

test.describe("GHM: no second booking for a patient already in the hospital today", () => {
  let patients;
  let api;

  test.beforeAll(async () => {
    patients = [await buildPatient(), await buildPatient()];
    api = await apiAs("admin");
  });

  test.afterAll(async () => {
    const ids = patients.map((p) => p.id);
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE patient_id = ANY($1::int[]))`,
      [ids],
    );
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
  });

  const book = async (patient, extra = {}) =>
    api.post("/api/ghm-appointments", {
      data: {
        patient_name: patient.name,
        file_no: patient.file_no,
        phone: patient.phone,
        doctor_name: "Dr E2E Banshali",
        appointment_date: await today(),
        time_slot: "4:30 PM to 5 PM",
        visit_type: "Follow Up",
        ...extra,
      },
    });

  test("1. a patient checked in today cannot be booked again, even with Book anyway", async () => {
    await todaysVisit(patients[0], { doctor: "Dr E2E Banshali", status: "checkedin" });
    const res = await book(patients[0], { allow_duplicate: true });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("already_visited");
    expect(body.detail.status).toBe("checkedin");
  });

  test("2. a tests-only visit today does not block booking a consultation", async () => {
    await todaysVisit(patients[1], { doctor: "Dr. Hospital Admin", status: "checkedin" });
    const res = await book(patients[1], { allow_duplicate: true });
    expect((await res.json()).error).not.toBe("already_visited");
    expect(res.ok()).toBeTruthy();
  });
});
