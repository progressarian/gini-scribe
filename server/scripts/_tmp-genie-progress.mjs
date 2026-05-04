import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });
const { default: pool } = await import("../config/db.js");

// Count genie med rows touched today (heuristic for backfill progress)
const cols = await pool.query(`
  SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='patient_medications_genie'
   ORDER BY ordinal_position`);
console.log("genie table cols:", cols.rows.map(r=>r.column_name));

// pick the timestamp column dynamically
const tsCol = cols.rows.map(r=>r.column_name).find(c => c.includes("updated") || c === "synced_at" || c === "last_synced_at" || c === "created_at");
console.log("ts col:", tsCol);

if (tsCol) {
  const r = await pool.query(`SELECT COUNT(DISTINCT patient_id) AS patients_touched_today FROM patient_medications_genie WHERE ${tsCol} >= CURRENT_DATE`);
  console.log(r.rows[0]);
}

await pool.end();
