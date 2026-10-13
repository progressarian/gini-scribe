import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

async function appointmentToday(patient, callStatus = null, status = "scheduled") {
  return one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type, call_status, call_date)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date, '12:30 PM to 1 PM', $6,
             'Follow-Up', $5, CASE WHEN $5::text IS NULL THEN NULL
                                   ELSE (NOW() AT TIME ZONE 'Asia/Kolkata')::date END)
     RETURNING id`,
    [patient.id, patient.file_no, patient.name, patient.phone, callStatus, status],
  );
}

test.describe("GHM: a Calling pill combines with Booked", () => {
  let patients;
  let admin;
  let date;

  test.beforeAll(async () => {
    date = (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`)).d;
    patients = [
      await buildPatient(),
      await buildPatient(),
      await buildPatient(),
      await buildPatient(),
      await buildPatient(),
    ];
    await appointmentToday(patients[0], "called");
    await appointmentToday(patients[1]);
    await appointmentToday(patients[2]);
    await appointmentToday(patients[3], null, "checkedin");
    await appointmentToday(patients[4], null, "seen");
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

  test("5. Need to Call leaves out patients who are already checked in or seen", async () => {
    const r = await list("not_called");
    const ids = r.ours.map((row) => row.patient_id);
    expect(ids).not.toContain(patients[3].id);
    expect(ids).not.toContain(patients[4].id);
    expect(ids).toContain(patients[1].id);
  });

  test("6. a follow-up due today whose old visit was seen still needs a call", async () => {
    const due = await buildPatient();
    try {
      await query(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type, preferred_date)
         VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
                 (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 28, '10:00', 'seen', 'Follow-Up',
                 (NOW() AT TIME ZONE 'Asia/Kolkata')::date)`,
        [due.id, due.file_no, due.name, due.phone],
      );
      const res = await admin.get(
        `/api/ghm-appointments?date=${date}&limit=500&page=1&calls=all&bucket=not_called`,
      );
      const ids = (await res.json()).data.map((r) => r.patient_id);
      expect(ids).toContain(due.id);
    } finally {
      await query(`DELETE FROM appointments WHERE patient_id = $1`, [due.id]);
      await query(`DELETE FROM patients WHERE id = $1`, [due.id]);
    }
  });

  test("7. on another date, Need to Call lists everyone not booked, whatever their call status", async () => {
    const [notBooked, booked] = [await buildPatient(), await buildPatient()];
    const ahead = (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date + 4)::text AS d`))
      .d;
    try {
      await query(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type, preferred_date, call_status, call_date)
         VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
                 (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 20, '10:00', 'completed', 'Follow-Up',
                 $5::date, 'called', (NOW() AT TIME ZONE 'Asia/Kolkata')::date)`,
        [notBooked.id, notBooked.file_no, notBooked.name, notBooked.phone, ahead],
      );
      await query(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type)
         VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', $5::date, '12:30 PM to 1 PM', 'scheduled',
                 'Follow-Up')`,
        [booked.id, booked.file_no, booked.name, booked.phone, ahead],
      );
      const res = await admin.get(
        `/api/ghm-appointments?date=${ahead}&limit=500&page=1&calls=all&bucket=not_called`,
      );
      const ids = (await res.json()).data.map((r) => r.patient_id);
      expect(ids).toContain(notBooked.id);
      expect(ids).not.toContain(booked.id);
    } finally {
      const ids = [notBooked.id, booked.id];
      await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
      await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
    }
  });

  test("8. the Cancelled pill lists only that day's cancelled patients", async () => {
    const gone = await buildPatient();
    try {
      await query(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type, booking_status)
         VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
                 '12:30 PM to 1 PM', 'scheduled', 'Follow-Up', 'cancelled')`,
        [gone.id, gone.file_no, gone.name, gone.phone],
      );
      const r = await list("cancelled");
      const ids = r.data.map((row) => row.patient_id);
      expect(ids).toContain(gone.id);
      expect(ids).not.toContain(patients[1].id);
      expect(r.total).toBe(r.summary.cancelled);
    } finally {
      await query(`DELETE FROM appointments WHERE patient_id = $1`, [gone.id]);
      await query(`DELETE FROM patients WHERE id = $1`, [gone.id]);
    }
  });

  test("9. Pending lists only patients who have not arrived on that date", async () => {
    const [arrived, waiting] = [await buildPatient(), await buildPatient()];
    try {
      await appointmentToday(arrived, null, "checkedin");
      await appointmentToday(waiting);
      const r = await list("pending_show");
      const ids = r.data.map((row) => row.patient_id);
      expect(ids).toContain(waiting.id);
      expect(ids).not.toContain(arrived.id);
      expect(r.total).toBe(r.summary.pending_show);
    } finally {
      const ids = [arrived.id, waiting.id];
      await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
      await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
    }
  });
});
