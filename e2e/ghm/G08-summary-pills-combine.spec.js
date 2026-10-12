import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

async function appointmentToday(patient, callStatus = null) {
  return one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type, call_status, call_date)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date, '12:30 PM to 1 PM', 'scheduled',
             'Follow-Up', $5, CASE WHEN $5::text IS NULL THEN NULL
                                   ELSE (NOW() AT TIME ZONE 'Asia/Kolkata')::date END)
     RETURNING id`,
    [patient.id, patient.file_no, patient.name, patient.phone, callStatus],
  );
}

test.describe("GHM: a Calling pill combines with Booked", () => {
  let patients;
  let admin;
  let date;

  test.beforeAll(async () => {
    date = (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`)).d;
    patients = [await buildPatient(), await buildPatient(), await buildPatient()];
    await appointmentToday(patients[0], "called");
    await appointmentToday(patients[1]);
    await appointmentToday(patients[2]);
    admin = await apiAs("admin");
  });

  test.afterAll(async () => {
    const ids = patients.map((p) => p.id);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
  });

  const list = async (bucket) => {
    const res = await admin.get(
      `/api/ghm-appointments?date=${date}&limit=500&page=1&calls=all&bucket=${bucket}`,
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ours = new Set(patients.map((p) => p.id));
    return { ...body, ours: body.data.filter((r) => ours.has(r.patient_id)) };
  };

  test("1. Booked + Need to Call lists only booked patients nobody has spoken to", async () => {
    const r = await list("booked,not_called");
    expect(r.ours.map((row) => row.patient_id).sort()).toEqual(
      [patients[1].id, patients[2].id].sort(),
    );
    expect(r.total).toBe(r.summary.not_called);
    expect(r.total).toBe(r.data.length);
  });

  test("2. Booked + Spoke lists only the called one, and the Calling counts stay within Booked", async () => {
    const r = await list("booked,called");
    expect(r.ours.map((row) => row.patient_id)).toEqual([patients[0].id]);
    expect(r.total).toBe(r.summary.called);
    expect(r.summary.booked).toBe(r.total);
    const booked = await list("booked");
    expect(r.summary.called + r.summary.not_called).toBeLessThanOrEqual(booked.total);
  });

  test("3. the Excel export holds exactly the combined pills' rows", async () => {
    const shown = await list("booked,not_called");
    const res = await admin.get(
      `/api/ghm-appointments?date=${date}&limit=100&page=1&calls=all&bucket=booked,not_called&export=1`,
    );
    const exported = (await res.json()).data;
    expect(exported.map((r) => r.id).sort()).toEqual(shown.data.map((r) => r.id).sort());
    expect(exported.map((r) => r.patient_id)).not.toContain(patients[0].id);
  });

  test("4. two pills from the same section keep only the last", async () => {
    const r = await list("not_called,called");
    expect(r.ours.map((row) => row.patient_id)).toEqual([patients[0].id]);
  });
});
