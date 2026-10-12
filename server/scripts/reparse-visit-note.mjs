import "../loadEnv.js";
import pool from "../config/db.js";
import { parsePrescriptionWithAi } from "../services/healthray/parser.js";
import { applyOpdParse } from "../services/cron/healthraySync.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [fileNo, date] = args;
const apply = process.argv.includes("--apply");
if (!fileNo || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
  console.error("Usage: node scripts/reparse-visit-note.mjs <file_no> <YYYY-MM-DD> [--apply]");
  process.exit(1);
}

try {
  const { rows } = await pool.query(
    `SELECT a.id, a.patient_id, a.healthray_id, a.appointment_date, a.healthray_clinical_notes,
            a.healthray_investigations, a.healthray_follow_up, p.name
       FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE p.file_no = $1 AND a.appointment_date = $2::date
        AND length(COALESCE(a.healthray_clinical_notes, '')) > 20
      ORDER BY a.id DESC LIMIT 1`,
    [fileNo, date],
  );
  if (!rows.length) throw new Error(`No HealthRay note for ${fileNo} on ${date}`);
  const appt = rows[0];
  const parsed = await parsePrescriptionWithAi(appt.healthray_clinical_notes, date);
  if (!parsed) throw new Error("The note could not be read");

  const testNames = (list) => (list || []).map((t) => (typeof t === "string" ? t : t.name));
  console.log(`${fileNo} ${appt.name} · appointment ${appt.id} on ${date}`);
  console.log(`  tests now:     ${testNames(appt.healthray_investigations).join(", ") || "none"}`);
  console.log(`  tests in note: ${testNames(parsed.investigations_to_order).join(", ") || "none"}`);
  console.log(
    `  follow-up:     ${JSON.stringify(parsed.follow_up)} · ${parsed.follow_up_with || ""}`,
  );
  console.log(
    `  medicines:     ${(parsed.medications || []).map((m) => `${m.name} ${m.dose || ""}`.trim()).join(", ")}`,
  );

  if (!apply) {
    console.log("\nPreview only. Re-run with --apply to store this and remake the Scribe Rx.");
  } else {
    await pool.query(`UPDATE appointments SET post_visit_summary = NULL WHERE id = $1`, [appt.id]);
    await applyOpdParse(
      {
        patientId: appt.patient_id,
        healthrayId: appt.healthray_id,
        appointmentDate: appt.appointment_date,
        apptId: appt.id,
      },
      parsed,
    );
    const { rows: rx } = await pool.query(
      `SELECT d.id, d.created_at FROM documents d
        WHERE d.patient_id = $1 AND d.doc_type = 'prescription' AND d.source = 'visit'
        ORDER BY d.created_at DESC LIMIT 1`,
      [appt.patient_id],
    );
    console.log(`\nStored. Latest Scribe Rx: ${JSON.stringify(rx[0] || null)}`);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  process.exit();
}
