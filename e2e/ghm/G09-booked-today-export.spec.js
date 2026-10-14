import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

async function appointment(patient, { daysAhead, bookedDaysAgo = 0, walkIn = false }) {
  return one(
    `INSERT INTO appointments
       (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
        status, visit_type, is_walkin, created_at)
     VALUES ($1, $2, $3, $4, 'Dr E2E Banshali',
             (NOW() AT TIME ZONE 'Asia/Kolkata')::date + $5::int, '12:30 PM to 1 PM',
             'scheduled', 'Follow-Up', $6, NOW() - make_interval(days => $7::int))
     RETURNING id`,
    [patient.id, patient.file_no, patient.name, patient.phone, daysAhead, walkIn, bookedDaysAgo],
  );
}

test.describe("GHM: export the appointments booked today, for any date", () => {
  let patients;
  let appts;
  let admin;

  test.beforeAll(async () => {
    patients = [
      await buildPatient(),
      await buildPatient(),
      await buildPatient(),
      await buildPatient(),
    ];
    appts = {
      nextWeek: (await appointment(patients[0], { daysAhead: 7 })).id,
      bookedYesterday: (await appointment(patients[1], { daysAhead: 0, bookedDaysAgo: 1 })).id,
      walkIn: (await appointment(patients[2], { daysAhead: 0, walkIn: true })).id,
      flaggedAhead: (await appointment(patients[3], { daysAhead: 5, walkIn: true })).id,
    };
    admin = await apiAs("admin");
  });

  test.afterAll(async () => {
    const ids = patients.map((p) => p.id);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
  });

  test("1. holds a booking taken today for next week, not yesterday's booking or a walk-in", async () => {
    const date = (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`)).d;
    const res = await admin.get(
      `/api/ghm-appointments?date=${date}&limit=100&page=1&booked=today&export=1`,
    );
    expect(res.status()).toBe(200);
    const ids = (await res.json()).data.map((r) => r.id);
    expect(ids).toContain(appts.nextWeek);
    expect(ids).not.toContain(appts.bookedYesterday);
    expect(ids).not.toContain(appts.walkIn);
    expect(ids).toContain(appts.flaggedAhead);
  });
});
