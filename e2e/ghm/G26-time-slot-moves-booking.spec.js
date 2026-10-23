import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const istDay = async (offset) =>
  (
    await one(
      `SELECT skip_sunday((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`,
      [offset],
    )
  ).d;

test.describe("G26 changing Time Slot on a current booking moves the booking", () => {
  let patient;
  let api;

  test.beforeAll(async () => {
    patient = await buildPatient();
    api = await apiAs("admin");
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM appointment_change_log WHERE appointment_id IN
         (SELECT id FROM appointments WHERE file_no = $1)`,
      [patient.file_no],
    );
    await query(`DELETE FROM appointments WHERE file_no = $1`, [patient.file_no]);
    await query(`DELETE FROM patients WHERE id = $1`, [patient.id]);
    await api.dispose();
  });

  const listRow = async (day, id) =>
    (await (await api.get(`/api/ghm-appointments?date=${day}&limit=200`)).json()).data.find(
      (r) => r.id === id,
    );

  test("1. the new slot is saved on the booking, shown in the list and logged", async () => {
    const day = await istDay(0);
    const made = await api.post("/api/ghm-appointments", {
      data: {
        patient_name: patient.name,
        file_no: patient.file_no,
        phone: patient.phone,
        doctor_name: "Dr E2E Banshali",
        appointment_date: day,
        time_slot: "10 AM to 11 AM",
        visit_type: "New Patient",
      },
    });
    expect(made.status()).toBe(201);
    const { id } = await made.json();

    const res = await api.patch(`/api/ghm-appointments/${id}`, {
      data: { preferred_time_slot: "12 PM to 1 PM" },
    });
    expect(res.ok()).toBeTruthy();

    const saved = await one(`SELECT time_slot, booking_status FROM appointments WHERE id = $1`, [
      id,
    ]);
    expect(saved).toEqual({ time_slot: "12 PM to 1 PM", booking_status: "booked" });
    expect((await listRow(day, id)).preferred_time_slot).toBe("12 PM to 1 PM");
    const logged = await one(
      `SELECT old_value, new_value FROM appointment_change_log
        WHERE appointment_id = $1 AND field = 'time_slot' ORDER BY id DESC LIMIT 1`,
      [id],
    );
    expect(logged).toEqual({ old_value: "10 AM to 11 AM", new_value: "12 PM to 1 PM" });
  });

  test("2. clearing Time Slot does not take the booking off", async () => {
    const { id } = await one(
      `SELECT id FROM appointments WHERE file_no = $1 ORDER BY id DESC LIMIT 1`,
      [patient.file_no],
    );
    await api.patch(`/api/ghm-appointments/${id}`, { data: { preferred_time_slot: "" } });
    expect(
      await one(`SELECT time_slot, booking_status FROM appointments WHERE id = $1`, [id]),
    ).toEqual({ time_slot: "12 PM to 1 PM", booking_status: "booked" });
  });

  test("3. a past visit keeps its slot; only the preferred time changes", async () => {
    const past = await istDay(-3);
    const visit = await one(
      `INSERT INTO appointments
         (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
          status, visit_type)
       VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', $5, '10 AM to 11 AM', 'completed', 'OPD')
       RETURNING id`,
      [patient.id, patient.file_no, patient.name, patient.phone, past],
    );
    await api.patch(`/api/ghm-appointments/${visit.id}`, {
      data: { preferred_time_slot: "11 AM to 12 PM" },
    });
    expect(
      await one(`SELECT time_slot, preferred_time_slot FROM appointments WHERE id = $1`, [
        visit.id,
      ]),
    ).toEqual({ time_slot: "10 AM to 11 AM", preferred_time_slot: "11 AM to 12 PM" });
  });
});
