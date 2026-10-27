import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 100;

const CANDIDATES = `
  WITH latest AS (
    SELECT DISTINCT ON (v.executive_id, v.doctor_id)
           v.id, v.hospital_id, v.executive_id, v.doctor_id, v.occurred_at, v.next_visit_date,
           v.follow_up_required
      FROM crm.visits v
     WHERE v.deleted_at IS NULL
     ORDER BY v.executive_id, v.doctor_id, v.occurred_at DESC, v.id DESC
  )
  SELECT l.id AS visit_id, l.hospital_id, l.executive_id, l.doctor_id, l.occurred_at,
         l.next_visit_date, d.full_name
    FROM latest l
    JOIN crm.doctors d ON d.id = l.doctor_id AND d.deleted_at IS NULL AND d.is_active
    JOIN crm.doctor_assignments a ON a.doctor_id = l.doctor_id AND a.effective_to IS NULL
                                 AND a.executive_id = l.executive_id
   WHERE l.next_visit_date IS NOT NULL AND l.follow_up_required
     AND NOT EXISTS (SELECT 1 FROM crm.tasks t
                      WHERE t.kind = 'follow_up_visit' AND t.deleted_at IS NULL
                        AND (t.visit_id = l.id
                             OR (t.status IN ('open', 'in_progress')
                                 AND t.owner_id = l.executive_id AND t.doctor_id = l.doctor_id)))`;

const INSERT = `
  INSERT INTO crm.tasks
    (hospital_id, title, owner_id, doctor_id, visit_id, due_date, kind, created_by, created_at)
  SELECT x.hospital_id, 'Visit ' || x.full_name, x.executive_id, x.doctor_id, x.visit_id,
         x.next_visit_date, 'follow_up_visit', x.executive_id, x.occurred_at
    FROM jsonb_to_recordset($1::jsonb) AS x(
           visit_id uuid, hospital_id uuid, executive_id uuid, doctor_id uuid,
           occurred_at timestamptz, next_visit_date date, full_name text)
  ON CONFLICT DO NOTHING`;

const { rows: summary } = await pool.query(
  `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE next_visit_date < (now() AT TIME ZONE 'Asia/Kolkata')::date - 30)::int AS overdue_over_30_days,
          count(*) FILTER (WHERE next_visit_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
                             AND next_visit_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 30)::int AS overdue_up_to_30_days,
          count(*) FILTER (WHERE next_visit_date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS due_today,
          count(*) FILTER (WHERE next_visit_date > (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS upcoming
     FROM (${CANDIDATES}) c`,
);
console.log("follow-up tasks to create:", summary[0]);

const { rows: byRep } = await pool.query(
  `SELECT u.full_name AS rep, count(*)::int AS tasks
     FROM (${CANDIDATES}) c JOIN crm.users u ON u.id = c.executive_id
    GROUP BY u.full_name ORDER BY u.full_name`,
);
console.table(byRep);

if (!APPLY) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`${CANDIDATES} ORDER BY next_visit_date LIMIT ${BATCH}`);
    const res = await client.query(INSERT, [JSON.stringify(rows)]);
    console.log(`dry run: first batch would insert ${res.rowCount} task(s); rolled back`);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  console.log("dry run — pass --apply to write");
  await pool.end();
  process.exit(0);
}

let created = 0;
for (let batch = 1; ; batch++) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`${CANDIDATES} ORDER BY next_visit_date LIMIT ${BATCH}`);
    if (!rows.length) {
      await client.query("ROLLBACK");
      break;
    }
    const res = await client.query(INSERT, [JSON.stringify(rows)]);
    await client.query("COMMIT");
    created += res.rowCount;
    console.log(`batch ${batch}: created ${res.rowCount} (total ${created})`);
    if (res.rowCount === 0) break;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`batch ${batch} failed: ${e.message}`);
    process.exitCode = 1;
    break;
  } finally {
    client.release();
  }
}
console.log(`done — ${created} follow-up task(s) created`);
await pool.end();
