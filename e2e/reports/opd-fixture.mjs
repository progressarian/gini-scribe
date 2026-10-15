import crypto from "node:crypto";
import { query } from "../helpers/db.mjs";
import { PATIENTS } from "../fixtures/data.mjs";

export const MONTH = "2021-06";
export const PREVIOUS = "2021-05";

export const newTag = () => crypto.randomBytes(3).toString("hex");

export async function today() {
  const { rows } = await query(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`);
  return rows[0].d;
}

export function seedRows(tag, now) {
  const docA = `Dr. Alpha ${tag}`;
  const docB = `Dr. Beta ${tag}`;
  const p = PATIENTS;
  const row = (patient, doctor, day, visitType, status, timeSlot = null) => ({
    patient,
    doctor,
    day,
    visitType,
    status,
    timeSlot,
  });
  return {
    docA,
    docB,
    rows: [
      row(p.general, docA, `${MONTH}-02`, "New Patient", "completed", "09:30"),
      row(p.general, docA, `${MONTH}-02`, "Follow-Up", "completed", "11:00"),
      row(p.senior, docA, `${MONTH}-03`, "Follow-Up", "checkedin", "10:00"),
      row(p.cghsPaid, docA, `${MONTH}-03`, "OPD", "seen", "12:00"),
      row(p.cghsReferral, docA, `${MONTH}-04`, "Tele", "completed", "15:00"),
      row(p.pensioner, docA, `${MONTH}-04`, "Investigation", "completed", "08:00"),
      row(p.senior, docA, `${MONTH}-05`, "Follow-Up", "no_show"),
      row(p.cghsPaid, docA, `${MONTH}-05`, "Follow-Up", "cancelled"),
      row(p.cghsReferral, docA, `${MONTH}-06`, "Follow-Up", "scheduled"),
      row(p.pensioner, docA, `${MONTH}-07`, "Follow-Up", "lead"),
      row(p.general, docB, `${MONTH}-08`, "Follow-Up", "completed", "10:15"),
      row(p.senior, "Dr. Hospital Admin", `${MONTH}-08`, "Follow-Up", "completed", "07:30"),
      row(p.general, docA, `${PREVIOUS}-20`, "Follow-Up", "completed"),
      row(p.senior, docA, `${PREVIOUS}-21`, "Follow-Up", "completed"),
      row(p.senior, docA, now, "Follow-Up", "scheduled"),
    ],
  };
}

export async function seed(tag) {
  const now = await today();
  const plan = seedRows(tag, now);
  for (const r of plan.rows) {
    await query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, phone, doctor_name,
                                 appointment_date, time_slot, visit_type, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        r.patient.id,
        r.patient.name,
        r.patient.file_no,
        r.patient.phone,
        r.doctor,
        r.day,
        r.timeSlot,
        r.visitType,
        r.status,
        `opd-summary-${tag}`,
      ],
    );
  }
  return { ...plan, now };
}

export async function clear(tag) {
  await query(`DELETE FROM appointments WHERE notes = $1`, [`opd-summary-${tag}`]);
}
