import { test, expect } from "@playwright/test";
import { apiAs, userFor } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const istDay = async (offset) =>
  (
    await one(
      `SELECT skip_sunday((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`,
      [offset],
    )
  ).d;

test.describe("G24 the follow-up row's preferred date and time show the latest booking or change", () => {
  let patient;

  test.beforeAll(async () => {
    patient = await buildPatient();
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE file_no = $1)`,
      [patient.file_no],
    );
    await query(`DELETE FROM appointments WHERE file_no = $1`, [patient.file_no]);
    await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
  });

  test("a newer booking, then a newer preferred change, then the row's own change each win", async () => {
    const dueDay = await istDay(19);
    const bookedDay = await istDay(22);
    const laterDay = await istDay(26);
    const visit = await one(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, status,
          visit_type, follow_up_date, preferred_date, preferred_time_slot, preferred_doctor,
          booking_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 40, 'completed', 'Follow-Up',
               $5, $5, '9 AM to 10 AM', 'Dr E2E Banshali', 'booked',
               NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days')
       RETURNING id`,
      [patient.id, patient.file_no, patient.name, patient.phone, dueDay],
    );
    await query(
      `INSERT INTO appointment_change_log
         (appointment_id, field, field_label, old_value, new_value, changed_by, changed_at)
       VALUES ($1, 'preferred_date', 'Preferred Date', NULL, $2, 'Caller', NOW() - INTERVAL '40 days')`,
      [visit.id, dueDay],
    );
    const me = userFor("reception_admin");
    const api = await apiAs("reception_admin");
    try {
      const listRow = async () =>
        (await (await api.get(`/api/ghm-appointments?date=${dueDay}&limit=100`)).json()).data.find(
          (r) => r.id === visit.id,
        );

      expect(await listRow()).toMatchObject({
        preferred_date: dueDay,
        preferred_time_slot: "9 AM to 10 AM",
        via_preferred: true,
      });

      const booked = await api.post("/api/ghm-appointments", {
        data: {
          patient_name: patient.name,
          file_no: patient.file_no,
          phone: patient.phone,
          doctor_name: "Dr E2E Banshali",
          appointment_date: bookedDay,
          time_slot: "4:30 PM to 5 PM",
          visit_type: "Follow Up",
        },
      });
      expect(booked.status()).toBe(201);
      const booking = await booked.json();

      expect(await listRow()).toMatchObject({
        preferred_date: bookedDay,
        preferred_time_slot: "4:30 PM to 5 PM",
        preferred_doctor: "Dr E2E Banshali",
        preferred_set_by: me.short_name,
        via_preferred: false,
        booked_on: bookedDay,
      });

      const bookingRow = (
        await (await api.get(`/api/ghm-appointments?date=${bookedDay}&limit=100`)).json()
      ).data.find((r) => r.id === booking.id);
      expect(bookingRow).toMatchObject({
        preferred_date: bookedDay,
        preferred_time_slot: "4:30 PM to 5 PM",
        preferred_set_by: me.short_name,
      });

      const moved = await api.patch(`/api/ghm-appointments/${booking.id}`, {
        data: { preferred_time_slot: "5 PM to 6 PM" },
      });
      expect(moved.ok()).toBeTruthy();
      await query(`UPDATE appointments SET preferred_date = $2 WHERE id = $1`, [
        booking.id,
        bookedDay,
      ]);
      await query(
        `INSERT INTO appointment_change_log
           (appointment_id, field, field_label, old_value, new_value, changed_by, changed_at)
         VALUES ($1, 'preferred_date', 'Preferred Date', NULL, $2, 'Caller', NOW())`,
        [booking.id, bookedDay],
      );
      expect(await listRow()).toMatchObject({
        preferred_date: bookedDay,
        preferred_time_slot: "5 PM to 6 PM",
      });

      const own = await api.patch(`/api/ghm-appointments/${visit.id}`, {
        data: { preferred_date: laterDay, preferred_time_slot: "11 AM to 12 PM" },
      });
      expect(own.ok()).toBeTruthy();
      expect(await listRow()).toMatchObject({
        preferred_date: laterDay,
        preferred_time_slot: "11 AM to 12 PM",
      });
    } finally {
      await api.dispose();
    }
  });

  test("a newer booking that was missed leaves the preferred columns empty", async () => {
    const other = await buildPatient();
    const dueDay = await istDay(10);
    const visit = await one(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, status,
          visit_type, follow_up_date, preferred_date, preferred_time_slot,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 40, 'completed', 'Follow-Up',
               $5, $5, '11 AM to 12 PM', NOW() - INTERVAL '40 days', NOW() - INTERVAL '40 days')
       RETURNING id`,
      [other.id, other.file_no, other.name, other.phone, dueDay],
    );
    const missed = await one(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, status,
          time_slot, created_at)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
               (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 5, 'no_show', '11:00',
               NOW() - INTERVAL '50 days')
       RETURNING id`,
      [other.id, other.file_no, other.name, other.phone],
    );
    const api = await apiAs("reception_admin");
    const listRow = async () =>
      (await (await api.get(`/api/ghm-appointments?date=${dueDay}&limit=100`)).json()).data.find(
        (r) => r.id === visit.id,
      );
    try {
      expect(await listRow()).toMatchObject({
        preferred_date: dueDay,
        preferred_time_slot: "11 AM to 12 PM",
      });

      await query(`UPDATE appointments SET created_at = NOW() WHERE id = $1`, [missed.id]);
      expect(await listRow()).toMatchObject({
        preferred_date: null,
        preferred_time_slot: null,
        preferred_set_by: null,
      });
    } finally {
      await api.dispose();
      await query(`DELETE FROM appointments WHERE file_no = $1`, [other.file_no]);
      await query(`DELETE FROM patients WHERE id = $1`, [other.id]);
    }
  });
});
