// ── Today's Show/No-Show Sync ────────────────────────────────────────────────
// Reads the "LIVE View of Today's patients" tab every 5 min and flips any
// appointment whose sheet row is marked "No Show" to status = 'no_show'.
// Only touches rows still in 'scheduled' — never overwrites checkedin/in_visit/
// seen/completed/cancelled.

import { readTodaysPatients } from "../sheets/reader.js";
import pool from "../../config/db.js";
import { createLogger } from "../logger.js";

const { log, error } = createLogger("Today's Show Sync");

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
let intervalId = null;

function pickFileNo(row) {
  const v = row["File No (Mandatory)"] || row["File No"] || row["file_no"] || "";
  const s = v.toString().trim();
  if (!s || s === "#N/A") return null;
  return s;
}

function pickShowValue(row) {
  const v = row["Show/No-Show"] ?? row["Show / No-Show"] ?? row["Show/No Show"] ?? "";
  return v.toString().trim();
}

function isNoShow(raw) {
  if (!raw) return false;
  return /^no[\s\-_/]*show$/i.test(raw.trim());
}

export async function syncTodaysShow() {
  const startTime = Date.now();
  try {
    const { patients = [] } = await readTodaysPatients();

    const noShowFileNos = [];
    let rowsSeen = 0;
    let rowsShow = 0;
    let rowsBlank = 0;

    for (const row of patients) {
      rowsSeen++;
      const fileNo = pickFileNo(row);
      if (!fileNo) continue;
      const showVal = pickShowValue(row);
      if (!showVal) {
        rowsBlank++;
        continue;
      }
      if (isNoShow(showVal)) noShowFileNos.push(fileNo);
      else rowsShow++;
    }

    let flipped = 0;
    let skipped = 0;
    if (noShowFileNos.length > 0) {
      const res = await pool.query(
        `UPDATE appointments
            SET status = 'no_show', updated_at = NOW()
          WHERE file_no = ANY($1::text[])
            AND appointment_date = CURRENT_DATE
            AND status = 'scheduled'
          RETURNING id`,
        [noShowFileNos],
      );
      flipped = res.rowCount;
      skipped = noShowFileNos.length - flipped;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(
      "Sync",
      `Done in ${elapsed}s — rows=${rowsSeen}, noShow=${noShowFileNos.length}, flipped=${flipped}, skipped=${skipped}, show=${rowsShow}, blank=${rowsBlank}`,
    );
    return { flipped, skipped, noShow: noShowFileNos.length };
  } catch (e) {
    error("Sync", `Fatal: ${e.message}`);
    throw e;
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
