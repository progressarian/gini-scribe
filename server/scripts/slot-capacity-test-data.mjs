import "../loadEnv.js";
import pool from "../config/db.js";
import { dayPlan, weekdayOf } from "../../shared/slotTemplates.js";

const DOCTOR = "Dr. Test Consultant";
const BOOK_DATE = "2026-10-26";
const PAST_VISIT = "2026-10-05";
const EFFECTIVE_FROM = "2026-10-23";
const FILE_PREFIX = "TESTSLOT-";
const CAPS = { capNew: 2, capFollowup: 2, capWalkin: 2 };

const PATIENTS = [
  { n: 1, name: "TEST New Patient One", type: "new" },
  { n: 2, name: "TEST New Patient Two", type: "new" },
  { n: 3, name: "TEST Follow-up Patient One", type: "followup" },
  { n: 4, name: "TEST Follow-up Patient Two", type: "followup" },
  { n: 5, name: "TEST Walk-in Patient One", type: "walkin" },
  { n: 6, name: "TEST Walk-in Patient Two", type: "walkin" },
];

const VISIT_TYPE = { new: "New Patient", followup: "Follow-Up", walkin: "Walk-in" };

const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
};
const moveTo = argAfter("--move-to");
const write = process.argv.includes("--apply");

const mode = process.argv.includes("--remove")
  ? "remove"
  : process.argv.includes("--phones")
    ? "phones"
    : process.argv.includes("--clear-slots")
      ? "clear-slots"
      : moveTo
        ? "move"
        : write
          ? "apply"
          : "dry-run";

const hours = [1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  start: "10:00",
  end: "13:00",
  slotMinutes: 30,
  ...CAPS,
}));

const fileNo = (p) => `${FILE_PREFIX}${String(p.n).padStart(2, "0")}`;

async function busyCheck(client) {
  const { rows } = await client.query(
    `SELECT count(*) FILTER (WHERE state = 'active')::int AS active,
            count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_txn
       FROM pg_stat_activity WHERE datname = current_database()`,
  );
  console.log(
    `pg_stat_activity: ${rows[0].active} active, ${rows[0].idle_in_txn} idle in transaction`,
  );
  if (rows[0].idle_in_txn > 3) throw new Error("Database looks busy; try again later.");
}

async function ensureDoctor(client) {
  const found = await client.query(`SELECT id FROM doctors WHERE name = $1`, [DOCTOR]);
  if (found.rows.length) {
    console.log(`Doctor exists: #${found.rows[0].id} ${DOCTOR}`);
    return found.rows[0].id;
  }
  const { rows } = await client.query(
    `INSERT INTO doctors (name, short_name, role, specialty, is_active)
     VALUES ($1, 'Test Consultant', 'consultant', 'Testing — safe to delete', TRUE) RETURNING id`,
    [DOCTOR],
  );
  console.log(`Created doctor #${rows[0].id} ${DOCTOR} (no PIN, cannot log in)`);
  return rows[0].id;
}

async function ensureTemplate(client, doctorId) {
  const found = await client.query(
    `SELECT id FROM doctor_slot_templates WHERE doctor_id = $1 AND status = 'active'`,
    [doctorId],
  );
  if (found.rows.length) {
    console.log(`Schedule exists: template #${found.rows[0].id}`);
    return;
  }
  const { rows } = await client.query(
    `INSERT INTO doctor_slot_templates (doctor_id, effective_from, partial_last, note)
     VALUES ($1, $2::date, 'drop', 'Slot capacity test data') RETURNING id`,
    [doctorId, EFFECTIVE_FROM],
  );
  await client.query(
    `INSERT INTO doctor_slot_template_hours
       (template_id, weekday, start_time, end_time, slot_minutes, cap_new, cap_followup, cap_walkin)
     SELECT $1, x.weekday, x.start::time, x."end"::time, x."slotMinutes",
            x."capNew", x."capFollowup", x."capWalkin"
       FROM jsonb_to_recordset($2::jsonb) AS x(weekday int, start text, "end" text,
            "slotMinutes" int, "capNew" int, "capFollowup" int, "capWalkin" int)`,
    [rows[0].id, JSON.stringify(hours)],
  );
  console.log(
    `Created schedule #${rows[0].id}: Mon–Sat 10 AM–1 PM, 30-min slots, limits 2 new / 2 follow-up / 2 walk-in per slot`,
  );
}

