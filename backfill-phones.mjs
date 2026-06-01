// backfill-phones.mjs
//
// Fetches mobile numbers from Healthray for patients in Scribe who have no
// phone stored. Works by finding each patient's most recent appointment,
// pulling that day's Healthray schedule for the same doctor, and extracting
// appt.patient.mobile_no.
//
// Processes in batches of 100. Caches Healthray responses per (doctor, date)
// to minimise API calls.
//
// Usage:
//   node backfill-phones.mjs            # live run
//   node backfill-phones.mjs --dry-run  # print what would change, no writes

import "./server/loadEnv.js";
import pool from "./server/config/db.js";
import { fetchAppointments } from "./server/services/healthray/client.js";
import { createWriteStream } from "fs";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 100;
const DELAY_BETWEEN_BATCHES_MS = 800;

const logPath = `phone-backfill-${new Date().toISOString().slice(0, 10)}.log`;
const logStream = createWriteStream(logPath, { flags: "a" });

function log(...args) {
  const line = args.join(" ");
  console.log(line);
  logStream.write(line + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Step 1: build doctor name → healthray_id map ────────────────────────────

const { rows: doctorRows } = await pool.query(
  `SELECT name, short_name, healthray_id FROM doctors WHERE healthray_id IS NOT NULL`,
);
const doctorIdMap = new Map();
for (const d of doctorRows) {
  if (d.name) doctorIdMap.set(d.name.trim(), String(d.healthray_id));
  if (d.short_name) doctorIdMap.set(d.short_name.trim(), String(d.healthray_id));
}
log(`[init] ${doctorIdMap.size} doctor name → healthray_id mappings loaded`);
if (DRY_RUN) log(`[init] DRY-RUN mode — no DB writes will happen`);

// ── Step 2: fetch all target patients upfront ────────────────────────────────
// For each patient without phone, pick the most recent appointment that has a
// doctor we can map to a Healthray ID. All IDs are loaded into memory so
// offset drift (from rows being updated) doesn't affect pagination.

log(`[init] Querying target patients...`);

const { rows: allPatients } = await pool.query(`
  SELECT DISTINCT ON (p.id)
    p.id,
    p.file_no,
    p.name,
    a.appointment_date::text  AS appt_date,
    a.doctor_name,
    d.healthray_id            AS doctor_healthray_id
  FROM patients p
  JOIN appointments a ON a.patient_id = p.id
  JOIN doctors d
    ON d.name = a.doctor_name
   AND d.healthray_id IS NOT NULL
  WHERE (p.phone IS NULL OR p.phone = '')
    AND p.file_no IS NOT NULL
  ORDER BY p.id, a.appointment_date DESC
`);

log(`[init] ${allPatients.length} patients to process\n`);

// ── Step 3: Healthray appointment cache ──────────────────────────────────────
// Key: "doctorId:YYYY-MM-DD"  →  Map<file_no, mobile_no>

const apptCache = new Map();

async function lookupPhone(doctorHealthrayId, date, fileNo) {
  const key = `${doctorHealthrayId}:${date}`;

  if (!apptCache.has(key)) {
    const phoneMap = new Map();
    let page = 1;

    while (true) {
      let appts;
      try {
        appts = await fetchAppointments(doctorHealthrayId, date, page, 100);
      } catch (e) {
        log(`  [warn] Healthray fetch failed for doctor=${doctorHealthrayId} date=${date} page=${page}: ${e.message}`);
        break;
      }

      if (!Array.isArray(appts) || appts.length === 0) break;

      for (const appt of appts) {
        const fno = appt.patient_case_id;
        const phone = appt.patient?.mobile_no;
        if (fno && phone) phoneMap.set(String(fno).trim(), String(phone).trim());
      }

      if (appts.length < 100) break; // last page
      page++;
    }

    apptCache.set(key, phoneMap);
  }

  return apptCache.get(key).get(String(fileNo).trim()) || null;
}

// ── Step 4: process in batches of 100 ───────────────────────────────────────

let totalUpdated = 0;
let totalNoPhone = 0;
let totalErrors = 0;
const totalBatches = Math.ceil(allPatients.length / BATCH_SIZE);

for (let b = 0; b < totalBatches; b++) {
  const batch = allPatients.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
  log(`--- Batch ${b + 1}/${totalBatches} (${batch.length} patients) ---`);

  const updates = []; // { id, file_no, name, phone }

  for (const p of batch) {
    try {
      const phone = await lookupPhone(p.doctor_healthray_id, p.appt_date, p.file_no);

      if (!phone) {
        log(`  SKIP  ${p.file_no} (${p.name}) — phone not found in Healthray (doctor=${p.doctor_name} date=${p.appt_date})`);
        totalNoPhone++;
        continue;
      }

      updates.push({ id: p.id, file_no: p.file_no, name: p.name, phone });
    } catch (e) {
      log(`  ERROR ${p.file_no} (${p.name}): ${e.message}`);
      totalErrors++;
    }
  }

  // Write updates for this batch
  for (const u of updates) {
    if (DRY_RUN) {
      log(`  [DRY] UPDATE ${u.file_no} (${u.name}) → ${u.phone}`);
    } else {
      await pool.query(
        `UPDATE patients SET phone = $1 WHERE id = $2 AND (phone IS NULL OR phone = '')`,
        [u.phone, u.id],
      );
      log(`  UPDATE ${u.file_no} (${u.name}) → ${u.phone}`);
    }
    totalUpdated++;
  }

  log(`  Batch ${b + 1} done — updated=${updates.length} skipped=${batch.length - updates.length}\n`);

  if (b < totalBatches - 1) await sleep(DELAY_BETWEEN_BATCHES_MS);
}

// ── Summary ──────────────────────────────────────────────────────────────────

log(`\n${"=".repeat(50)}`);
log(`DONE`);
log(`  Updated  : ${totalUpdated}`);
log(`  No phone : ${totalNoPhone}`);
log(`  Errors   : ${totalErrors}`);
log(`  Log file : ${logPath}`);
if (DRY_RUN) log(`  (dry-run — no changes written)`);

await pool.end();
logStream.end();
