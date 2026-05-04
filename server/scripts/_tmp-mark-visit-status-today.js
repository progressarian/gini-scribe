/**
 * One-shot: re-stamp visit_status (current/previous) on every patient
 * who has an appointment today, then push the result to Genie.
 *
 * Run: node server/scripts/_tmp-mark-visit-status-today.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { markMedicationVisitStatus } = await import(
  "../services/medication/visitStatus.js"
);
const require = createRequire(import.meta.url);
const { syncMedicationsToGenie } = require("../genie-sync.cjs");

const { rows } = await pool.query(`
  SELECT DISTINCT patient_id
    FROM appointments
   WHERE appointment_date::date = CURRENT_DATE
     AND patient_id IS NOT NULL
   ORDER BY patient_id
`);
console.log(`Patients with an appointment today: ${rows.length}`);

let stamped = 0;
let pushed = 0;
let errors = 0;
let processed = 0;
const total = rows.length;
const startedAt = Date.now();

for (const r of rows) {
  const pid = r.patient_id;
  try {
    await markMedicationVisitStatus(pid, pool);
    stamped++;
  } catch (e) {
    errors++;
    console.warn(`[mark ${pid}] ${e.message}`);
    processed++;
    continue;
  }
  try {
    const res = await syncMedicationsToGenie(pid, pool);
    pushed += res?.pushed || 0;
    if (res?.errors?.length) errors += res.errors.length;
  } catch (e) {
    errors++;
    console.warn(`[push ${pid}] ${e.message}`);
  }
  processed++;
  if (processed % 25 === 0 || processed === total) {
    const sec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    console.log(
      `[${processed}/${total}] last_pid=${pid} stamped=${stamped} pushed=${pushed} errors=${errors} elapsed=${sec}s`,
    );
  }
}

console.log(
  `Done. patients=${total} stamped=${stamped} medsPushedToGenie=${pushed} errors=${errors}`,
);
await pool.end();
