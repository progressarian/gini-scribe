import "../loadEnv.js";
import pool from "../config/db.js";

const ids = [110765, 110128, 110891, 110498];
const v = await pool.query(
  `SELECT v.id, v.appointment_id, v.current_status, v.results_status, v.blocked_reason, v.updated_at
     FROM giniflow_visits v WHERE v.appointment_id = ANY($1) ORDER BY v.appointment_id`,
  [ids],
);
console.table(v.rows);
const e = await pool.query(
  `SELECT v.appointment_id, e.status, e.actor_role, e.occurred_at, e.meta
     FROM giniflow_visit_events e JOIN giniflow_visits v ON v.id = e.visit_id
    WHERE v.appointment_id = ANY($1) ORDER BY v.appointment_id, e.occurred_at`,
  [ids],
);
for (const r of e.rows)
  console.log(
    r.appointment_id,
    r.occurred_at.toISOString().slice(11, 19),
    r.status,
    r.actor_role,
    JSON.stringify(r.meta).slice(0, 140),
  );
await pool.end();
