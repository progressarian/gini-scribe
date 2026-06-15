// Seed (or clear) demo patients in the Patient Flow module so the Coordinator
// dashboard (/flow/coordinator), the Lab queue (/lab-requests → Live Lab Queue),
// and the station views show realistic data for testing.
//
// Usage (from gini-scribe/server):
//   node scripts/seed-flow-demo.mjs          # clear old demo + seed fresh
//   node scripts/seed-flow-demo.mjs --clean  # just remove demo data
//
// Shares its logic with the admin "Seed demo" button (services/flow/demo.js).
// All rows use patient_id 'DEMO_*' for exact cleanup.
import "../loadEnv.js";
import pool from "../config/db.js";
import { seedFlowDemo, cleanFlowDemo } from "../services/flow/demo.js";

try {
  if (process.argv.includes("--clean")) {
    const n = await cleanFlowDemo();
    console.log(`Removed ${n} demo visit(s).`);
  } else {
    const n = await seedFlowDemo();
    console.log(`Seeded ${n} demo patient(s).`);
    console.log("Open /flow/coordinator (dashboard) and /lab-requests → Live Lab Queue.");
    console.log("Clean up later with:  node scripts/seed-flow-demo.mjs --clean");
  }
} catch (e) {
  console.error("Seed error:", e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
