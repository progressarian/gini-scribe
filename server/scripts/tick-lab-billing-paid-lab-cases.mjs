import "../loadEnv.js";
import pool from "../config/db.js";
import { syncLabStepsFromLab } from "../services/giniflow/journey.js";

const apply = process.argv.includes("--apply");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = Math.max(0, Number(daysArg?.split("=")[1] ?? 7));

const STUCK_SQL = `
  SELECT v.id, v.visit_date::text AS visit_date, v.current_status, p.file_no, p.name
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    JOIN giniflow_visit_steps s
      ON s.visit_id = v.id AND s.step_catalog_id = 'lab_billing' AND s.status <> 'done'
   WHERE v.visit_date >= CURRENT_DATE - $1::int
     AND NOT EXISTS (SELECT 1 FROM giniflow_lab_orders o
                      WHERE o.visit_id = v.id AND o.urgency = 'today'
                        AND o.sample_status <> 'cancelled')
     AND EXISTS (SELECT 1 FROM bills b
                   JOIN bill_lines l ON l.bill_id = b.id AND l.is_live
                   LEFT JOIN service_items i ON i.id = l.service_item_id
                  WHERE b.visit_id = v.id AND b.status = 'final'
                    AND (l.source = 'lab_case' OR i.kind = 'test'))
   ORDER BY v.visit_date, v.created_at`;

const labBillingStatus = async (client, visitId) => {
  const { rows } = await client.query(
    `SELECT status FROM giniflow_visit_steps WHERE visit_id = $1 AND step_catalog_id = 'lab_billing'`,
    [visitId],
  );
  return rows[0]?.status ?? null;
};

async function repair(visit) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visit.id]);
    await syncLabStepsFromLab(client, visit.id);
    const status = await labBillingStatus(client, visit.id);
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return status === "done";
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const { rows: busy } = await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE state = 'active' AND backend_type = 'client backend'
        AND query NOT ILIKE 'START_REPLICATION%'
        AND now() - query_start > interval '30 seconds'`,
  );
  if (busy[0].n > 0) {
    console.log(`${busy[0].n} queries running over 30s — database looks busy, try again later`);
    return;
  }
  const { rows } = await pool.query(STUCK_SQL, [days]);
  console.log(
    `${apply ? "APPLY" : "DRY RUN"} — ${rows.length} candidate visit(s) in last ${days} day(s)`,
  );
  let fixed = 0;
  let left = 0;
  for (const [i, visit] of rows.entries()) {
    const done = await repair(visit);
    if (done) fixed += 1;
    else left += 1;
    console.log(
      `[${i + 1}/${rows.length}] ${visit.visit_date} ${visit.file_no} ${visit.name} (${visit.current_status}) — ${
        done
          ? apply
            ? "Lab Billing done"
            : "would mark Lab Billing done"
          : "bill not fully paid, left as is"
      }`,
    );
  }
  console.log(`${apply ? "Fixed" : "Would fix"}: ${fixed}, left unpaid: ${left}`);
}

main()
  .catch((e) => {
    console.error("Stopped:", e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
