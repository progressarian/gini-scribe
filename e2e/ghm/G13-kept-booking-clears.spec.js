import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

async function bookedVisit(patient, preferredOffset = null) {
  return one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type, booking_status, preferred_date, preferred_time_slot)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
             '10:50', 'scheduled', 'New Patient', 'booked',
             CASE WHEN $5::int IS NULL THEN NULL
                  ELSE (NOW() AT TIME ZONE 'Asia/Kolkata')::date + $5::int END,
             CASE WHEN $5::int IS NULL THEN NULL ELSE '11 AM to 12 PM' END)
     RETURNING id`,
    [patient.id, patient.file_no, patient.name, patient.phone, preferredOffset],
  );
}

test.describe("GHM: a booked visit that is completed clears its booking", () => {
  let patient;

  test.beforeAll(async () => {
    patient = await buildPatient();
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE patient_id = $1)`,
      [patient.id],
    );
    await query(`DELETE FROM appointments WHERE patient_id = $1`, [patient.id]);
    await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
  });

  test("1. completing the visit clears Booked and logs it", async () => {
    const { id } = await bookedVisit(patient);
    await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [id]);
    const row = await one(`SELECT booking_status FROM appointments WHERE id = $1`, [id]);
    expect(row.booking_status).toBeNull();
    const log = await one(
      `SELECT old_value, new_value, changed_by FROM appointment_change_log
        WHERE appointment_id = $1 AND field = 'booking_status'`,
      [id],
    );
    expect(log).toEqual({ old_value: "booked", new_value: null, changed_by: "Visit completed" });
  });

  test("2. a next visit already booked by preferred date and time is kept", async () => {
    const { id } = await bookedVisit(patient, 14);
    await query(`UPDATE appointments SET status = 'seen' WHERE id = $1`, [id]);
    const row = await one(
      `SELECT booking_status, preferred_time_slot FROM appointments WHERE id = $1`,
      [id],
    );
    expect(row.booking_status).toBe("booked");
    expect(row.preferred_time_slot).toBe("11 AM to 12 PM");
  });

  test("3. coming on a separate appointment clears the old row booked for that date", async () => {
    const other = await buildPatient();
    try {
      const old = await one(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type, booking_status, preferred_date, preferred_time_slot)
         VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
                 (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 30, '10:00', 'completed', 'Follow-Up',
                 'booked', (NOW() AT TIME ZONE 'Asia/Kolkata')::date, '11 AM to 12 PM')
         RETURNING id`,
        [other.id, other.file_no, other.name, other.phone],
      );
      const later = await one(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type, preferred_date, booking_status)
         VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
                 '11:15', 'scheduled', 'Follow-Up',
                 (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 60, 'booked')
         RETURNING id`,
        [other.id, other.file_no, other.name, other.phone],
      );
      const lab = await one(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type)
         VALUES ($1, $2, $3, $4, 'Dr. Hospital Admin',
                 (NOW() AT TIME ZONE 'Asia/Kolkata')::date + 1, '09:00', 'scheduled',
                 'Investigation')
         RETURNING id`,
        [other.id, other.file_no, other.name, other.phone],
      );

      await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [lab.id]);
      expect(
        (await one(`SELECT booking_status FROM appointments WHERE id = $1`, [old.id]))
          .booking_status,
      ).toBe("booked");

      await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [later.id]);
      const oldRow = await one(
        `SELECT booking_status, preferred_date FROM appointments WHERE id = $1`,
        [old.id],
      );
      expect(oldRow).toEqual({ booking_status: null, preferred_date: null });
      expect(
        (await one(`SELECT booking_status FROM appointments WHERE id = $1`, [later.id]))
          .booking_status,
      ).toBe("booked");
    } finally {
      await query(
        `DELETE FROM appointment_change_log WHERE appointment_id IN
           (SELECT id FROM appointments WHERE patient_id = $1)`,
        [other.id],
      );
      await query(`DELETE FROM appointments WHERE patient_id = $1`, [other.id]);
      await query(`DELETE FROM patients WHERE id = $1`, [other.id]);
    }
  });
});
