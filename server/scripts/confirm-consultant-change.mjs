import "../loadEnv.js";
import pool from "../config/db.js";
import { confirmConsultantChange } from "../services/billing/consultantChange.js";

const flag = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const fileNo = process.argv.slice(2).find((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");
const actorId = Number(flag("actor")) || null;
const actorName = flag("actor-name");
const leftover = flag("leftover") || "deposit";
const refundMode = flag("mode");
const note = flag("note") || "Visit was auto-assigned to the wrong consultant";

if (!fileNo || (!actorId && !actorName)) {
  console.error(
    "Usage: node scripts/confirm-consultant-change.mjs <UHID> (--actor=<staff id> | --actor-name=<name>) " +
      '[--leftover=deposit|refund] [--mode=cash|card|upi] [--note="why"] [--apply]',
  );
  process.exit(1);
}

try {
  const { rows: actors } = await pool.query(
    `SELECT id, name, role FROM doctors
      WHERE is_active IS NOT FALSE AND (id = $1 OR ($2::text IS NOT NULL AND name ILIKE $2))
      ORDER BY id`,
    [actorId, actorName ? `%${actorName}%` : null],
  );
  console.log("Acting as:");
  console.table(actors);
  if (actors.length !== 1) throw new Error("Pick exactly one staff member with --actor=<id>");
  const actor = actors[0];

  const { rows: pending } = await pool.query(
    `SELECT c.id, p.name AS patient, p.file_no, v.visit_date::text AS visit_date,
            f.name AS from_doctor, t.name AS to_doctor
       FROM consultant_changes c
       JOIN patients p ON p.id = c.patient_id
       JOIN giniflow_visits v ON v.id = c.visit_id
       LEFT JOIN doctors f ON f.id = c.from_doctor_id
       LEFT JOIN doctors t ON t.id = c.to_doctor_id
      WHERE p.file_no = $1 AND c.status = 'pending'`,
    [fileNo],
  );
  console.log(`Pending consultant changes for ${fileNo}: ${pending.length}`);
  console.table(pending);
  if (pending.length !== 1) throw new Error("Expected exactly one pending change");

  if (!apply) {
    console.log(
      `Dry run. --apply will confirm it as ${actor.name}: leftover=${leftover}` +
        `${refundMode ? ` (${refundMode})` : ""}, note "${note}"`,
    );
  } else {
    const done = await confirmConsultantChange(
      pending[0].id,
      { leftover, refund_mode: refundMode, note },
      { actorId: actor.id, role: actor.role },
    );
    console.log("Confirmed:");
    console.dir(done, { depth: 3 });
  }
} finally {
  await pool.end();
}
