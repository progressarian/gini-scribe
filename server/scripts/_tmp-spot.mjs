import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });
const { default: pool } = await import("../config/db.js");

// Check a sample patient (1453) to see if their meds got re-attached
const r = await pool.query(
  `SELECT consultation_id, COUNT(*) AS n
     FROM medications
    WHERE patient_id = 1453
      AND notes LIKE 'healthray:%'
    GROUP BY consultation_id
    ORDER BY consultation_id`,
);
console.log("Patient 1453 healthray meds by consultation_id:");
for (const row of r.rows) console.log(" ", row);

const r2 = await pool.query(
  `SELECT updated_at FROM medications
    WHERE patient_id = 1453 AND notes LIKE 'healthray:%'
    ORDER BY updated_at DESC LIMIT 3`,
);
console.log("\nMost recent updated_at on patient 1453's healthray meds:");
for (const row of r2.rows) console.log(" ", row.updated_at);

await pool.end();
