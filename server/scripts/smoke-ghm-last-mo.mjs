import "../loadEnv.js";
import pool from "../config/db.js";

const SOURCES = `
  SELECT c.patient_id, TRIM(c.mo_name) AS mo_name, c.visit_date AS seen_date, 0 AS src_rank
    FROM consultations c
   WHERE c.patient_id = ANY($1::int[]) AND NULLIF(TRIM(c.mo_name), '') IS NOT NULL
  UNION ALL
  SELECT v.patient_db_id, TRIM(fs.assigned_staff_name), v.visit_date, 1
    FROM flow_visit_steps fs
    JOIN flow_visits v ON v.id = fs.visit_id
   WHERE v.patient_db_id = ANY($1::int[]) AND fs.assigned_role = 'mo'
     AND fs.status = 'completed' AND NULLIF(TRIM(fs.assigned_staff_name), '') IS NOT NULL
  UNION ALL
  SELECT a.patient_id, TRIM(a.assigned_mo), a.appointment_date, 2
    FROM appointments a
   WHERE a.patient_id = ANY($1::int[]) AND NULLIF(TRIM(a.assigned_mo), '') IS NOT NULL`;

const ROUTE_SQL = `
  SELECT DISTINCT ON (patient_id) patient_id, mo_name, seen_date
    FROM (${SOURCES}) s
   ORDER BY patient_id, seen_date DESC NULLS LAST, src_rank`;

try {
  const { rows: all } = await pool.query(
    `SELECT DISTINCT patient_id FROM consultations
      WHERE patient_id IS NOT NULL AND NULLIF(TRIM(mo_name),'') IS NOT NULL
      UNION
     SELECT DISTINCT v.patient_db_id FROM flow_visit_steps fs
       JOIN flow_visits v ON v.id = fs.visit_id
      WHERE v.patient_db_id IS NOT NULL AND fs.assigned_role='mo'
        AND fs.status='completed' AND NULLIF(TRIM(fs.assigned_staff_name),'') IS NOT NULL
      UNION
     SELECT DISTINCT patient_id FROM appointments
      WHERE patient_id IS NOT NULL AND NULLIF(TRIM(assigned_mo),'') IS NOT NULL`,
  );
  const ids = all.map((r) => r.patient_id);
  console.log(`patients with an MO on record: ${ids.length}`);
  if (!ids.length) throw new Error("no MO data at all — nothing to verify");

  const { rows: picked } = await pool.query(ROUTE_SQL, [ids]);

  const { rows: truth } = await pool.query(
    `SELECT patient_id, MAX(seen_date) AS latest FROM (${SOURCES}) s GROUP BY 1`,
    [ids],
  );
  const latest = new Map(truth.map((r) => [r.patient_id, String(r.latest).slice(0, 10)]));

  let wrong = 0;
  let blank = 0;
  for (const p of picked) {
    if (!p.mo_name) blank++;
    if (String(p.seen_date).slice(0, 10) !== latest.get(p.patient_id)) wrong++;
  }
  if (picked.length !== ids.length)
    throw new Error(`returned ${picked.length} of ${ids.length} patients`);
  if (blank) throw new Error(`${blank} rows carry a blank MO name`);
  if (wrong) throw new Error(`${wrong} patients did not get their latest MO-bearing visit`);

  const multi = await pool.query(
    `SELECT COUNT(*)::int n FROM (
       SELECT patient_id FROM consultations
        WHERE patient_id = ANY($1::int[]) AND NULLIF(TRIM(mo_name),'') IS NOT NULL
        GROUP BY 1 HAVING COUNT(DISTINCT visit_date) > 1) t`,
    [ids],
  );
  const contrib = await pool.query(
    `SELECT src_rank, COUNT(*)::int rows, COUNT(DISTINCT patient_id)::int patients
       FROM (${SOURCES}) s GROUP BY 1 ORDER BY 1`,
    [ids],
  );
  const LABEL = ["consultations.mo_name", "flow MO step", "appointments.assigned_mo"];
  console.log("\nsource contribution:");
  for (let i = 0; i < LABEL.length; i++) {
    const row = contrib.rows.find((r) => r.src_rank === i);
    console.log(
      `  ${LABEL[i].padEnd(26)} ${row ? `${row.rows} rows / ${row.patients} patients` : "0 — contributes nothing"}`,
    );
  }

  console.log(`\nall ${picked.length} resolved to their latest MO-bearing visit`);
  console.log(`of which ${multi.rows[0].n} have several, so the ordering is exercised`);
  console.log("\nOK");
} catch (e) {
  console.error("FAILED:", e.message || e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
