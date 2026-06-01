// backfill-phones-v2.mjs
//
// Extended phone backfill — covers patients who have no entry in the
// `appointments` table but DO have consultations. Uses the consultation's
// visit_date + doctor name to look up the appointment in Healthray and
// extract patient.mobile_no.
//
// Also re-tries any remaining no-phone patients from the appointments path
// (in case a few were missed in v1).
//
// Usage:
//   node backfill-phones-v2.mjs            # live run
//   node backfill-phones-v2.mjs --dry-run  # print changes, no writes

import "./server/loadEnv.js";
import pool from "./server/config/db.js";
import { fetchAppointments } from "./server/services/healthray/client.js";
import { createWriteStream } from "fs";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 100;
const DELAY_MS = 600;

const logPath = `phone-backfill-v2-${new Date().toISOString().slice(0, 10)}.log`;
const logStream = createWriteStream(logPath, { flags: "a" });

function log(...args) {
  const line = args.join(" ");
  console.log(line);
  logStream.write(line + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Build doctor name → healthray_id map ────────────────────────────────────

const { rows: doctorRows } = await pool.query(
  `SELECT name, short_name, healthray_id FROM doctors WHERE healthray_id IS NOT NULL`,
);
const doctorIdMap = new Map();
for (const d of doctorRows) {
  if (d.name) doctorIdMap.set(d.name.trim().toLowerCase(), String(d.healthray_id));
  if (d.short_name) doctorIdMap.set(d.short_name.trim().toLowerCase(), String(d.healthray_id));
}
log(`[init] ${doctorIdMap.size} doctor → healthray_id mappings`);
if (DRY_RUN) log(`[init] DRY-RUN mode`);

function resolveDoctor(name) {
  if (!name) return null;
  return doctorIdMap.get(name.trim().toLowerCase()) || null;
}

// ── Healthray appointment cache ──────────────────────────────────────────────
// Key: "doctorHealthrayId:YYYY-MM-DD" → Map<file_no, mobile_no>

const apptCache = new Map();

async function getPhoneFromHealthray(doctorHealthrayId, date, fileNo) {
  const key = `${doctorHealthrayId}:${date}`;

  if (!apptCache.has(key)) {
    const phoneMap = new Map();
    let page = 1;
    while (true) {
      let appts;
      try {
        appts = await fetchAppointments(doctorHealthrayId, date, page, 100);
      } catch (e) {
        log(`  [warn] Healthray fetch failed doctor=${doctorHealthrayId} date=${date}: ${e.message}`);
        break;
      }
      if (!Array.isArray(appts) || appts.length === 0) break;
      for (const appt of appts) {
        const fno = appt.patient_case_id;
        const phone = appt.patient?.mobile_no;
        if (fno && phone) phoneMap.set(String(fno).trim(), String(phone).trim());
      }
      if (appts.length < 100) break;
      page++;
    }
    apptCache.set(key, phoneMap);
  }

  return apptCache.get(key).get(String(fileNo).trim()) || null;
}

// ── Query 1: patients with no phone who have appointments in Scribe ──────────
// (catches any missed from v1 + the 3 with unmapped doctors that may now map)

const { rows: apptPatients } = await pool.query(`
  SELECT DISTINCT ON (p.id)
    p.id, p.file_no, p.name,
    a.appointment_date::text AS lookup_date,
    a.doctor_name            AS lookup_doctor,
    d.healthray_id           AS doctor_healthray_id
  FROM patients p
  JOIN appointments a ON a.patient_id = p.id
  JOIN doctors d
    ON (d.name = a.doctor_name OR d.short_name = a.doctor_name)
   AND d.healthray_id IS NOT NULL
  WHERE (p.phone IS NULL OR p.phone = '')
    AND p.file_no IS NOT NULL
  ORDER BY p.id, a.appointment_date DESC
`);

// ── Query 2: patients with no phone, NO appointments, but have consultations ─

const { rows: conPatients } = await pool.query(`
  SELECT DISTINCT ON (p.id)
    p.id, p.file_no, p.name,
    c.visit_date::text       AS lookup_date,
    COALESCE(c.con_name, c.mo_name) AS lookup_doctor,
    d.healthray_id           AS doctor_healthray_id
  FROM patients p
  LEFT JOIN appointments a ON a.patient_id = p.id
  JOIN consultations c ON c.patient_id = p.id
  JOIN doctors d
    ON (d.name = COALESCE(c.con_name, c.mo_name)
     OR d.short_name = COALESCE(c.con_name, c.mo_name))
   AND d.healthray_id IS NOT NULL
  WHERE (p.phone IS NULL OR p.phone = '')
    AND p.file_no IS NOT NULL
    AND a.id IS NULL
  ORDER BY p.id, c.visit_date DESC
`);

// Merge both lists, dedupe by patient id (appt list takes priority)
const seen = new Set();
const allPatients = [];
for (const p of [...apptPatients, ...conPatients]) {
  if (!seen.has(p.id)) {
    seen.add(p.id);
    allPatients.push(p);
  }
}

log(`[init] ${apptPatients.length} via appointments + ${conPatients.length} via consultations = ${allPatients.length} total to process\n`);

// ── Process in batches of 100 ────────────────────────────────────────────────

let totalUpdated = 0;
let totalNoPhone = 0;
let totalErrors = 0;
const totalBatches = Math.ceil(allPatients.length / BATCH_SIZE);

for (let b = 0; b < totalBatches; b++) {
  const batch = allPatients.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
  log(`--- Batch ${b + 1}/${totalBatches} (${batch.length} patients) ---`);

  const updates = [];

  for (const p of batch) {
    try {
      const phone = await getPhoneFromHealthray(p.doctor_healthray_id, p.lookup_date, p.file_no);

      if (!phone) {
        log(`  SKIP  ${p.file_no} (${p.name}) — not found in Healthray (doctor=${p.lookup_doctor} date=${p.lookup_date})`);
        totalNoPhone++;
        continue;
      }

      updates.push({ id: p.id, file_no: p.file_no, name: p.name, phone });
    } catch (e) {
      log(`  ERROR ${p.file_no} (${p.name}): ${e.message}`);
      totalErrors++;
    }
  }

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

  if (b < totalBatches - 1) await sleep(DELAY_MS);
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
