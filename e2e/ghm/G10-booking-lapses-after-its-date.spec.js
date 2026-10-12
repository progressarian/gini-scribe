import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

async function oldVisitMarkedBooked(patient, preferredOffset) {
  return one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, status,
        visit_type, booking_status, preferred_date, preferred_time_slot)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 100, 'no_show', 'OPD', 'booked',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date + $5::int, '11 AM to 12 PM')
     RETURNING id, preferred_date::text AS preferred_date`,
    [patient.id, patient.file_no, patient.name, patient.phone, preferredOffset],
  );
}

const cleanup = async (patient) => {
  await query(
    `DELETE FROM appointment_change_log WHERE appointment_id IN
       (SELECT id FROM appointments WHERE file_no = $1)`,
    [patient.file_no],
  );
  await query(`DELETE FROM appointments WHERE file_no = $1`, [patient.file_no]);
  await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
};

async function lookup(api, patient) {
  const res = await api.get(
    `/api/ghm-appointments?mode=lookup&q=${encodeURIComponent(patient.file_no)}&page=1&limit=20`,
  );
  const body = await res.json();
  expect(res.status(), JSON.stringify(body)).toBe(200);
  return body.data.find((row) => row.file_no === patient.file_no);
}

test.describe("GHM: a booking stops counting once its date has passed", () => {
  let patient;
  let api;

  test.beforeEach(async () => {
    patient = await buildPatient();
    api = await apiAs("reception_admin");
  });

  test.afterEach(async () => {
    await api.dispose();
    await cleanup(patient);
  });

  test("1. marked booked for a date that has passed, with nothing newer, shows as lapsed", async () => {
    const visit = await oldVisitMarkedBooked(patient, -9);
    const row = await lookup(api, patient);
    expect(row.is_booked).toBe(false);
    expect(row.booking_lapsed).toBe(true);
    expect(row.booked_for_date).toBe(visit.preferred_date);
  });

  test("2. marked booked for a date still ahead stays booked", async () => {
    await oldVisitMarkedBooked(patient, 5);
    const row = await lookup(api, patient);
    expect(row.is_booked).toBe(true);
    expect(row.booking_lapsed).toBe(false);
  });
});
