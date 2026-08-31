import "../loadEnv.js";
import pool from "../config/db.js";

const rows = async (sql) => (await pool.query(sql)).rows;

const sla = await rows("SELECT station, budget_minutes FROM giniflow_sla_config ORDER BY display_order");
console.log("sla rows:", sla.length);
console.log("budgets:", sla.map((r) => `${r.station}=${r.budget_minutes}`).join(" "));

const tables = await rows(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name LIKE 'giniflow%' ORDER BY table_name`,
);
console.log("tables:", tables.map((r) => r.table_name).join(", "));

const [dates] = await rows("SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS ist, CURRENT_DATE AS utc");
console.log("IST today:", dates.ist, "| CURRENT_DATE:", dates.utc);

const uniq = await rows(
  "SELECT conname FROM pg_constraint WHERE conname='giniflow_visits_one_per_patient_day'",
);
console.log("one-per-patient-per-day constraint:", uniq.length === 1);

const [old] = await rows(
  "SELECT (SELECT count(*)::int FROM flow_visits) AS visits, (SELECT count(*)::int FROM flow_events) AS events",
);
console.log("old module untouched — flow_visits:", old.visits, "flow_events:", old.events);

await pool.end();
