#!/usr/bin/env node
// One-shot: propagate an appointment's HealthRay status into the Flow tables.
// Usage: node server/scripts/propagate-appt-to-flow.mjs --file P_170730
//        node server/scripts/propagate-appt-to-flow.mjs --appt 12345
//
// Add --vitals to ALSO backfill the Flow "Vitals" step from the synced `vitals`
// table for matched appointments (auto-completes stuck Vitals steps and pulls
// the flow forward, using the same helper the cron sync uses):
//        node server/scripts/propagate-appt-to-flow.mjs --file P_170730 --vitals
//        node server/scripts/propagate-appt-to-flow.mjs --vitals-only --file P_170730

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the server .env so DB credentials exist when this is run from repo root.
const envPath = path.resolve(__dirname, '../.env');
const result = dotenv.config({ path: envPath });
if (result.error) {
  console.warn(`Warning: could not load .env from ${envPath}. ${result.error.message}`);
}

function usage() {
  console.log('Usage: node server/scripts/propagate-appt-to-flow.mjs --file <FILE_NO> | --appt <APPT_ID> [--vitals | --vitals-only] [--db <DATABASE_URL>]');
  console.log('Example: node server/scripts/propagate-appt-to-flow.mjs --file P_170730 --db "postgres://user:pass@host:5432/db"');
  console.log('         node server/scripts/propagate-appt-to-flow.mjs --file P_170730 --vitals   (status + vitals-step backfill)');
  process.exit(1);
}

