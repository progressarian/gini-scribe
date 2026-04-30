// ── Today's Show/No-Show Sync ────────────────────────────────────────────────
// Reads the "Today's Appt" tab every 5 min (that's where Show/No-Show lives).
// Pass 1: flips any pre-visit appointment (NULL/scheduled/pending) whose sheet
//   row is marked "No Show" to status = 'no_show'. Match by file_no first,
//   fall back to phone.
// Pass 2: for any no-show row that has NO appointment today at all, INSERT a
//   new appointment row so the "No-Show" group in the OPD UI surfaces it.

import { readTodaysAppt } from "../sheets/reader.js";
import pool from "../../config/db.js";
import { createLogger } from "../logger.js";
import { tryAcquireCronLock, CRON_LOCK_KEYS } from "./lowPriority.js";

const { log, error } = createLogger("Today's Show Sync");

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let intervalId = null;

// Only accept file_nos that look real (e.g. P_177330). Reject placeholders
// like ".", ";", "1", "FU." that appear in the sheet for unregistered patients.
function pickFileNo(row) {
  const v = (row["File No"] || row["File No (Mandatory)"] || row["file_no"] || "")
    .toString()
    .trim();
  if (!v || v === "#N/A") return null;
  if (!/^P_\d+$/i.test(v)) return null;
  return v;
}

function pickShowValue(row) {
  const v = row["Show/No-Show"] ?? row["Show / No-Show"] ?? row["Show/No Show"] ?? "";
  return v.toString().trim();
}

function isNoShow(raw) {
  if (!raw) return false;
  return /^no[\s\-_/]*show$/i.test(raw.trim());
}

function pickName(row) {
  return (row["Patient Name"] || row["Name"] || "").toString().trim();
}

// Sheet mobile can be "9991598260" or "7087086064/ 9814566048" — take the first.
function pickPhone(row) {
  const raw = (row["Mobile Number"] || row["Phone"] || row["Mobile"] || "").toString();
  const first = raw.split(/[\/,]/)[0] || "";
  return first.replace(/\D/g, "").trim();
}

function pickDoctor(row) {
  return (row["Consultant"] || row["Doctor"] || row["Doctor Name"] || "").toString().trim();
}

function pickTimeSlot(row) {
  return (
    row["Reporting time range"] ||
    row["Appointment Time"] ||
    row["Time Slot"] ||
    row["Time"] ||
    ""
  )
    .toString()
    .trim();
}

