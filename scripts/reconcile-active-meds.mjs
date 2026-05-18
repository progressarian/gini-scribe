#!/usr/bin/env node
// ============================================================================
// reconcile-active-meds.mjs
//
// Re-applies the "latest HealthRay prescription is the source of truth" rule
// for a given patient (by file_no). Symptom this fixes: active medications
// list contains rows from prior visits that the most recent prescription does
// not include — usually because stopStaleHealthrayMeds was previously skipped
// or ran for an older appointment.
//
// What it does:
//   1. Looks up the patient by file_no.
//   2. Finds the latest appointment with a non-empty healthray_medications
//      JSONB array.
//   3. Calls syncMedications() (to re-tag the current meds) followed by
//      stopStaleHealthrayMeds() (to deactivate everything else from
//      source='healthray').
//
// Usage:
//   node scripts/reconcile-active-meds.mjs P_178701
//   node scripts/reconcile-active-meds.mjs P_178701 P_180001 P_180042
//   node scripts/reconcile-active-meds.mjs --dry P_178701
//
// Requires DATABASE_URL in server/.env.
// ============================================================================

import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "..", "server", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");
const fileNos = args.filter((a) => !a.startsWith("--"));
if (!fileNos.length) {
  console.error("usage: node scripts/reconcile-active-meds.mjs [--dry] <file_no> [file_no...]");
  process.exit(1);
}

const { syncMedications, stopStaleHealthrayMeds } = await import(
  "../server/services/healthray/db.js"
);
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function reconcileOne(fileNo) {
  const { rows: pts } = await pool.query(
    `SELECT id, file_no, name FROM patients WHERE file_no = $1 LIMIT 1`,
    [fileNo],
  );
  if (!pts.length) {
    console.log(`[${fileNo}] not found, skipping`);
    return;
  }
  const patient = pts[0];

  const { rows: latest } = await pool.query(
    `SELECT healthray_id, appointment_date, healthray_medications
       FROM appointments
      WHERE patient_id = $1
        AND healthray_id IS NOT NULL
        AND jsonb_array_length(COALESCE(healthray_medications, '[]'::jsonb)) > 0
      ORDER BY appointment_date DESC, id DESC
      LIMIT 1`,
    [patient.id],
  );
  if (!latest.length) {
    console.log(`[${fileNo}] no appointment with healthray medications, skipping`);
    return;
  }
  const a = latest[0];
  const meds = Array.isArray(a.healthray_medications) ? a.healthray_medications : [];

  const { rows: before } = await pool.query(
    `SELECT id, name, source, notes, last_prescribed_date
       FROM medications
      WHERE patient_id = $1 AND is_active = true
      ORDER BY source, name`,
    [patient.id],
  );
  console.log(
    `[${fileNo}] ${patient.name} — latest healthray_id=${a.healthray_id}, date=${a.appointment_date.toISOString?.().slice(0, 10) || a.appointment_date}, meds_in_rx=${meds.length}, currently_active=${before.length}`,
  );
  for (const m of before) {
    console.log(`   active  src=${m.source}  ${m.name}  notes=${m.notes || "—"}`);
  }

  if (dryRun) {
    console.log(`[${fileNo}] --dry — no changes written`);
    return;
  }

  await syncMedications(patient.id, a.healthray_id, a.appointment_date, meds);
  await stopStaleHealthrayMeds(patient.id, a.healthray_id, a.appointment_date, meds);

  const { rows: after } = await pool.query(
    `SELECT id, name, source, notes, last_prescribed_date
       FROM medications
      WHERE patient_id = $1 AND is_active = true
      ORDER BY source, name`,
    [patient.id],
  );
  console.log(`[${fileNo}] after reconcile — active=${after.length}`);
  for (const m of after) {
    console.log(`   active  src=${m.source}  ${m.name}  notes=${m.notes || "—"}`);
  }
}

try {
  for (const fn of fileNos) {
    await reconcileOne(fn);
    console.log("");
  }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
