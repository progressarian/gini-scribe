// ── Google Sheets Cron — imports upcoming OPD appointments from sheet tabs ──

import { readUpcomingAppointments } from "../sheets/reader.js";
import pool from "../../config/db.js";
import { createLogger } from "../logger.js";
import { tryAcquireCronLock, CRON_LOCK_KEYS } from "./lowPriority.js";

const { log, error } = createLogger("Sheets Sync");

// ── Ensure source column exists ────────────────────────────────────────────
let columnsReady = false;
async function ensureSheetColumns() {
  if (columnsReady) return;
  await pool.query(`
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS sheet_condition TEXT;
  `);
  columnsReady = true;
}

// ── Parse date from sheet formats like "4/Apr/2026", "6/Apr/2026", etc. ────
function parseSheetDate(raw) {
  if (!raw) return null;
  const s = raw.toString().trim();

  // "4/Apr/2026" or "6/Apr/2026" (D/Mon/YYYY)
  const slashMatch = s.match(/^(\d{1,2})\/([A-Za-z]+)\/(\d{4})$/);
  if (slashMatch) {
    const [, day, monStr, year] = slashMatch;
    const months = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    const mon = months[monStr.toLowerCase().slice(0, 3)];
    if (mon) return `${year}-${mon}-${day.padStart(2, "0")}`;
  }

  // "4/4/2026" or "4/5/2026" (M/D/YYYY)
  const numMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (numMatch) {
    const [, m, d, y] = numMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  return null;
}

// ── Parse DOB from formats like "21/May/1979", "29 yrs", etc. ──────────────
function parseDOB(raw) {
  if (!raw) return { dob: null, age: null };
  const s = raw.toString().trim();

  // "29 yrs" or "65 yrs" → age only
  const ageMatch = s.match(/^(\d{1,3})\s*yrs?$/i);
  if (ageMatch) return { dob: null, age: +ageMatch[1] };

  // "21/May/1979"
  const dobMatch = s.match(/^(\d{1,2})\/([A-Za-z]+)\/(\d{4})$/);
  if (dobMatch) {
    const [, day, monStr, year] = dobMatch;
    const monthNums = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };
    const monthIdx = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const key = monStr.toLowerCase().slice(0, 3);
    const mon = monthNums[key];
    if (mon) {
      const dob = `${year}-${mon}-${day.padStart(2, "0")}`;
      const now = new Date();
      let age = now.getFullYear() - +year;
      const mi = monthIdx[key];
      if (now.getMonth() < mi || (now.getMonth() === mi && now.getDate() < +day)) age--;
      return { dob, age: age > 0 ? age : null };
    }
  }

  return { dob: null, age: null };
}

// ── Map sheet visit type codes → our visit types ───────────────────────────
function mapSheetVisitType(code) {
  if (!code) return "OPD";
  const c = code.toUpperCase().trim();
  if (c === "FU" || c === "FOLLOW-UP" || c === "FOLLOW UP") return "Follow-Up";
  if (c === "NEW") return "New Patient";
  if (c === "TELE" || c === "ONLINE") return "Tele";
  return "OPD";
}

