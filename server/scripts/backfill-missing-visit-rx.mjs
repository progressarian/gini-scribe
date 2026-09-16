import "../loadEnv.js";
import pool from "../config/db.js";
import {
  buildVisitPayloadFromDb,
  savePrescriptionForVisit,
} from "../services/prescriptionAutoSave.js";

const from = process.argv[2] || "2026-09-15";
const to = process.argv[3] || null;

const { rows } = await pool.query(
  `SELECT a.id, a.patient_id, a.consultation_id, a.appointment_date
     FROM appointments a
    WHERE a.appointment_date BETWEEN $1 AND COALESCE($2::date, CURRENT_DATE)
      AND a.status IN ('seen','completed') AND a.consultation_id IS NOT NULL
      AND COALESCE(jsonb_array_length(a.healthray_medications),0)
        + COALESCE(jsonb_array_length(a.healthray_diagnoses),0)
        + COALESCE(jsonb_array_length(a.opd_medications),0)
        + COALESCE(jsonb_array_length(a.opd_diagnoses),0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM documents d
         WHERE d.patient_id = a.patient_id AND d.consultation_id = a.consultation_id
           AND d.doc_type = 'prescription' AND d.source = 'visit')
    ORDER BY a.appointment_date, a.id`,
  [from, to],
);

console.log(`${rows.length} visits missing a scribe prescription`);
let saved = 0;
const failed = [];
for (const a of rows) {
  try {
    const payload = await buildVisitPayloadFromDb(a.patient_id, { appointmentId: a.id });
    if (!payload) throw new Error("no payload");
    const r = await savePrescriptionForVisit(a.patient_id, payload, {
      appointmentId: a.id,
      consultationId: a.consultation_id,
      source: "visit",
    });
    if (!r.storage_path) throw new Error(`saved doc ${r.document?.id} without a stored PDF`);
    saved += r.skipped ? 0 : 1;
    console.log(`ok   appt=${a.id} pid=${a.patient_id} doc=${r.document?.id} ${r.reason || ""}`);
  } catch (e) {
    failed.push(a.id);
    console.log(`FAIL appt=${a.id} pid=${a.patient_id} ${e.message}`);
  }
}
console.log(`done: saved=${saved} failed=${failed.length} ${failed.join(",")}`);
await pool.end();
process.exit(0);
