/**
 * Second-pass repair for P_176425: re-attach medications based on the doctor's
 * curated list (`consultations.con_data.medications_confirmed`) rather than
 * the HealthRay PDF extraction.
 *
 * Why: HealthRay's PDF parse for the 2026-02-03 prescription only returned 4
 * meds, but the doctor actually confirmed 6 (RYZODEG, SIAGLIDE M, GLIZID M XR,
 * CTD T AM, ATCHOL, RACAL D) in consultation 17999. The previous repair
 * tied GLIZID M XR + ATCHOL to consult 9664 (2025-08-18) because that's where
 * HealthRay last extracted them — so the visit-page reconcile correctly
 * (but unhelpfully) demoted them to "Previous visit".
 *
 * Strategy:
 *   1) Walk every consult for the patient where con_data.medications_confirmed
 *      is non-empty AND its size is small enough to be a doctor-curated list
 *      (heuristic: <= 8 entries; the auto-snapshot consults have 17).
 *   2) For each named med in that list, find its canonical match in the
 *      `medications` table.
 *   3) For each med, attach it to the consult with the LATEST visit_date that
 *      includes it. Set last_prescribed_date = that visit_date. Reactivate
 *      if it was stopped today by reconcile.
 *
 * Run dry: node server/scripts/fix-p176425-from-confirmed.js
 * Apply:   node server/scripts/fix-p176425-from-confirmed.js --apply
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
const PATIENT_ID = 1430;
const SMALL_LIST_THRESHOLD = 10;

const consults = await pool.query(
  `SELECT id, visit_date,
          con_data->'medications_confirmed' AS confirmed
     FROM consultations
    WHERE patient_id = $1
      AND con_data ? 'medications_confirmed'
    ORDER BY visit_date DESC, id ASC`,
  [PATIENT_ID],
);

// Use only the LATEST doctor-curated list (size <= threshold). The 17-meds
// consults are auto-snapshots from markAppointmentAsSeen and not authoritative.
let latestConsult = null;
for (const c of consults.rows) {
  const list = Array.isArray(c.confirmed) ? c.confirmed : [];
  if (list.length === 0 || list.length > SMALL_LIST_THRESHOLD) continue;
  latestConsult = c;
  break;
}
const latestByCanon = new Map();
if (latestConsult) {
  for (const m of latestConsult.confirmed) {
    if (!m?.name) continue;
    const { name: clean } = stripFormPrefix(m.name);
    const canon = canonicalMedKey(clean || m.name).slice(0, 200);
    if (!canon) continue;
    latestByCanon.set(canon, {
      consultation_id: latestConsult.id,
      visit_date: latestConsult.visit_date,
      name: m.name,
    });
  }
}
console.log(`Latest doctor-curated consult: ${latestConsult?.id} (${latestConsult?.visit_date})`);
console.log(`Doctor-confirmed canonical names → latest consult (${latestByCanon.size}):`);
for (const [canon, v] of latestByCanon.entries()) {
  console.log(`  ${canon}  →  consult ${v.consultation_id} (${v.visit_date})  via "${v.name}"`);
}

// For each med in medications, find its canonical and the target consult
const meds = await pool.query(
  `SELECT id, name, pharmacy_match, dose, consultation_id, is_active, visit_status,
          last_prescribed_date, stopped_date, stop_reason, notes
     FROM medications
    WHERE patient_id = $1
    ORDER BY name`,
  [PATIENT_ID],
);

const plan = [];
for (const m of meds.rows) {
  const canonRaw = m.pharmacy_match || canonicalMedKey(stripFormPrefix(m.name).name || m.name);
  const canon = String(canonRaw).toUpperCase().slice(0, 200);
  const target =
    latestByCanon.get(canon) ||
    latestByCanon.get(canon.toLowerCase()) ||
    [...latestByCanon.entries()].find(([k]) => k.toUpperCase() === canon)?.[1];
  if (!target) continue;
  const needsConsult = m.consultation_id !== target.consultation_id;
  const needsLpd = !m.last_prescribed_date || m.last_prescribed_date < target.visit_date;
  const needsActivate =
    !m.is_active &&
    m.stop_reason === "Previous visit" &&
    m.stopped_date &&
    new Date(m.stopped_date).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  if (needsConsult || needsLpd || needsActivate) {
    plan.push({
      id: m.id,
      name: m.name,
      dose: m.dose,
      target,
      needsConsult,
      needsLpd,
      needsActivate,
    });
  }
}
console.log(`\nPlanned changes (${plan.length}):`);
for (const p of plan) {
  const tags = [];
  if (p.needsConsult) tags.push(`→ consult ${p.target.consultation_id}`);
  if (p.needsLpd) tags.push(`lpd → ${p.target.visit_date}`);
  if (p.needsActivate) tags.push("reactivate");
  console.log(`  [${p.id}] ${p.name}${p.dose ? " " + p.dose : ""}  ${tags.join(", ")}`);
}

if (!APPLY) {
  console.log("\n[dry-run] pass --apply to write changes.");
  await pool.end();
  process.exit(0);
}

let consultUpd = 0;
let lpdUpd = 0;
let reactUpd = 0;
for (const p of plan) {
  if (p.needsConsult) {
    const r = await pool.query(
      `UPDATE medications SET consultation_id = $1, updated_at = NOW() WHERE id = $2`,
      [p.target.consultation_id, p.id],
    );
    consultUpd += r.rowCount;
  }
  if (p.needsLpd) {
    const r = await pool.query(
      `UPDATE medications SET last_prescribed_date = $1::date, updated_at = NOW()
        WHERE id = $2 AND ($1::date > COALESCE(last_prescribed_date, '1900-01-01'::date))`,
      [p.target.visit_date, p.id],
    );
    lpdUpd += r.rowCount;
  }
  if (p.needsActivate) {
    const r = await pool.query(
      `UPDATE medications
          SET is_active = true, stopped_date = NULL, stop_reason = NULL, updated_at = NOW()
        WHERE id = $1`,
      [p.id],
    );
    reactUpd += r.rowCount;
  }
}
console.log(
  `\nApplied: consultation_id=${consultUpd}, last_prescribed_date=${lpdUpd}, reactivated=${reactUpd}`,
);

await markMedicationVisitStatus(PATIENT_ID, pool);
console.log("visit_status refreshed.");

console.log("\nPushing to Genie…");
const res = await syncMedicationsToGenie(PATIENT_ID, pool);
console.log(
  `  pushed=${res?.pushed || 0} total=${res?.total || 0} errors=${res?.errors?.length || 0}`,
);

await pool.end();
