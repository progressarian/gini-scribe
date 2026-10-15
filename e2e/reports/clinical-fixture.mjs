import crypto from "node:crypto";
import { one, query } from "../helpers/db.mjs";

export const newTag = () => crypto.randomBytes(3).toString("hex");

export async function seedClinical(tag) {
  const doctor = `Dr. Report ${tag}`;
  const made = {};
  for (const key of ["p1", "p2", "p3", "p4"]) {
    made[key] = (
      await one(
        `INSERT INTO patients (name, file_no, age, sex) VALUES ($1, $2, 50, 'Male') RETURNING id`,
        [`R03 ${key.toUpperCase()} ${tag}`, `R03-${tag}-${key}`],
      )
    ).id;
    await query(`INSERT INTO consultations (patient_id, visit_date, con_name) VALUES ($1, CURRENT_DATE, $2)`, [
      made[key],
      doctor,
    ]);
  }
  const lab = (patient, test, result) =>
    query(
      `INSERT INTO lab_results (patient_id, test_name, result, test_date) VALUES ($1, $2, $3, CURRENT_DATE)`,
      [patient, test, result],
    );
  await lab(made.p1, "HbA1c", 6.5);
  await lab(made.p1, "FBG", 200);
  await lab(made.p2, "HbA1c", 7.5);
  await lab(made.p2, "LDL", 150);
  await lab(made.p3, "HbA1c", 9);
  await query(
    `INSERT INTO vitals (patient_id, recorded_at, weight) VALUES ($1, NOW() - interval '40 days', 82)`,
    [made.p1],
  );
  await query(
    `INSERT INTO vitals (patient_id, recorded_at, bp_sys, bp_dia, weight, bmi)
     VALUES ($1, NOW() - interval '1 day', 120, 70, 80, 24)`,
    [made.p1],
  );
  await query(
    `INSERT INTO vitals (patient_id, recorded_at, bp_sys, bp_dia) VALUES ($1, NOW() - interval '1 day', 135, 85)`,
    [made.p2],
  );
  await query(
    `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status, is_active)
     VALUES ($1, 'type_2_diabetes_mellitus', 'Type 2 Diabetes Mellitus', 'Controlled', true)`,
    [made.p1],
  );
  return { doctor, ...made };
}

export async function addVisit(patient, doctor) {
  await query(`INSERT INTO consultations (patient_id, visit_date, con_name) VALUES ($1, CURRENT_DATE, $2)`, [
    patient,
    doctor,
  ]);
}

export async function clearClinical(tag) {
  const { rows } = await query(`SELECT id FROM patients WHERE file_no LIKE $1`, [`R03-${tag}-%`]);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  for (const table of ["diagnoses", "vitals", "lab_results", "consultations"]) {
    await query(`DELETE FROM ${table} WHERE patient_id = ANY($1)`, [ids]);
  }
  await query(`DELETE FROM patients WHERE id = ANY($1)`, [ids]);
}
