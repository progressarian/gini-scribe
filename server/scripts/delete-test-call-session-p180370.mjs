import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");

try {
  const { rows } = await pool.query(
    `SELECT s.id, p.file_no, p.name, s.called_by, s.duration_secs, s.ended_reason,
            to_char(s.started_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH12:MI:SS am') AS started
       FROM call_claim_sessions s
       JOIN patients p ON p.id = s.patient_id
      WHERE p.file_no = 'P_180370'
        AND s.called_by ILIKE '%gurjot%'
        AND (s.started_at AT TIME ZONE 'Asia/Kolkata')::date = DATE '2026-10-28'
        AND to_char(s.started_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') = '14:53'
        AND s.duration_secs <= 5`,
  );
  console.table(rows);
  if (rows.length !== 1) {
    console.log(`Expected exactly 1 test call, found ${rows.length}. Nothing deleted.`);
  } else if (!APPLY) {
    console.log("DRY RUN. Re-run with --apply to delete this row.");
  } else {
    const r = await pool.query(`DELETE FROM call_claim_sessions WHERE id = $1`, [rows[0].id]);
    console.log(`Deleted ${r.rowCount} call history row (id ${rows[0].id}).`);
  }
} finally {
  await pool.end();
}
