import "../loadEnv.js";
import pool from "../config/db.js";
import { CRON_LOCK_KEYS } from "../services/cron/lowPriority.js";

const names = Object.fromEntries(Object.entries(CRON_LOCK_KEYS).map(([k, v]) => [v, k]));
const { rows } = await pool.query(
  `SELECT l.objid::bigint AS key, l.pid, s.state, s.backend_start, s.state_change,
          left(s.query, 80) AS last_query
     FROM pg_locks l LEFT JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE l.locktype = 'advisory' ORDER BY l.objid`,
);
const ist = (d) => (d ? new Date(d).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }) : null);
console.log("now", ist(new Date()));
for (const r of rows)
  console.log(names[r.key] || r.key, "pid", r.pid, r.state, "backend_start", ist(r.backend_start), "idle since", ist(r.state_change), "|", r.last_query);
const kv = await pool.query(`SELECT key, value, updated_at FROM app_kv WHERE key LIKE 'cron_lease:%'`);
console.log("leases:", kv.rows);
await pool.end();
