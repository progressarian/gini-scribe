import "dotenv/config";
import pool from "../config/db.js";
import { ownFu } from "../services/ghmDayWindow.js";
import { extractRelativeFollowUp } from "../services/healthray/parser.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const APPLY = args.includes("--apply");
const FROM = flag("from");
const TO = flag("to");
const FILE_NOS = (flag("file-no") || "").split(",").filter(Boolean);

if (!FROM || !TO) {
  console.error(
    "usage: node server/scripts/backfill-relative-followup.mjs --from 2026-08-18 --to 2026-08-26 [--file-no P_178713] [--apply]",
  );
  process.exit(1);
}

const { rows } = await pool.query(
  `SELECT a.id, a.file_no, a.patient_name, a.appointment_date, a.healthray_follow_up,
          a.follow_up_with, a.healthray_clinical_notes AS notes
     FROM appointments a
    WHERE a.appointment_date BETWEEN $1 AND $2
      AND a.status IN ('completed', 'seen')
      AND a.healthray_clinical_notes IS NOT NULL
      AND ${ownFu("a")} IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM appointments other
         WHERE other.file_no = a.file_no
           AND other.id <> a.id
           AND other.appointment_date >= a.appointment_date
           AND ${ownFu("other")} IS NOT NULL
      )
    ORDER BY a.appointment_date, a.id`,
  [FROM, TO],
);

console.log(
  `${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} visit(s) with no follow-up between ${FROM} and ${TO}`,
);

let updated = 0;
let skipped = 0;
const changes = [];

for (const row of rows) {
  if (FILE_NOS.length && !FILE_NOS.includes(row.file_no)) continue;

  const found = extractRelativeFollowUp(row.notes);
  if (!found) {
    skipped += 1;
    continue;
  }

  const { rows: check } = await pool.query(
    `SELECT CASE WHEN btrim(lower($2)) ~ '^[0-9]{1,2} *(day|week|month|year)s?$'
                 THEN ($1::date + btrim(lower($2))::interval)::date END AS derived`,
    [row.appointment_date, found.timing],
  );
  const derived = check[0].derived;
  if (!derived) {
    console.error(
      `  ! ${row.file_no} ${row.id}: timing "${found.timing}" is not castable — skipped`,
    );
    skipped += 1;
    continue;
  }

  const merged = {
    date: row.healthray_follow_up?.date || null,
    timing: found.timing,
    notes: row.healthray_follow_up?.notes || found.notes,
  };

  changes.push({
    file_no: row.file_no,
    patient: row.patient_name,
    visit: String(row.appointment_date).slice(0, 10),
    timing: found.timing,
    follow_up: derived,
  });

  if (APPLY) {
    await pool.query(
      `UPDATE appointments
          SET healthray_follow_up = $2::jsonb,
              follow_up_with = COALESCE(follow_up_with, $3),
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, JSON.stringify(merged), found.notes],
    );
  }
  updated += 1;
}

console.table(changes);
console.log(
  `${APPLY ? "updated" : "would update"}: ${updated} | no relative follow-up in note: ${skipped}`,
);
process.exit(0);
