import "../loadEnv.js";
import pool from "../config/db.js";
import { getLabQueue } from "../services/giniflow/labStation.js";
const { rows: d } = await pool.query(
  `SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
          to_char(NOW() AT TIME ZONE 'Asia/Kolkata','HH24:MI') AS now_ist`,
);
const q = await getLabQueue(d[0].day, null, pool);
console.log(`\n## Lab screen — ${d[0].day} at ${d[0].now_ist}`);
console.log(`HealthRay-listed patients: ${q.healthray.length}`);
console.log(`Scribe orders: ${q.unified.length - q.healthray.length}`);
console.log(`Total rows on the screen: ${q.unified.length}`);
console.table(
  q.healthray.slice(0, 8).map((h) => ({
    name: h.name,
    tests: (h.tests || []).slice(0, 3).join(", "),
    stage: h.stage?.label,
    next_step_offered: h.caseList?.[0]?.nextAction?.label || "—",
  })),
);
await pool.end();
