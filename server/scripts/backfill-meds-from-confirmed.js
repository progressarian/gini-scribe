/**
 * Cross-patient: ensure every medication named in each patient's LATEST
 * doctor-curated `consultations.con_data.medications_confirmed` list is
 * attached to that consultation with `last_prescribed_date = visit_date`.
 *
 * Why this is needed AFTER the appointment_date-based backfill:
 *   HealthRay's PDF parse can miss meds the doctor actually continued. The
 *   doctor-curated medications_confirmed list (size small enough to NOT be
 *   the auto-snapshot from markAppointmentAsSeen) is the source of truth for
 *   "what the doctor approved at this visit."
 *
 * Heuristic: a "doctor-curated" list has <= 10 entries. The auto-snapshot
 * lists tend to be 15+ (every active med in the table). Real prescriptions
 * are typically 4–8 meds.
 *
 * For each patient, the LATEST consult with a doctor-curated list is what
 * we trust. Each named med:
 *   - is re-attached to that consult
 *   - has last_prescribed_date bumped to that consult's visit_date (only if
 *     newer)
 *   - is reactivated IF it was stopped today by reconcile
 *     (stop_reason='Previous visit', stopped_date=CURRENT_DATE)
 *
 * Other meds are left alone — if they're stopped, they should stay stopped.
 *
 * Run dry: node server/scripts/backfill-meds-from-confirmed.js
 * Apply:   node server/scripts/backfill-meds-from-confirmed.js --apply
 * Skip Genie push: add --no-push
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { markMedicationVisitStatus } = await import("../services/medication/visitStatus.js");
const { canonicalMedKey, stripFormPrefix } = await import("../services/medication/normalize.js");
const require = createRequire(import.meta.url);
const { syncMedicationsToGenie } = require("../genie-sync.cjs");

const APPLY = process.argv.includes("--apply");
const NO_PUSH = process.argv.includes("--no-push");
const SMALL_LIST_THRESHOLD = 10;

console.log(`Mode: ${APPLY ? "APPLY" : "dry-run"}${NO_PUSH ? " (no Genie push)" : ""}`);

const t0 = Date.now();

// Pull every patient's latest small doctor-curated consult, plus its meds list
console.log("Loading consultations…");
const consults = await pool.query(`
  SELECT id, patient_id, visit_date, con_data->'medications_confirmed' AS confirmed
    FROM consultations
   WHERE con_data ? 'medications_confirmed'
     AND jsonb_typeof(con_data->'medications_confirmed') = 'array'
     AND jsonb_array_length(con_data->'medications_confirmed') BETWEEN 1 AND ${SMALL_LIST_THRESHOLD}
   ORDER BY patient_id, visit_date DESC, id ASC
`);
console.log(
  `  ${consults.rowCount} doctor-curated consultations loaded in ${Math.round((Date.now() - t0) / 1000)}s`,
);

// For each patient, pick the latest. Build canonical name → target.
const latestByPatient = new Map();
for (const c of consults.rows) {
  if (!latestByPatient.has(c.patient_id)) {
    latestByPatient.set(c.patient_id, c);
  }
}

// Build (patient_id, canon) → { consult_id, visit_date }
const targetMap = new Map(); // key: pid|canon
for (const [pid, c] of latestByPatient.entries()) {
  for (const m of c.confirmed) {
    if (!m?.name) continue;
    const { name: clean } = stripFormPrefix(m.name);
    const canon = canonicalMedKey(clean || m.name)
      .slice(0, 200)
      .toUpperCase();
    if (!canon) continue;
    targetMap.set(`${pid}|${canon}`, {
      consultation_id: c.id,
      visit_date: c.visit_date,
    });
  }
}
console.log(`Targets built: ${targetMap.size} (patient, canonical-name) pairs`);

// Pull all medications for those patients and compute per-row plan
console.log("Loading medications for impacted patients…");
const pids = [...latestByPatient.keys()];
const meds = await pool.query(
  `SELECT id, patient_id, name, pharmacy_match, dose, consultation_id,
          is_active, last_prescribed_date, stopped_date, stop_reason
     FROM medications
    WHERE patient_id = ANY($1::int[])`,
  [pids],
);
console.log(`  ${meds.rowCount} medication rows`);

const today = new Date().toISOString().slice(0, 10);

let needConsult = 0;
let needLpd = 0;
let needReact = 0;
const consultUpdates = []; // [{med_id, consult_id}]
const lpdUpdates = []; // [{med_id, visit_date}]
const reactIds = [];

for (const m of meds.rows) {
  const canonRaw = m.pharmacy_match || canonicalMedKey(stripFormPrefix(m.name).name || m.name);
  const canon = String(canonRaw || "")
    .toUpperCase()
    .slice(0, 200);
  if (!canon) continue;
  const target = targetMap.get(`${m.patient_id}|${canon}`);
  if (!target) continue;

  if (m.consultation_id !== target.consultation_id) {
    consultUpdates.push({ med_id: m.id, consult_id: target.consultation_id });
    needConsult++;
  }
  const curLpd = m.last_prescribed_date
    ? new Date(m.last_prescribed_date).toISOString().slice(0, 10)
    : null;
  const tgtLpd = new Date(target.visit_date).toISOString().slice(0, 10);
  if (!curLpd || curLpd < tgtLpd) {
    lpdUpdates.push({ med_id: m.id, visit_date: tgtLpd });
    needLpd++;
  }
  const stoppedToday = m.stopped_date
    ? new Date(m.stopped_date).toISOString().slice(0, 10) === today
    : false;
  if (!m.is_active && m.stop_reason === "Previous visit" && stoppedToday) {
    reactIds.push(m.id);
    needReact++;
  }
}

console.log("\nPlanned changes:");
console.log(`  consultation_id updates: ${needConsult}`);
console.log(`  last_prescribed_date bumps: ${needLpd}`);
console.log(`  reactivations (stopped today by reconcile): ${needReact}`);
console.log(`  patients impacted: ${latestByPatient.size}`);

if (!APPLY) {
  console.log("\n[dry-run] pass --apply to write changes.");
  await pool.end();
  process.exit(0);
}

// Apply in chunks. Group consult updates by target consult_id so each UPDATE
// is one statement per target.
console.log("\nApplying consultation_id updates…");
const t1 = Date.now();
const byConsult = new Map();
for (const u of consultUpdates) {
  if (!byConsult.has(u.consult_id)) byConsult.set(u.consult_id, []);
  byConsult.get(u.consult_id).push(u.med_id);
}
let cu = 0;
for (const [cid, ids] of byConsult.entries()) {
  const r = await pool.query(
    `UPDATE medications SET consultation_id = $1, updated_at = NOW()
      WHERE id = ANY($2::int[])`,
    [cid, ids],
  );
  cu += r.rowCount;
}
console.log(`  updated ${cu} rows in ${Math.round((Date.now() - t1) / 1000)}s`);

console.log("\nApplying last_prescribed_date bumps…");
const t2 = Date.now();
const byDate = new Map();
for (const u of lpdUpdates) {
  if (!byDate.has(u.visit_date)) byDate.set(u.visit_date, []);
  byDate.get(u.visit_date).push(u.med_id);
}
let lu = 0;
for (const [d, ids] of byDate.entries()) {
  const r = await pool.query(
    `UPDATE medications SET last_prescribed_date = $1::date, updated_at = NOW()
      WHERE id = ANY($2::int[])
        AND $1::date > COALESCE(last_prescribed_date, '1900-01-01'::date)`,
    [d, ids],
  );
  lu += r.rowCount;
}
console.log(`  updated ${lu} rows in ${Math.round((Date.now() - t2) / 1000)}s`);

console.log("\nReactivating rows stopped today by reconcile…");
const t3 = Date.now();
let ru = 0;
if (reactIds.length) {
  const r = await pool.query(
    `UPDATE medications
        SET is_active = true, stopped_date = NULL, stop_reason = NULL, updated_at = NOW()
      WHERE id = ANY($1::int[])`,
    [reactIds],
  );
  ru = r.rowCount;
}
console.log(`  reactivated ${ru} rows in ${Math.round((Date.now() - t3) / 1000)}s`);

const impacted = new Set([
  ...consultUpdates
    .map((u) => meds.rows.find((m) => m.id === u.med_id)?.patient_id)
    .filter(Boolean),
  ...lpdUpdates.map((u) => meds.rows.find((m) => m.id === u.med_id)?.patient_id).filter(Boolean),
  ...reactIds.map((id) => meds.rows.find((m) => m.id === id)?.patient_id).filter(Boolean),
]);
console.log(`\nUnique patients touched: ${impacted.size}`);

console.log("\nRefreshing visit_status per patient…");
const t4 = Date.now();
let i = 0;
for (const pid of impacted) {
  await markMedicationVisitStatus(pid, pool);
  if (++i % 200 === 0) console.log(`  visit_status: ${i}/${impacted.size}`);
}
console.log(`  done in ${Math.round((Date.now() - t4) / 1000)}s`);

if (NO_PUSH) {
  console.log("\nGenie push skipped (--no-push).");
} else {
  console.log("\nPushing to Genie (concurrency=4)…");
  const t5 = Date.now();
  const ids = [...impacted];
  const concurrency = 4;
  let cursor = 0;
  let pushed = 0;
  let errors = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= ids.length) return;
      const pid = ids[idx];
      try {
        await syncMedicationsToGenie(pid, pool);
        pushed++;
      } catch (e) {
        errors++;
        console.warn(`  push failed for patient ${pid}: ${e.message}`);
      }
      if ((pushed + errors) % 200 === 0) {
        console.log(`  genie push: ${pushed + errors}/${ids.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`  pushed ${pushed} (errors ${errors}) in ${Math.round((Date.now() - t5) / 1000)}s`);
}

await pool.end();
console.log("\nDone.");
