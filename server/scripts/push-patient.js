/**
 * One-shot: push all scribe→Genie data for one patient (labs, meds, diagnoses,
 * documents, appointment, care team).
 *
 * Run: node server/scripts/push-patient.js <scribe-patient-id>
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const {
  syncLabsToGenie,
  syncMedicationsToGenie,
  syncDiagnosesToGenie,
  syncDocumentsToGenie,
  syncAppointmentToGenie,
  syncCareTeamToGenie,
} = require("../genie-sync.cjs");

const PID = parseInt(process.argv[2] || "16644", 10);
console.log(`Pushing scribe→Genie for patient ${PID}`);

const tasks = {
  labs: () => syncLabsToGenie(PID, pool),
  medications: () => syncMedicationsToGenie(PID, pool),
  diagnoses: () => syncDiagnosesToGenie(PID, pool),
  documents: () => syncDocumentsToGenie(PID, pool),
  appointment: () => syncAppointmentToGenie(PID, pool),
  careTeam: () => syncCareTeamToGenie(PID, pool),
};

for (const [name, fn] of Object.entries(tasks)) {
  try {
    const r = await fn();
    console.log(`  ${name}: ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`  ${name}: ERROR ${e.message}`);
  }
}

await pool.end();
