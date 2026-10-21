import "../loadEnv.js";
import pool from "../config/db.js";
import { dismissConsultantChange } from "../services/billing/consultantChange.js";

const fileNo = process.argv.slice(2).find((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");
const actorId = Number(process.argv.find((a) => a.startsWith("--actor="))?.split("=")[1]) || null;
const note =
  process.argv.find((a) => a.startsWith("--note="))?.slice("--note=".length) ||
  "Raised by mistake — no fee to settle";
if (!fileNo || !actorId) {
  console.error(
    'Usage: node scripts/dismiss-consultant-change.mjs <UHID> --actor=<staff id> [--note="why"] [--apply]',
  );
  process.exit(1);
}

const IST = (col) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI')`;

try {
  const { rows: actors } = await pool.query(
    `SELECT id, name, role FROM doctors WHERE id = $1 AND is_active IS NOT FALSE`,
    [actorId],
  );
  if (!actors.length) throw new Error(`No active staff member with id ${actorId}`);

  const { rows: pending } = await pool.query(
    `SELECT c.id, p.name AS patient, p.file_no, v.visit_date::text AS visit_date,
            f.name AS from_doctor, t.name AS to_doctor, b.name AS reassigned_by,
            ${IST("c.reassigned_at")} AS reassigned_ist
       FROM consultant_changes c
       JOIN patients p ON p.id = c.patient_id
       JOIN giniflow_visits v ON v.id = c.visit_id
       LEFT JOIN doctors f ON f.id = c.from_doctor_id
       LEFT JOIN doctors t ON t.id = c.to_doctor_id
       LEFT JOIN doctors b ON b.id = c.reassigned_by
      WHERE p.file_no = $1 AND c.status = 'pending'
      ORDER BY c.reassigned_at`,
    [fileNo],
  );
  console.log(`Pending consultant changes for ${fileNo}: ${pending.length}`);
  console.table(pending);
  if (!pending.length) process.exit(0);

  if (!apply) {
    console.log(
      `Dry run. Re-run with --apply to dismiss ${pending.length} change(s) as ${actors[0].name}, note: "${note}"`,
    );
    process.exit(0);
  }

  for (const change of pending) {
    const done = await dismissConsultantChange(
      change.id,
      { note },
      { actorId: actors[0].id, role: actors[0].role },
    );
    console.log(`Dismissed ${change.id}: ${done.status ?? "dismissed"}`);
  }
} finally {
  await pool.end();
}