async function ensurePatient(client, p) {
  const found = await client.query(`SELECT id FROM patients WHERE file_no = $1`, [fileNo(p)]);
  if (found.rows.length) return found.rows[0].id;
  const { rows } = await client.query(
    `INSERT INTO patients (name, file_no, sex, age) VALUES ($1, $2, 'Other', 40) RETURNING id`,
    [p.name, fileNo(p)],
  );
  return rows[0].id;
}

async function ensureAppointment(
  client,
  { patientId, p, doctorId, date, slot, status, visitType },
) {
  const found = await client.query(
    `SELECT id FROM appointments WHERE patient_id = $1 AND appointment_date = $2::date AND doctor_id = $3`,
    [patientId, date, doctorId],
  );
  if (found.rows.length) return { id: found.rows[0].id, created: false };
  const { rows } = await client.query(
    `INSERT INTO appointments (patient_id, patient_name, file_no, doctor_name, doctor_id,
                               appointment_date, time_slot, visit_type, is_walkin, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, 'Slot capacity test data')
     RETURNING id`,
    [
      patientId,
      p.name,
      fileNo(p),
      DOCTOR,
      doctorId,
      date,
      slot,
      visitType,
      p.type === "walkin",
      status,
    ],
  );
  return { id: rows[0].id, created: true };
}

async function create(client) {
  const doctorId = await ensureDoctor(client);
  await ensureTemplate(client, doctorId);
  const plan = dayPlan({ hours: hours.map((h) => ({ ...h })), breaks: [] }, BOOK_DATE);
  const slot = plan.slots?.[0]?.label || "10 AM to 10:30 AM";
  if (weekdayOf(BOOK_DATE) === 0) throw new Error("Booking date is a Sunday.");
  for (const p of PATIENTS) {
    const patientId = await ensurePatient(client, p);
    if (p.type === "followup") {
      await ensureAppointment(client, {
        patientId,
        p,
        doctorId,
        date: PAST_VISIT,
        slot,
        status: "completed",
        visitType: "New Patient",
      });
    }
    const appt = await ensureAppointment(client, {
      patientId,
      p,
      doctorId,
      date: BOOK_DATE,
      slot,
      status: "scheduled",
      visitType: VISIT_TYPE[p.type],
    });
    console.log(
      `${fileNo(p)} #${patientId} ${p.name} → ${BOOK_DATE} ${slot} (${p.type})${appt.created ? "" : " [already booked]"}`,
    );
  }
  const { rows } = await client.query(
    `SELECT a.patient_name,
            CASE WHEN a.is_walkin THEN 'walkin'
                 WHEN appointment_patient_came_before(a.patient_id, a.appointment_date) THEN 'followup'
                 ELSE 'new' END AS counted_as
       FROM appointments a
      WHERE a.doctor_id = $1 AND a.appointment_date = $2::date
      ORDER BY a.file_no`,
    [doctorId, BOOK_DATE],
  );
  console.log("How the system counts them:");
  for (const r of rows) console.log(`  ${r.patient_name}: ${r.counted_as}`);
}

const phoneOf = (p) => `99999991${String(p.n).padStart(2, "0")}`;

async function setPhones(client) {
  for (const p of PATIENTS) {
    const pt = await client.query(
      `UPDATE patients SET phone = $2 WHERE file_no = $1 AND phone IS DISTINCT FROM $2 RETURNING id`,
      [fileNo(p), phoneOf(p)],
    );
    const ap = await client.query(
      `UPDATE appointments SET phone = $2 WHERE file_no = $1 AND phone IS DISTINCT FROM $2`,
      [fileNo(p), phoneOf(p)],
    );
    console.log(
      `${fileNo(p)} ${p.name} → ${phoneOf(p)} (patient ${pt.rowCount ? "updated" : "already set"}, ${ap.rowCount} appointments)`,
    );
  }
}

