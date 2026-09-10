import "../loadEnv.js";
import pool from "../config/db.js";

// Fill medicine_catalog from what the hospital actually prescribes
// (33-PATIENT-SCHEME-PLAN.md D6).
//
// Not from src/medicine_db.json: that file has 990 entries and no prices at all
// (its keys are raw/brand/form/dose/search). The useful list is what has been
// prescribed here, ordered by volume — 9,964 distinct medicines exist, but the
// top 200 cover 80% of prescriptions, so a tariff fills by use rather than by
// alphabet.
//
// Rows are inserted UNPRICED. A seeded zero would be a lie the pharmacy could
// act on; `source='unpriced'` and a NULL price say "we know this medicine,
// nobody has costed it yet", which is what pricing.js reports to the counter.
//
//   node scripts/seed-medicine-catalog.mjs            # dry run, top 200
//   node scripts/seed-medicine-catalog.mjs --apply
//   node scripts/seed-medicine-catalog.mjs --apply --top 500 --days 90

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const APPLY = process.argv.includes("--apply");
const TOP = Math.max(1, Number(arg("--top", 200)) || 200);
const DAYS = Math.max(1, Number(arg("--days", 60)) || 60);

const { rows } = await pool.query(
  `SELECT UPPER(COALESCE(pharmacy_match, name)) AS name, COUNT(*)::int AS times
     FROM medications
    WHERE last_prescribed_date >= CURRENT_DATE - ($1 || ' days')::interval
      AND COALESCE(pharmacy_match, name) IS NOT NULL
    GROUP BY 1
    ORDER BY times DESC, name
    LIMIT $2`,
  [String(DAYS), TOP],
);

const { rows: totalRows } = await pool.query(
  `SELECT COUNT(*)::int AS prescriptions
     FROM medications
    WHERE last_prescribed_date >= CURRENT_DATE - ($1 || ' days')::interval`,
  [String(DAYS)],
);
const total = totalRows[0].prescriptions;
const covered = rows.reduce((n, r) => n + r.times, 0);

console.log(
  `${rows.length} medicines from the last ${DAYS} days — ` +
    `${covered} of ${total} prescriptions (${((covered / total) * 100).toFixed(1)}%)`,
);
console.log(
  "  top 10:",
  rows
    .slice(0, 10)
    .map((r) => `${r.name}(${r.times})`)
    .join(", "),
);

if (!APPLY) {
  console.log("\nDry run. Re-run with --apply to write them.");
  await pool.end();
  process.exit(0);
}

// ON CONFLICT DO NOTHING: re-running must never blank a price an admin has
// since entered, and must never flip `source` back to unpriced.
const { rowCount } = await pool.query(
  `INSERT INTO medicine_catalog (name, price, source)
   SELECT UNNEST($1::text[]), NULL, 'unpriced'
   ON CONFLICT (name) DO NOTHING`,
  [rows.map((r) => r.name)],
);

const { rows: after } = await pool.query(
  `SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE price IS NOT NULL)::int AS priced
     FROM medicine_catalog`,
);
console.log(
  `\ninserted ${rowCount} new; catalogue now ${after[0].total} rows, ${after[0].priced} priced.`,
);
console.log("Prices are entered by an admin — nothing here invents one.");
await pool.end();
