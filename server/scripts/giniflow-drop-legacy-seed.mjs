// One-off: remove the first round of Gini Flow demo visits.
//
// Those were seeded before `is_demo` existed and before the seeder created its
// own patients, so they are fabricated visits, categories, vitals and blocked
// reasons attached to REAL patient rows (audit finding GF-03). Nothing else
// writes giniflow_visits yet — there is no check-in — so every row with
// is_demo = false is one of them.
//
// Events and lab orders cascade. Real patient rows themselves are not touched.
//
//   node scripts/giniflow-drop-legacy-seed.mjs          # report only
//   node scripts/giniflow-drop-legacy-seed.mjs --delete # actually delete
import "../loadEnv.js";
import pool from "../config/db.js";

const doDelete = process.argv.includes("--delete");

const { rows: counts } = await pool.query(
  `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE is_demo)::int AS demo,
          count(*) FILTER (WHERE NOT is_demo)::int AS legacy
     FROM giniflow_visits`,
);
console.log("giniflow_visits:", counts[0]);

const { rows: sample } = await pool.query(
  `SELECT p.name, p.file_no FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
    WHERE NOT v.is_demo ORDER BY v.created_at LIMIT 5`,
);
console.log(
  "legacy rows attached to real patients:",
  sample.map((r) => `${r.name} (${r.file_no})`).join(", ") || "none",
);

if (!doDelete) {
  console.log("\nreport only — re-run with --delete to remove the legacy rows");
} else {
  const { rowCount } = await pool.query(`DELETE FROM giniflow_visits WHERE NOT is_demo`);
  const { rows: after } = await pool.query(
    `SELECT (SELECT count(*)::int FROM giniflow_visits) AS visits,
            (SELECT count(*)::int FROM giniflow_visit_events) AS events,
            (SELECT count(*)::int FROM giniflow_lab_orders) AS lab_orders`,
  );
  console.log(`deleted ${rowCount} legacy visits; remaining:`, after[0]);
}

await pool.end();