function verifyDbUrl() {
  let url = process.env.DATABASE_URL;
  if (!url) {
    console.error('ERROR: DATABASE_URL is not set. Please set it in server/.env or export it before running the script.');
    console.error(`Expected path: ${envPath}`);
    process.exit(1);
  }
  if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
    url = url.slice(1, -1);
    process.env.DATABASE_URL = url;
    console.warn('WARNING: Stripped surrounding quotes from DATABASE_URL.');
  }
  if (url.includes(' ')) {
    console.warn('WARNING: DATABASE_URL contains spaces; this may indicate improper shell quoting.');
    console.warn(`DATABASE_URL=${url}`);
  }
}

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--file' && a[i+1]) { out.file = a[i+1]; i++; }
    else if (a[i] === '--appt' && a[i+1]) { out.appt = a[i+1]; i++; }
    else if (a[i] === '--db' && a[i+1]) { out.dbUrl = a[i+1]; i++; }
    else if (a[i] === '--vitals') { out.vitals = true; }
    else if (a[i] === '--vitals-only') { out.vitals = true; out.vitalsOnly = true; }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (!args.file && !args.appt) usage();
  if (args.dbUrl) {
    process.env.DATABASE_URL = args.dbUrl;
  }
  verifyDbUrl();

  const { default: pool } = await import('../config/db.js');
  // Reuse the exact cron helper so the backfill can never drift from live sync.
  // syncFlowVitalsFromOpdColumn reads the appointment's persisted opd_vitals
  // (the authoritative, freshness-stamped "vitals taken today" signal) and
  // propagates it to the Flow vitals step.
  const { syncFlowVitalsFromOpdColumn } = args.vitals
    ? await import('../services/cron/healthraySync.js')
    : {};

  try {
    let appts = [];
    if (args.file) {
      const { rows } = await pool.query(
        `SELECT id, patient_id, status FROM appointments WHERE file_no = $1 ORDER BY appointment_date DESC LIMIT 5`,
        [args.file],
      );
      appts = rows;
      if (!appts.length) {
        console.error('No appointments found for file', args.file);
        process.exit(2);
      }
    } else {
      const { rows } = await pool.query(`SELECT id, patient_id, status FROM appointments WHERE id = $1`, [
        args.appt,
      ]);
      appts = rows;
      if (!appts.length) {
        console.error('No appointment found id', args.appt);
        process.exit(2);
      }
    }

    for (const a of appts) {
      console.log('Propagating appointment', a.id, 'status', a.status);

      // Vitals-step backfill: propagate the appointment's persisted opd_vitals
      // to the Flow "Vitals" step via the same helper the cron uses. The helper
      // applies the freshness gate (_prescriptionDate must match the appointment
      // date) so a stale carry-forward never auto-completes today's step, and is
      // a no-op when the visit has no Vitals step or it's already terminal.
      if (args.vitals) {
        await syncFlowVitalsFromOpdColumn(a.id);
        console.log('Ran flow vitals backfill for appointment', a.id);
      }
      if (args.vitalsOnly) continue;

      // Map appointment status to flow action
      const st = (a.status || '').toLowerCase();
      if (st === 'completed' || st === 'seen') {
        await pool.query(
          `UPDATE flow_visits SET status='completed', actual_completion=COALESCE(actual_completion, NOW()), current_step_id=NULL, updated_at=NOW() WHERE appointment_id=$1 AND status='in_progress'`,
          [a.id],
        );
        await pool.query(
          `UPDATE flow_visit_steps
             SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                 actual_duration_min = COALESCE(actual_duration_min,
                   CASE WHEN started_at IS NOT NULL
                        THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60))::int
                        END)
           WHERE visit_id IN (SELECT id FROM flow_visits WHERE appointment_id=$1) AND status='in_progress'`,
          [a.id],
        );
        await pool.query(
          `UPDATE flow_visit_steps
             SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                 data = COALESCE(data,'{}'::jsonb) || '{"auto_completed":"opd"}'::jsonb
           WHERE visit_id IN (SELECT id FROM flow_visits WHERE appointment_id=$1) AND status IN ('ready','pending')`,
          [a.id],
        );
        console.log('Marked flow visits completed for appointment', a.id);
      } else if (st === 'cancelled' || st === 'no_show') {
        await pool.query(`UPDATE flow_visits SET status='cancelled', updated_at=NOW() WHERE appointment_id=$1 AND status='in_progress'`, [a.id]);
        console.log('Marked flow visits cancelled for appointment', a.id);
      } else if (st === 'in_visit' || st === 'engaged' || st === 'in-progress') {
        // Pull forward to doctor consult step if present
        const { rows: visits } = await pool.query(`SELECT id FROM flow_visits WHERE appointment_id=$1`, [a.id]);
        for (const v of visits) {
          const { rows: steps } = await pool.query(`SELECT * FROM flow_visit_steps WHERE visit_id=$1 ORDER BY step_order ASC`, [v.id]);
          const doc = steps.find(s => (s.assigned_role === 'sd' || s.assigned_role === 'chief') && !['completed','skipped'].includes(s.status));
          if (doc) {
            const pastDoctor = steps.some(s => s.step_order > doc.step_order && ['in_progress','completed'].includes(s.status));
            if (doc.status !== 'in_progress' && !pastDoctor) {
              await pool.query(
                `UPDATE flow_visit_steps
                   SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                       actual_duration_min = COALESCE(actual_duration_min,
                         CASE WHEN started_at IS NOT NULL
                              THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) / 60))::int
                              END)
                 WHERE visit_id=$1 AND step_order < $2 AND status='in_progress'`,
                [v.id, doc.step_order],
              );
              await pool.query(
                `UPDATE flow_visit_steps
                   SET status='completed', completed_at=COALESCE(completed_at, NOW()),
                       data = COALESCE(data,'{}'::jsonb) || '{"auto_completed":"opd"}'::jsonb
                 WHERE visit_id=$1 AND step_order < $2 AND status IN ('ready','pending')`,
                [v.id, doc.step_order],
              );
              await pool.query(`UPDATE flow_visit_steps SET status='in_progress', started_at=COALESCE(started_at, NOW()) WHERE id=$1`, [doc.id]);
              await pool.query(`UPDATE flow_visits SET current_step_id=$2, current_step_order=$3, updated_at=NOW() WHERE id=$1`, [v.id, doc.id, doc.step_order]);
              console.log('Advanced flow for visit', v.id, 'to doctor step', doc.id);
            }
          }
        }
      } else {
        console.log('No action for appointment status', a.status);
      }
    }

    console.log('Done');
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end().catch(() => {});
    process.exit(3);
  }
}

main();
