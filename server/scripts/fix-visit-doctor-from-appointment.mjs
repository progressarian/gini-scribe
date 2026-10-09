import "../loadEnv.js";
import pool from "../config/db.js";
import { consultantChangedIn } from "../services/billing/consultantChange.js";
import { LAB_ONLY_DOCTOR } from "../services/giniflow/labOnlyVisits.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [date, ...fileNos] = args;
const apply = process.argv.includes("--apply");
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !fileNos.length) {
  console.error(
    "Usage: node scripts/fix-visit-doctor-from-appointment.mjs <YYYY-MM-DD> <file_no>... [--apply]",
  );
  process.exit(1);
}

const MISMATCH_SQL = `
  SELECT v.id AS visit_id, v.current_status, p.file_no, p.name,
         cur.id AS from_id, COALESCE(cur.short_name, cur.name) AS from_name,
         doc.id AS to_id, COALESCE(doc.short_name, doc.name) AS to_name,
         (SELECT json_agg(json_build_object('status', b.status, 'payable', b.patient_payable,
                                            'paid', b.paid_amount))
            FROM bills b WHERE b.visit_id = v.id AND b.status <> 'cancelled') AS bills
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    JOIN appointments a ON a.id = v.appointment_id
    JOIN doctors doc
      ON lower(btrim(doc.name)) = lower(btrim(a.doctor_name))
     AND doc.role = 'consultant' AND COALESCE(doc.is_active, TRUE)
     AND lower(btrim(a.doctor_name)) <> lower($3)
    LEFT JOIN doctors cur ON cur.id = v.assigned_doctor_id
   WHERE v.visit_date = $1::date AND v.merged_into_visit_id IS NULL
     AND p.file_no = ANY($2::text[])
     AND v.assigned_doctor_id IS DISTINCT FROM doc.id`;

const client = await pool.connect();
try {
  const { rows } = await client.query(MISMATCH_SQL, [date, fileNos, LAB_ONLY_DOCTOR]);
  const found = new Set(rows.map((r) => r.file_no));
  for (const f of fileNos.filter((f) => !found.has(f))) {
    console.log(`- ${f}: already on the appointment's doctor (or no visit), skipped`);
  }
  for (const r of rows) {
    console.log(
      `- ${r.file_no} ${r.name} [${r.current_status}]: ${r.from_name} → ${r.to_name}; bills ${JSON.stringify(r.bills || [])}`,
    );
  }
  if (!apply) {
    console.log("\nPreview only. Re-run with --apply to move these visits and their draft fee.");
  } else {
    for (const r of rows) {
      await client.query("BEGIN");
      try {
        await client.query(
          `UPDATE giniflow_visits SET assigned_doctor_id = $2, updated_at = NOW() WHERE id = $1`,
          [r.visit_id, r.to_id],
        );
        await client.query(
          `UPDATE giniflow_visit_steps SET assigned_staff_id = $2::text, assigned_staff_name = $3
            WHERE visit_id = $1 AND chain_status = 'with_doctor'`,
          [r.visit_id, r.to_id, r.to_name],
        );
        const billing = await consultantChangedIn(client, r.visit_id, r.to_id, {
          actorId: null,
          role: "system",
        });
        await client.query("COMMIT");
        console.log(`  moved ${r.file_no}: ${JSON.stringify(billing)}`);
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(`  ${r.file_no} not changed: ${e.message}`);
        process.exitCode = 1;
      }
    }
  }
} finally {
  client.release();
  await pool.end();
}