// ── Map sheet time slot "11 AM to 12 PM" → "11:00", "2:30 PM to 3 PM" → "14:30"
function mapSheetTimeSlot(slot) {
  if (!slot) return null;
  const match = slot.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!match) return slot;
  let h = +match[1];
  const min = match[2] || "00";
  if (match[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (match[3].toUpperCase() === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

// ── Clean phone (strip notes like "calling", "whts", extra numbers) ────────
function cleanPhone(raw) {
  if (!raw) return null;
  // Take the first 10-digit number
  const match = raw.match(/(\d{10})/);
  return match ? match[1] : raw.replace(/[^\d+]/g, "").slice(0, 15) || null;
}

// ── Import a single patient row into appointments ──────────────────────────
async function importSheetPatient(patient, tabDate) {
  const fileNo = (patient["File No (Mandatory)"] || "").trim();
  const name = (patient["Patient Name (req for File No)"] || "").replace(/\n.*/, "").trim();
  const apptDateRaw = patient["Appointment Date"];
  const gender = (patient["Gender"] || "").trim();
  const dobRaw = patient["DOB (DD/MMM/YYYY)"];
  const phoneRaw = patient["Mobile Number (req for File No)"];
  const address = (patient["Address"] || "").trim();
  const email = (patient["Email ID (req for File No)"] || "").trim();
  const condition = (patient["Condition (req for File No)"] || "").trim();
  const visitTypeCode = patient["Standard Instruction for Visit Type"];
  const timeSlotRaw = patient["Reporting Time Slot"];

  // Skip invalid rows (no file number or name, or #N/A data)
  if (!name || name === "#N/A") return null;
  if (!fileNo || fileNo === "#N/A" || !fileNo.startsWith("P_")) return null;

  const apptDate = parseSheetDate(apptDateRaw) || tabDate;
  if (!apptDate) return null;

  const { dob, age } = parseDOB(dobRaw);
  const phone = cleanPhone(phoneRaw);
  const visitType = mapSheetVisitType(visitTypeCode);
  const timeSlot = mapSheetTimeSlot(timeSlotRaw);
  const sex = gender || null;

  // ── Upsert patient ──
  let patientId = null;

  // Match by file_no only (hospital-unique). Phone is unreliable because
  // family members frequently share a number.
  const byFileNo = fileNo
    ? await pool.query(
        `SELECT id, phone, address, email, dob, age, sex FROM patients WHERE file_no = $1`,
        [fileNo],
      )
    : { rows: [] };

  const existingPatient = byFileNo.rows[0] || null;

  if (existingPatient) {
    patientId = existingPatient.id;
    const p = existingPatient;

    // Update missing patient details from sheet data
    const updates = [];
    const values = [patientId];
    let idx = 2;

    if (!p.phone && phone) {
      updates.push(`phone = $${idx++}`);
      values.push(phone);
    }
    if (!p.address && address) {
      updates.push(`address = $${idx++}`);
      values.push(address);
    }
    if (!p.email && email) {
      updates.push(`email = $${idx++}`);
      values.push(email);
    }
    if (!p.dob && dob) {
      updates.push(`dob = $${idx++}::date`);
      values.push(dob);
    }
    if (!p.age && age) {
      updates.push(`age = $${idx++}`);
      values.push(age);
    }
    if (!p.sex && sex) {
      updates.push(`sex = $${idx++}`);
      values.push(sex);
    }

    if (updates.length > 0) {
      await pool
        .query(
          `UPDATE patients SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $1`,
          values,
        )
        .catch(() => {}); // Ignore constraint errors on update (e.g. phone already taken)
    }
  } else {
    try {
      const res = await pool.query(
        `INSERT INTO patients (name, phone, file_no, age, sex, address, dob, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)
         RETURNING id`,
        [name, phone, fileNo, age, sex, address || null, dob, email || null],
      );
      patientId = res.rows[0].id;
    } catch (e) {
      if (e.code === "23505") {
        // Phone conflict (family members sharing a number) — insert without phone
        try {
          const res2 = await pool.query(
            `INSERT INTO patients (name, file_no, age, sex, address, dob, email)
             VALUES ($1, $2, $3, $4, $5, $6::date, $7)
             ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [name, fileNo, age, sex, address || null, dob, email || null],
          );
          patientId = res2.rows[0].id;
        } catch {
          // Last resort: find by file_no
          const dup = await pool.query(`SELECT id FROM patients WHERE file_no = $1`, [fileNo]);
          patientId = dup.rows[0]?.id || null;
        }
      } else {
        throw e;
      }
    }
  }

  if (!patientId) return null;

  // ── Check if appointment already exists for this patient + date ──
  const existing = await pool.query(
    `SELECT id, source, healthray_id FROM appointments
     WHERE file_no = $1 AND appointment_date = $2
     LIMIT 1`,
    [fileNo, apptDate],
  );

  if (existing.rows[0]) {
    // Already exists — if it was healthray-imported, don't overwrite; if sheet, update basic fields
    const row = existing.rows[0];
    if (row.healthray_id) return { id: row.id, action: "skip-healthray" };

    await pool.query(
      `UPDATE appointments SET
        patient_id = $2, patient_name = $3, phone = $4,
        time_slot = COALESCE($5, time_slot),
        visit_type = COALESCE($6, visit_type),
        age = COALESCE($7, age), sex = COALESCE($8, sex),
        sheet_condition = $9, updated_at = NOW()
       WHERE id = $1`,
      [row.id, patientId, name, phone, timeSlot, visitType, age, sex, condition],
    );
    return { id: row.id, action: "updated" };
  }

  // ── Insert new appointment from sheet ──
  // ON CONFLICT guards against the SELECT-then-INSERT race when overlapping
  // sheets/today's-show runs both miss the existing-row check. The index has
  // a doctor_name column too, but the sheets path doesn't write doctor_name,
  // so the conflict can never fire here — kept as a no-op for symmetry with
  // the other insert paths and to surface any schema drift early.
  const { rows } = await pool.query(
    `INSERT INTO appointments
       (patient_id, patient_name, file_no, phone,
        appointment_date, time_slot, visit_type, status,
        is_walkin, age, sex, sheet_condition, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', false, $8, $9, $10, 'sheets')
     ON CONFLICT (file_no, appointment_date, time_slot, doctor_name, status)
       WHERE file_no IS NOT NULL AND appointment_date IS NOT NULL
         AND time_slot IS NOT NULL AND doctor_name IS NOT NULL
         AND status IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [patientId, name, fileNo, phone, apptDate, timeSlot, visitType, age, sex, condition],
  );

  if (rows[0]) return { id: rows[0].id, action: "created" };

  // Lost the race — another worker inserted the row first. Look it up so
  // downstream callers still get an id, mirroring the existing-row branch.
  const lookup = await pool.query(
    `SELECT id FROM appointments
      WHERE file_no = $1 AND appointment_date = $2 AND time_slot IS NOT DISTINCT FROM $3
      LIMIT 1`,
    [fileNo, apptDate, timeSlot],
  );
  return lookup.rows[0]
    ? { id: lookup.rows[0].id, action: "skip-race" }
    : { id: null, action: "skip-race" };
}

// ── Main sync: read all 3 tabs & import ────────────────────────────────────
export async function syncFromSheets() {
  const startTime = Date.now();
  log("Sync", "Reading upcoming appointment tabs...");

  // Per-family advisory lock — overlapping runs would race the SELECT-then-
  // INSERT path and produce duplicate appointment rows.
  const releaseLock = await tryAcquireCronLock("Sheets Sync", CRON_LOCK_KEYS.SHEETS_SYNC);
  if (!releaseLock) return { totalCreated: 0, totalUpdated: 0, totalSkipped: 0, totalErrors: 0 };

  try {
    await ensureSheetColumns();
    const tabsData = await readUpcomingAppointments();

    let totalCreated = 0,
      totalUpdated = 0,
      totalSkipped = 0,
      totalErrors = 0;

    for (const [tabName, tabInfo] of Object.entries(tabsData)) {
      const { date: tabDateRaw, patients } = tabInfo;
      const tabDate = parseSheetDate(tabDateRaw);

      log("Sync", `${tabName}: ${patients.length} rows, date=${tabDate || tabDateRaw}`);

      for (const patient of patients) {
        try {
          const result = await importSheetPatient(patient, tabDate);
          if (!result) {
            totalSkipped++;
            continue;
          }
          if (result.action === "created") totalCreated++;
          else if (result.action === "updated") totalUpdated++;
          else totalSkipped++;
        } catch (e) {
          totalErrors++;
          error("Sync", `Row error: ${e.message}`);
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(
      "Sync",
      `Done in ${elapsed}s — created: ${totalCreated}, updated: ${totalUpdated}, skipped: ${totalSkipped}, errors: ${totalErrors}`,
    );

    return { totalCreated, totalUpdated, totalSkipped, totalErrors };
  } catch (e) {
    error("Sync", `Fatal: ${e.message}`);
    throw e;
  } finally {
    await releaseLock();
  }
}

// ── Cron schedule: run every 30 min ────────────────────────────────────────
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
let intervalId = null;

export function startSheetsCron() {
  log("Cron", "Starting upcoming appointments sync (every 30 min)");

  // Run once on startup
  syncFromSheets().catch((e) => error("Cron", `Initial run failed: ${e.message}`));

  // Then every 30 minutes
  intervalId = setInterval(() => {
    syncFromSheets().catch((e) => error("Cron", `Scheduled run failed: ${e.message}`));
  }, SYNC_INTERVAL_MS);
}

export function stopSheetsCron() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log("Cron", "Stopped");
  }
}
