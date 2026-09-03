// ── Today's Show/No-Show Sync ────────────────────────────────────────────────
// Reads the "Today's Appt" tab every 5 min (that's where Show/No-Show lives).
// Pass 1: flips any pre-visit appointment (NULL/scheduled/pending) whose sheet
//   row is marked "No Show" to status = 'no_show'. Match by file_no first,
//   fall back to phone.
// Pass 2: for any no-show row that has NO appointment today at all, INSERT a
//   new appointment row so the "No-Show" group in the OPD UI surfaces it.
//
// Two guards stand in front of both passes, because the sheet is a shared human
// document and neither pass can tell a stale cell from a deliberate one:
//
//   The tab must be dated today (IST). The next day's names get pasted in the
//   evening before while the Show/No-Show column still holds the outgoing day's
//   answers — on 3 Sep 2026 that flipped all 56 of the day's appointments to
//   no_show at 05:37 IST, before the OPD opened, and every Gini Flow station
//   read zero for the rest of the day (no_show belongs to no board column).
//
//   A slot whose start time has not arrived yet is left alone. Nobody can have
//   failed to turn up for a 4 PM appointment at breakfast, whatever the cell
//   says; the row is simply picked up by a later run once the slot is due.

import { readTodaysAppt, parseSheetDate } from "../sheets/reader.js";
import { slotStartHour } from "../../../shared/slotHour.js";
import pool from "../../config/db.js";
import { noteSyncedWhileBlocked } from "../patientBlockGuard.js";
import { createLogger } from "../logger.js";
import { tryAcquireCronLock, CRON_LOCK_KEYS } from "./lowPriority.js";

const { log, error } = createLogger("Today's Show Sync");

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

// The clinic's day, not the server's. CURRENT_DATE is UTC here, so between
// midnight and 05:30 IST it names yesterday — which is how 54 no-show
// placeholders for 3 Sep were written onto 2 Sep and inflated its no-show rate.
const IST_TODAY_SQL = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

function istToday() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function istHourNow() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() + ist.getUTCMinutes() / 60;
}

let intervalId = null;
let syncInFlight = false;

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

// Each row carries its own "Appointment Date" alongside the tab header. Both
// are checked: the header can be updated while a row is not, and vice versa.
function pickApptDate(row) {
  return (row["Appointment Date"] || row["Appt Date"] || row["Date"] || "").toString().trim();
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
  if (syncInFlight) {
    return { flipped: 0, inserted: 0, skipped: 0, noShow: 0, skippedBecauseRunning: true };
  }

  syncInFlight = true;
  const startTime = Date.now();
  let releaseLock = null;
  try {
    // Per-family advisory lock — prevents the 5-min cron from racing itself or
    // an overlapping sheets-sync run when both try to insert the same no-show
    // placeholder.
    releaseLock = await tryAcquireCronLock("Today's Show Sync", CRON_LOCK_KEYS.TODAYS_SHOW_SYNC);
    if (!releaseLock) return { flipped: 0, inserted: 0, skipped: 0, noShow: 0 };
    const { date: tabDateRaw, patients = [] } = await readTodaysAppt();

    // Guard 1 — the tab must be today's. An unparseable header is treated the
    // same as a wrong one: this pass writes no_show, and a no-show written in
    // error costs the floor its whole board, so it only runs on a date it can
    // read and agree with.
    const day = istToday();
    const tabDate = parseSheetDate(tabDateRaw);
    if (tabDate !== day) {
      log("Sync", `Skipping — "Today's Appt" is dated ${tabDateRaw || "(blank)"}, not ${day}`);
      return { flipped: 0, inserted: 0, skipped: 0, noShow: 0, staleTab: true };
    }

    const nowHour = istHourNow();

    const noShowRows = [];
    let rowsSeen = 0;
    let rowsShow = 0;
    let rowsBlank = 0;
    let rowsNotDue = 0;
    let rowsOtherDay = 0;

    for (const row of patients) {
      rowsSeen++;
      const showVal = pickShowValue(row);
      if (!showVal) {
        rowsBlank++;
        continue;
      }
      if (isNoShow(showVal)) {
        // Guard 2 — a slot that has not started yet cannot have been missed.
        // An unparseable slot is let through: the sheet holds formats this
        // parser does not know, and a real no-show must not be lost to one.
        const startHour = slotStartHour(pickTimeSlot(row));
        if (startHour !== null && nowHour < startHour) {
          rowsNotDue++;
          continue;
        }
        const rowDate = parseSheetDate(pickApptDate(row));
        if (rowDate && rowDate !== day) {
          rowsOtherDay++;
          continue;
        }
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
          WHERE appointment_date = ${IST_TODAY_SQL}
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
          WHERE appointment_date = ${IST_TODAY_SQL} AND file_no = $1
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
         VALUES ($1, $2, $3, $4, $5, ${IST_TODAY_SQL}, $6, 'no_show', true, NOW(), NOW())
         ON CONFLICT (file_no, appointment_date, time_slot, doctor_name, status)
           WHERE file_no IS NOT NULL AND appointment_date IS NOT NULL
             AND time_slot IS NOT NULL AND doctor_name IS NOT NULL
             AND status IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [patientId, fileNo || null, name || null, phone || null, doctor || null, timeSlot || null],
      );
      if (ins.rows[0]) {
        inserted++;
        noteSyncedWhileBlocked(patientId, "todays_show_sync");
      } else skippedExisting++;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(
      "Sync",
      `Done in ${elapsed}s — rows=${rowsSeen}, noShow=${noShowRows.length}, flipped=${flipped}, inserted=${inserted}, skippedExisting=${skippedExisting}, skippedNoFileNo=${skippedNoFileNo}, notDue=${rowsNotDue}, otherDay=${rowsOtherDay}, show=${rowsShow}, blank=${rowsBlank}`,
    );
    return {
      flipped,
      inserted,
      skipped: skippedExisting,
      notDue: rowsNotDue,
      otherDay: rowsOtherDay,
      noShow: noShowRows.length,
    };
  } catch (e) {
    error("Sync", `Fatal: ${e.message}`);
    throw e;
  } finally {
    if (releaseLock) await releaseLock();
    syncInFlight = false;
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
