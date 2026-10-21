import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { syncMedications, stopStaleHealthrayMeds } =
  await import("../../server/services/healthray/db.js");

const tag = `${Date.now()}`.slice(-7);
const RX = {
  april: { id: `91${tag}1`, date: "2026-04-20" },
  july: { id: `91${tag}2`, date: "2026-07-20" },
  today: { id: `91${tag}3`, date: "2026-10-21" },
};
const APRIL_MEDS = [
  { name: "Empajio SM", dose: "10/100/1 g", frequency: "OD" },
  { name: "Atchol", dose: "20 mg", frequency: "OD" },
];
const JULY_MEDS = [
  { name: "Cospiaq SM", dose: "25/100/1000 mg", frequency: "OD" },
  { name: "Ezetimibe", dose: "10 mg", frequency: "OD" },
];
const TODAY_MEDS = [
  { name: "Empabite SM", dose: "25/100/1 g", frequency: "OD" },
  { name: "Rosroot", dose: "20 mg", frequency: "OD" },
];
const TODAY_NOTE =
  "FOLLOW UP TODAY:21/10/26\nMEDICATIONS:\nTAB. EMPABITE SM 25/100/1GM\nTAB. ROSROOT 20MG";
let patientId;

const activeNames = async () =>
  (
    await query(`SELECT name FROM medications WHERE patient_id = $1 AND is_active ORDER BY name`, [
      patientId,
    ])
  ).rows.map((r) => r.name);

async function addVisit(rx, meds, note) {
  await query(
    `INSERT INTO appointments
       (patient_id, patient_name, file_no, appointment_date, status, healthray_id,
        healthray_medications, healthray_clinical_notes)
     VALUES ($1, 'G111 Patient', $2, $3, 'completed', $4, $5::jsonb, $6)`,
    [patientId, `P_G111${tag}`, rx.date, rx.id, JSON.stringify(meds), note],
  );
}

async function applyRx(rx, meds) {
  await syncMedications(patientId, rx.id, rx.date, meds);
  await stopStaleHealthrayMeds(patientId, rx.id, rx.date, meds);
}

test.describe("G111 an older HealthRay prescription never replaces a newer visit's list", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const patient = await one(
      `INSERT INTO patients (name, file_no) VALUES ('G111 Patient', $1) RETURNING id`,
      [`P_G111${tag}`],
    );
    patientId = patient.id;
    await addVisit(RX.april, APRIL_MEDS, "FOLLOW UP TODAY:20/4/26\nTAB EMPAJIO SM\nTAB ATCHOL 20");
    await addVisit(RX.july, JULY_MEDS, "FOLLOW UP TODAY:20/7/26\nTAB COSPIAQ SM\nTAB EZETIMIBE 10");
    await applyRx(RX.april, APRIL_MEDS);
  });

  test.afterAll(async () => {
    if (!patientId) return;
    await query(`DELETE FROM medications WHERE patient_id = $1`, [patientId]);
    await query(`DELETE FROM appointments WHERE patient_id = $1`, [patientId]);
    await query(`DELETE FROM patients WHERE id = $1`, [patientId]);
  });

  test("1. a newer visit's prescription replaces the older list", async () => {
    await applyRx(RX.july, JULY_MEDS);
    expect(await activeNames()).toEqual(["Cospiaq SM", "Ezetimibe"]);
  });

  test("2. replaying an older prescription leaves the newer list alone", async () => {
    await applyRx(RX.april, APRIL_MEDS);
    expect(await activeNames()).toEqual(["Cospiaq SM", "Ezetimibe"]);
  });

  test("3. a newer visit whose note is not parsed yet blocks older prescriptions", async () => {
    await addVisit(RX.today, [], TODAY_NOTE);
    await applyRx(RX.april, APRIL_MEDS);
    await applyRx(RX.july, JULY_MEDS);
    const july = await query(
      `SELECT name, last_prescribed_date FROM medications
        WHERE patient_id = $1 AND is_active ORDER BY name`,
      [patientId],
    );
    expect(july.rows.map((r) => r.name)).toEqual(["Cospiaq SM", "Ezetimibe"]);
    expect(july.rows.every((r) => r.last_prescribed_date === RX.july.date)).toBe(true);
  });

  test("4. once today's note is parsed, today's prescription becomes the list", async () => {
    await query(
      `UPDATE appointments SET healthray_medications = $2::jsonb
        WHERE patient_id = $1 AND healthray_id = $3`,
      [patientId, JSON.stringify(TODAY_MEDS), RX.today.id],
    );
    await applyRx(RX.today, TODAY_MEDS);
    expect(await activeNames()).toEqual(["Empabite SM", "Rosroot"]);
  });
});
