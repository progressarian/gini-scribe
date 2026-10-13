import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

test.describe("GHM: Booked needs a time slot, a real one or the preferred time", () => {
  let patient;
  let admin;
  let preferred;

  test.beforeAll(async () => {
    patient = await buildPatient();
    preferred = (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 3)::text AS d`)).d;
    await query(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
          status, visit_type, booking_status, preferred_date)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 20, '12:30 PM to 1 PM', 'seen',
               'Follow-Up', 'booked', $5::date)`,
      [patient.id, patient.file_no, patient.name, patient.phone, preferred],
    );
    admin = await apiAs("admin");
  });

  test.afterAll(async () => {
    await query(`DELETE FROM appointments WHERE patient_id = $1`, [patient.id]);
    await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
  });

  const rowOn = async () => {
    const res = await admin.get(
      `/api/ghm-appointments?date=${preferred}&limit=500&page=1&calls=all`,
    );
    expect(res.status()).toBe(200);
    return (await res.json()).data.find((r) => r.patient_id === patient.id);
  };

  test("1. marked Booked with only a preferred date is not Booked, and says no slot yet", async () => {
    const row = await rowOn();
    expect(row.is_booked).toBe(false);
    expect(row.booking_no_slot).toBe(true);
  });

  test("2. once an appointment with a time slot is made for that date, it is Booked", async () => {
    await query(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
          status, visit_type)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', $5::date, '10 AM to 11 AM', 'scheduled', 'Follow-Up')`,
      [patient.id, patient.file_no, patient.name, patient.phone, preferred],
    );
    const res = await admin.get(
      `/api/ghm-appointments?date=${preferred}&limit=500&page=1&calls=all&bucket=booked`,
    );
    const ours = (await res.json()).data.filter((r) => r.patient_id === patient.id);
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((r) => r.is_booked)).toBe(true);
  });

  test("3. a preferred date with a preferred time counts as Booked, even unlinked", async () => {
    const other = await one(
      `INSERT INTO appointments
         (patient_name, phone, doctor_name, appointment_date, status, visit_type,
          preferred_date, preferred_time_slot)
       VALUES ('E2E Unlinked Patient', '9000000000', 'Dr E2E Banshali',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 200, 'scheduled', 'OPD',
               $1::date, '5 PM to 6 PM')
       RETURNING id`,
      [preferred],
    );
    try {
      const res = await admin.get(
        `/api/ghm-appointments?date=${preferred}&limit=500&page=1&calls=all`,
      );
      const row = (await res.json()).data.find((r) => r.id === other.id);
      expect(row?.is_booked).toBe(true);
    } finally {
      await query(`DELETE FROM appointments WHERE id = $1`, [other.id]);
    }
  });

  test("4. a tests-only visit under Dr. Hospital Admin does not count as booking the follow-up", async () => {
    const other = await buildPatient();
    try {
      const row = await one(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type, preferred_date)
         VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
                 (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 10, '12:30 PM to 1 PM', 'seen',
                 'Follow-Up', $5::date)
         RETURNING id`,
        [other.id, other.file_no, other.name, other.phone, preferred],
      );
      await query(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type)
         VALUES ($1, $2, $3, $4, 'Dr. Hospital Admin', $5::date + 1, '09:00', 'scheduled',
                 'Investigation')`,
        [other.id, other.file_no, other.name, other.phone, preferred],
      );
      const res = await admin.get(
        `/api/ghm-appointments?date=${preferred}&limit=500&page=1&calls=all`,
      );
      const found = (await res.json()).data.find((r) => r.id === row.id);
      expect(found?.is_booked).toBe(false);
    } finally {
      await query(`DELETE FROM appointments WHERE patient_id = $1`, [other.id]);
      await query(`DELETE FROM patients WHERE id = $1`, [other.id]);
    }
  });

  test("5. a booking the patient came for is not shown as lapsed", async () => {
    const other = await buildPatient();
    try {
      await query(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type, booking_status)
         VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
                 (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 4, '10:50', 'completed',
                 'New Patient', 'booked')`,
        [other.id, other.file_no, other.name, other.phone],
      );
      const res = await admin.get(
        `/api/ghm-appointments?mode=lookup&q=${encodeURIComponent(other.file_no)}&page=1&limit=20`,
      );
      const row = (await res.json()).data.find((r) => r.file_no === other.file_no);
      expect(row.booking_lapsed).toBe(false);
    } finally {
      await query(`DELETE FROM appointments WHERE patient_id = $1`, [other.id]);
      await query(`DELETE FROM patients WHERE id = $1`, [other.id]);
    }
  });

  test("6. a follow-up date with a preferred time counts as Booked", async () => {
    const other = await buildPatient();
    try {
      const row = await one(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type, follow_up_date, preferred_time_slot)
         VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
                 (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 30, '10:00', 'completed',
                 'Follow-Up', $5::date, '11 AM to 12 PM')
         RETURNING id`,
        [other.id, other.file_no, other.name, other.phone, preferred],
      );
      const res = await admin.get(
        `/api/ghm-appointments?date=${preferred}&limit=500&page=1&calls=all`,
      );
      const found = (await res.json()).data.find((r) => r.id === row.id);
      expect(found?.is_booked).toBe(true);
    } finally {
      await query(`DELETE FROM appointments WHERE patient_id = $1`, [other.id]);
      await query(`DELETE FROM patients WHERE id = $1`, [other.id]);
    }
  });
});
