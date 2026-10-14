import "../loadEnv.js";
import pool from "../config/db.js";
import { ownFu } from "../services/ghmDayWindow.js";
import { weekdayFollowUpDate } from "../../shared/followUp.js";

const APPLY = process.argv.includes("--apply");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1]) || 30;
const PHRASE =
  /(?:follow[\s-]*up|f\/u)\s*(?:on\s+)?(?:the\s+)?(?:next|coming|this)?\s*(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*/i;

const { rows } = await pool.query(
  `SELECT a.id, a.file_no, a.patient_name, a.appointment_date::text AS visit, a.healthray_clinical_notes AS note
     FROM appointments a
    WHERE a.appointment_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $1::int
      AND a.status IN ('completed', 'seen')
      AND ${ownFu("a")} IS NULL
      AND a.healthray_clinical_notes ~* '(follow[[:space:]-]*up|f/u)[[:space:]]*(on[[:space:]]+)?(the[[:space:]]+)?(next|coming|this)?[[:space:]]*(sun|mon|tue|wed|thu|fri|sat)'
    ORDER BY a.appointment_date, a.id`,
  [DAYS],
);

const plan = rows
  .map((r) => {
    const phrase = r.note.match(PHRASE)?.[0] || "";
    return { ...r, phrase, date: weekdayFollowUpDate(r.visit, phrase) };
  })
  .filter((r) => r.date);

console.table(
  plan.map(({ id, file_no, patient_name, visit, phrase, date }) => ({
    id,
    file_no,
    patient: (patient_name || "").trim().slice(0, 24),
    visit,
    phrase: phrase.replace(/\s+/g, " "),
    follow_up: date,
  })),
);
console.log(`${plan.length} visit(s) get a follow-up date`);

if (!APPLY) {
  console.log("dry run — pass --apply to write");
  await pool.end();
  process.exit(0);
}

for (let i = 0; i < plan.length; i += 100) {
  const batch = plan.slice(i, i + 100);
  const { rowCount } = await pool.query(
    `UPDATE appointments a
        SET healthray_follow_up = COALESCE(a.healthray_follow_up, '{}'::jsonb)
                                  || jsonb_build_object('date', b.date),
            updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS b(id int, date text)
      WHERE a.id = b.id AND ${ownFu("a")} IS NULL`,
    [JSON.stringify(batch.map(({ id, date }) => ({ id, date })))],
  );
  console.log(`batch ${i / 100 + 1}: updated ${rowCount} of ${batch.length}`);
}
await pool.end();
