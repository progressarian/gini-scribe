import { test, expect } from "@playwright/test";
import { apiAs } from "../helpers/auth.mjs";
import { one, query } from "../helpers/db.mjs";
import { buildPatient } from "../helpers/builders.mjs";

test.describe("GHM: Prescription Explained By comes from the Rx desk", () => {
  let patients;
  let api;
  let date;

  test.beforeAll(async () => {
    patients = [await buildPatient(), await buildPatient()];
    api = await apiAs("admin");
    date = (await one(`SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::text AS d`)).d;
    for (const [i, p] of patients.entries()) {
      await query(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name, appointment_date, time_slot,
            status, visit_type, prescription_explained_by)
         VALUES ($1, $2, $3, $4, 'Dr E2E Banshali', $5::date, '10:00', 'completed', 'Follow-Up', $6)`,
        [p.id, p.file_no, p.name, p.phone, date, i === 1 ? "Typed By OBT" : null],
      );
      const visit = await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
         VALUES ($1, $2::date, 'pharmacy_pending') RETURNING id`,
        [p.id, date],
      );
      await query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
         VALUES ($1, 'pharmacy_pending', 'nurse', 9001, '{"source":"rx_station","explained":true}')`,
        [visit.id],
      );
    }
  });

  test.afterAll(async () => {
    const ids = patients.map((p) => p.id);
    await query(
      `DELETE FROM giniflow_visit_events WHERE visit_id IN
         (SELECT id FROM giniflow_visits WHERE patient_id = ANY($1::int[]))`,
      [ids],
    );
    await query(`DELETE FROM giniflow_visits WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM appointments WHERE patient_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM patients WHERE id = ANY($1::int[])`, [ids]);
  });

  test("1. an Rx-desk explain fills the column; a typed value still wins", async () => {
    const res = await api.get(`/api/ghm-appointments?date=${date}&limit=500&page=1&calls=all`);
    expect(res.status()).toBe(200);
    const rows = (await res.json()).data;
    const by = (p) => rows.find((r) => r.patient_id === p.id)?.prescription_explained_by;
    const staff = (await one(`SELECT name FROM doctors WHERE id = 9001`)).name;
    expect(by(patients[0])).toBe(staff);
    expect(by(patients[1])).toBe("Typed By OBT");
  });
});
