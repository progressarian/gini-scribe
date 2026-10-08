import { test, expect } from "@playwright/test";
import { apiAs, userFor } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

const istDay = async (offset) =>
  (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + $1::int)::text AS d`, [offset]))
    .d;

const SLOT = "12:30 PM to 1 PM";

const visitRow = (id) =>
  one(`SELECT time_slot, booking_status, booked_by_name FROM appointments WHERE id = $1`, [id]);

async function appointmentFor(patient, { offset, slot = null, status = "scheduled" }) {
  return one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date + $5::int, $6, $7, 'Follow-Up')
     RETURNING id`,
    [patient.id, patient.file_no, patient.name, patient.phone, offset, slot, status],
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

test.describe("GHM: a booking needs a time slot", () => {
  let patient;
  let api;

  test.beforeEach(async () => {
    patient = await buildPatient();
    api = await apiAs("reception_admin");
  });

  test.afterEach(async () => {
    await cleanup(patient);
  });

  test("1. a new appointment without a slot is refused", async () => {
    const res = await api.post("/api/ghm-appointments", {
      data: {
        patient_name: patient.name,
        file_no: patient.file_no,
        phone: patient.phone,
        doctor_name: "Dr E2E Banshali",
        appointment_date: await istDay(10),
        time_slot: "",
        visit_type: "Follow Up",
      },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/time slot/i);
  });

  test("2. a new appointment with a slot is booked and names who booked it", async () => {
    const res = await api.post("/api/ghm-appointments", {
      data: {
        patient_name: patient.name,
        file_no: patient.file_no,
        phone: patient.phone,
        doctor_name: "Dr E2E Banshali",
        appointment_date: await istDay(10),
        time_slot: SLOT,
        visit_type: "Follow Up",
      },
    });
    expect(res.status()).toBe(201);
    const booking = await res.json();
    expect(booking.booking_status).toBe("booked");
    expect(booking.booked_by_name).toBe(userFor("reception_admin").short_name);
  });

  test("3. Booked cannot be chosen while the appointment has no slot", async () => {
    const { id } = await appointmentFor(patient, { offset: 5 });
    const res = await api.patch(`/api/ghm-appointments/${id}`, {
      data: { booking_status: "booked" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/time slot/i);
    expect((await visitRow(id)).booking_status).toBeNull();
  });

  test("4. allocating a slot books the appointment and the change is audited", async () => {
    const { id } = await appointmentFor(patient, { offset: 5 });
    const res = await api.patch(`/api/ghm-appointments/${id}`, { data: { time_slot: SLOT } });
    expect(res.ok()).toBeTruthy();
    const row = await visitRow(id);
    expect(row.time_slot).toBe(SLOT);
    expect(row.booking_status).toBe("booked");
    const audit = await one(
      `SELECT new_value FROM appointment_change_log
        WHERE appointment_id = $1 AND field = 'booking_status' ORDER BY changed_at DESC LIMIT 1`,
      [id],
    );
    expect(audit?.new_value).toBe("booked");
  });

  test("5. removing the slot takes the booking back off", async () => {
    const { id } = await appointmentFor(patient, { offset: 5, slot: SLOT });
    await query(`UPDATE appointments SET booking_status = 'booked' WHERE id = $1`, [id]);
    const res = await api.patch(`/api/ghm-appointments/${id}`, { data: { time_slot: "" } });
    expect(res.ok()).toBeTruthy();
    expect((await visitRow(id)).booking_status).toBeNull();
  });

  test("6. a follow-up row needs the patient's preferred time, not the old visit's slot", async () => {
    const { id } = await appointmentFor(patient, { offset: -60, slot: SLOT, status: "completed" });
    const refused = await api.patch(`/api/ghm-appointments/${id}`, {
      data: { booking_status: "booked" },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toMatch(/preferred time/i);

    const res = await api.patch(`/api/ghm-appointments/${id}`, {
      data: { preferred_time_slot: "10 AM to 11 AM" },
    });
    expect(res.ok()).toBeTruthy();
    expect((await visitRow(id)).booking_status).toBe("booked");

    await api.patch(`/api/ghm-appointments/${id}`, { data: { preferred_time_slot: "" } });
    expect((await visitRow(id)).booking_status).toBeNull();
  });

  test("6b. a visit seen today is a follow-up row too: HealthRay's time is not the patient's", async () => {
    const { id } = await appointmentFor(patient, { offset: 0, slot: "08:55", status: "completed" });
    const refused = await api.patch(`/api/ghm-appointments/${id}`, {
      data: { booking_status: "booked" },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toMatch(/preferred time/i);
  });

  test("7. cancelling is always allowed", async () => {
    const { id } = await appointmentFor(patient, { offset: 5 });
    const res = await api.patch(`/api/ghm-appointments/${id}`, {
      data: { booking_status: "cancelled" },
    });
    expect(res.ok()).toBeTruthy();
    expect((await visitRow(id)).booking_status).toBe("cancelled");
  });
});
