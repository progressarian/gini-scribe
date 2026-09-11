// Patients the hold is keeping at an un-recorded step, and how far HealthRay has
// moved on without them (39-HYBRID-FLOOR-PLAN.md §5.2).
//
//   node scripts/check-held.mjs
import "../loadEnv.js";
import pool from "../config/db.js";
const { rows } = await pool.query(
  `SELECT v.behind_station AS desk, v.healthray_status AS healthray,
          v.current_status AS scribe, count(*)::int AS patients
     FROM giniflow_visits v
    WHERE v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      AND v.behind_station IS NOT NULL
    GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
);
console.log("\n## Held, by how far HealthRay has moved on");
console.table(rows);
await pool.end();