export async function syncTodaysShow() {
  const startTime = Date.now();
  // Per-family advisory lock — prevents the 5-min cron from racing itself or
  // an overlapping sheets-sync run when both try to insert the same no-show
  // placeholder.
  const releaseLock = await tryAcquireCronLock(
    "Today's Show Sync",
    CRON_LOCK_KEYS.TODAYS_SHOW_SYNC,
  );
  if (!releaseLock) return { flipped: 0, inserted: 0, skipped: 0, noShow: 0 };
  try {
    const { patients = [] } = await readTodaysAppt();

    const noShowRows = [];
    let rowsSeen = 0;
    let rowsShow = 0;
    let rowsBlank = 0;

    for (const row of patients) {
      rowsSeen++;
      const showVal = pickShowValue(row);
      if (!showVal) {
        rowsBlank++;
        continue;
      }
      if (isNoShow(showVal)) {
        noShowRows.push({
          fileNo: pickFileNo(row),
          phone: pickPhone(row),
          row,
        });
      } else {
        rowsShow++;
      }
    }

    // Pass 1: UPDATE existing pre-visit appointments to 'no_show'.
    // Match by file_no only — phone is shared across family members.
    const fileNos = noShowRows.map((r) => r.fileNo).filter(Boolean);

    let flipped = 0;
    const flippedFileNos = new Set();

    if (fileNos.length > 0) {
      const res = await pool.query(
        `UPDATE appointments
            SET status = 'no_show', updated_at = NOW()
          WHERE appointment_date = CURRENT_DATE
            AND (status IS NULL OR status IN ('scheduled', 'pending'))
            AND file_no = ANY($1::text[])
          RETURNING file_no`,
        [fileNos],
      );
      flipped = res.rowCount;
      for (const r of res.rows) {
        if (r.file_no) flippedFileNos.add(r.file_no);
      }
    }

    // Pass 2: INSERT placeholder rows for no-shows with no appointment today.
    let inserted = 0;
    let skippedExisting = 0;
    let skippedNoFileNo = 0;
    for (const { fileNo, phone, row } of noShowRows) {
      // Skip rows without a valid hospital-issued file number (must start with P_).
      // Without it we can't tie the appointment back to a real patient record.
      if (!fileNo) {
        skippedNoFileNo++;
        continue;
      }

      if (flippedFileNos.has(fileNo)) continue;

      // Don't duplicate — skip if ANY appointment for today already exists
      // for this file_no (could be already-seen / cancelled).
      const existing = await pool.query(
        `SELECT 1 FROM appointments
          WHERE appointment_date = CURRENT_DATE AND file_no = $1
          LIMIT 1`,
        [fileNo],
      );
      if (existing.rowCount > 0) {
        skippedExisting++;
        continue;
      }

      const name = pickName(row);
      const doctor = pickDoctor(row);
      const timeSlot = pickTimeSlot(row);

      // Resolve patient_id by file_no only (hospital-unique).
      const pat = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [fileNo]);
      let patientId = pat.rows[0]?.id || null;

      // No patient in DB yet — create one so the appointment can be linked.
      // file_no is the hospital-issued ID and is guaranteed present here.
      if (!patientId) {
        try {
          const ins = await pool.query(
            `INSERT INTO patients (name, phone, file_no)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [name || null, phone || null, fileNo],
          );
          patientId = ins.rows[0].id;
        } catch (e) {
          if (e.code === "23505") {
            // Unique conflict. If file_no already exists, pick that patient.
            // Otherwise the conflict is on phone (family shared number) —
            // retry the insert without phone to create a distinct patient
            // rather than merging into the phone-owner's record.
            const byFile = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [
              fileNo,
            ]);
            if (byFile.rows[0]) {
              patientId = byFile.rows[0].id;
            } else {
              const ins2 = await pool
                .query(`INSERT INTO patients (name, file_no) VALUES ($1, $2) RETURNING id`, [
                  name || null,
                  fileNo,
                ])
                .catch(() => null);
              patientId = ins2?.rows[0]?.id || null;
            }
          } else {
            throw e;
          }
        }
      }

      // Hard requirement: must have a patient_id to create the appointment.
      if (!patientId) {
        skippedNoFileNo++;
        continue;
      }

      // ON CONFLICT prevents this no-show placeholder from racing against a
      // concurrent sheets-sync run that may have just inserted the same
      // (file_no, date, time_slot) tuple.
      const ins = await pool.query(
        `INSERT INTO appointments
           (patient_id, file_no, patient_name, phone, doctor_name,
            appointment_date, time_slot, status, is_walkin, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, 'no_show', true, NOW(), NOW())
         ON CONFLICT (file_no, appointment_date, time_slot, doctor_name, status)
           WHERE file_no IS NOT NULL AND appointment_date IS NOT NULL
             AND time_slot IS NOT NULL AND doctor_name IS NOT NULL
             AND status IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [patientId, fileNo || null, name || null, phone || null, doctor || null, timeSlot || null],
      );
      if (ins.rows[0]) inserted++;
      else skippedExisting++;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(
      "Sync",
      `Done in ${elapsed}s — rows=${rowsSeen}, noShow=${noShowRows.length}, flipped=${flipped}, inserted=${inserted}, skippedExisting=${skippedExisting}, skippedNoFileNo=${skippedNoFileNo}, show=${rowsShow}, blank=${rowsBlank}`,
    );
    return {
      flipped,
      inserted,
      skipped: skippedExisting,
      noShow: noShowRows.length,
    };
  } catch (e) {
    error("Sync", `Fatal: ${e.message}`);
    throw e;
  } finally {
    await releaseLock();
  }
}

export function startTodaysShowCron() {
  log("Cron", "Starting (every 5 min)");
  syncTodaysShow().catch((e) => error("Cron", `Initial run failed: ${e.message}`));
  intervalId = setInterval(() => {
    syncTodaysShow().catch((e) => error("Cron", `Scheduled run failed: ${e.message}`));
  }, SYNC_INTERVAL_MS);
}

export function stopTodaysShowCron() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log("Cron", "Stopped");
  }
}
