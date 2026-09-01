// Fill every Gini Flow station screen with a demo day, for a walkthrough.
//
//   node scripts/giniflow-seed-demo.mjs          seed today's floor + tomorrow's triage
//   node scripts/giniflow-seed-demo.mjs clean    remove every row it wrote
//
// It seeds TODAY's floor (which is what the board, vitals, reception, lab,
// MO/SD, consultant and pharmacy queues all read) and TOMORROW's triage list.
// Everything it writes belongs to patients it creates itself, named "Demo …"
// with a ZZDEMO_ file number, and `clean` removes all of it.
//
// ⚠ .env points at PRODUCTION. These rows appear on the real floor board until
// they are cleaned, which is why both entry points refuse to run without
// GINIFLOW_ALLOW_DEMO=1.
import "../loadEnv.js";
import pool from "../config/db.js";
import { seedDemoDay, cleanDemoDay } from "../services/giniflow/demo.js";

const mode = process.argv[2] === "clean" ? "clean" : "seed";

try {
  if (mode === "clean") {
    const r = await cleanDemoDay();
    console.log(`Removed ${r.deleted} demo visits and ${r.demoPatientsRemoved} demo patients.`);
  } else {
    const r = await seedDemoDay({});
    console.log(`Floor:  ${r.visits} visits · ${r.events} events · ${r.labOrders} lab orders`);
    console.log(`Charts: ${r.consults} consult screens — labs, diagnoses, medicines, MO plan`);
    console.log(
      `Triage: ${r.triage.appointments} appointments for ${r.triage.date} · ${r.triage.categorised} categorised`,
    );
    if (r.skipped?.length) console.log(`Skipped: ${r.note}`);
    console.log("\nClean up with:  node scripts/giniflow-seed-demo.mjs clean");
  }
} catch (e) {
  console.error(`${mode} failed: ${e.message}`);
  process.exitCode = 1;
}

await pool.end();
