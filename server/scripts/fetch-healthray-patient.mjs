import "../loadEnv.js";
import pool from "../config/db.js";
import { fetchHealthrayPatientByUhid } from "../services/healthray/patientImport.js";

const uhid = process.argv[2];
if (!uhid) {
  console.error("Usage: node scripts/fetch-healthray-patient.mjs P_123456");
  process.exit(1);
}
try {
  const result = await fetchHealthrayPatientByUhid(uhid);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e.healthrayBlocked ? `Blocked: ${e.message}` : `Failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