async function clearSlots(client) {
  const { rows } = await client.query(
    `UPDATE appointments
        SET time_slot = NULL, reporting_time_slot = NULL, preferred_time_slot = NULL,
            booking_status = CASE WHEN booking_status = 'booked' THEN NULL ELSE booking_status END
      WHERE file_no LIKE $1
        AND appointment_date >= $2::date
        AND COALESCE(status, '') NOT IN ('completed', 'seen', 'in_visit', 'in-progress')
      RETURNING file_no, patient_name, appointment_date::text AS date`,
    [`${FILE_PREFIX}%`, EFFECTIVE_FROM],
  );
  for (const r of rows) console.log(`${r.file_no} ${r.patient_name} ${r.date} → no time slot`);
  console.log(`Cleared ${rows.length} bookings`);
}

async function move(client) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(moveTo))
    throw new Error("--move-to needs a date like 2026-10-23.");
  if (weekdayOf(moveTo) === 0) throw new Error("The test consultant does not work on Sundays.");
  const { rows } = await client.query(
    `UPDATE appointments a SET appointment_date = $2::date
       FROM doctors d
      WHERE d.name = $1 AND a.doctor_id = d.id AND a.file_no LIKE $3
        AND a.status = 'scheduled' AND a.appointment_date >= $4::date
      RETURNING a.file_no, a.patient_name, a.time_slot`,
    [DOCTOR, moveTo, `${FILE_PREFIX}%`, EFFECTIVE_FROM],
  );
  for (const r of rows) console.log(`${r.file_no} ${r.patient_name} → ${moveTo} ${r.time_slot}`);
  console.log(`Moved ${rows.length} bookings`);
}

async function remove(client) {
  const doc = await client.query(`SELECT id FROM doctors WHERE name = $1`, [DOCTOR]);
  const doctorId = doc.rows[0]?.id ?? null;
  const appts = await client.query(
    `SELECT id FROM appointments WHERE file_no LIKE $1 OR ($2::int IS NOT NULL AND doctor_id = $2)`,
    [`${FILE_PREFIX}%`, doctorId],
  );
  const ids = appts.rows.map((r) => r.id);
  for (const table of [
    "booking_approvals",
    "appointment_change_log",
    "appointment_reassignments",
  ]) {
    const exists = await client.query(`SELECT to_regclass($1) AS t`, [table]);
    if (!exists.rows[0].t) continue;
    const r = await client.query(`DELETE FROM ${table} WHERE appointment_id = ANY($1::int[])`, [
      ids,
    ]);
    if (r.rowCount) console.log(`Deleted ${r.rowCount} ${table} rows`);
  }
  const visits = await client.query(
    `DELETE FROM giniflow_visits WHERE appointment_id = ANY($1::int[])`,
    [ids],
  );
  if (visits.rowCount) console.log(`Deleted ${visits.rowCount} giniflow_visits rows`);
  const a = await client.query(`DELETE FROM appointments WHERE id = ANY($1::int[])`, [ids]);
  console.log(`Deleted ${a.rowCount} appointments`);
  const p = await client.query(`DELETE FROM patients WHERE file_no LIKE $1`, [`${FILE_PREFIX}%`]);
  console.log(`Deleted ${p.rowCount} patients`);
  if (doctorId) {
    await client.query(`DELETE FROM doctor_slot_templates WHERE doctor_id = $1`, [doctorId]);
    await client.query(`DELETE FROM doctors WHERE id = $1`, [doctorId]);
    console.log(`Deleted doctor #${doctorId} and its schedule`);
  }
}

const client = await pool.connect();
try {
  await busyCheck(client);
  await client.query("BEGIN");
  if (mode === "remove") await remove(client);
  else if (mode === "move") await move(client);
  else if (mode === "phones") await setPhones(client);
  else if (mode === "clear-slots") await clearSlots(client);
  else await create(client);
  if (mode === "dry-run" || (["move", "phones", "clear-slots"].includes(mode) && !write)) {
    await client.query("ROLLBACK");
    console.log("\nDry run — rolled back. Run with --apply to write, or --remove to delete.");
  } else {
    await client.query("COMMIT");
    console.log(
      `\n${{ remove: "Removed", move: "Moved", phones: "Phones set", "clear-slots": "Slots cleared" }[mode] || "Written"}.`,
    );
  }
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Failed:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
