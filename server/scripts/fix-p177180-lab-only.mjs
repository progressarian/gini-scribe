import "../loadEnv.js";
import pool from "../config/db.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "../services/giniflow/labOnlyVisits.js";
import { hideLabOnlyPatients } from "../services/giniflow/floorSettings.js";

const FILE_NO = "P_177180";
const EXPECTED_NAME = /laxmi/i;
const CONSULT_STATUSES = [
  "vitals_pending",
  "with_vitals",
  "vitals_done",
  "sd_pending",
  "with_sd",
  "ready_for_doctor",
  "with_doctor",
  "doctor_done",
  "rx_pending",
  "with_rx",
];
const apply = process.argv.includes("--apply");
const day =
  process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ||
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const isLabOnlyName = (n) =>
  String(n || "")
    .trim()
    .toLowerCase() === LAB_ONLY_DOCTOR.toLowerCase();

const { rows: visits } = await pool.query(
  `SELECT v.id, v.patient_id, v.current_status, v.assigned_doctor_id, p.name,
          d.name AS assigned_doctor, ${labOnlyPredicate("v", "$3")} AS lab_only
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
     LEFT JOIN doctors d ON d.id = v.assigned_doctor_id
    WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
  [FILE_NO, day, LAB_ONLY_DOCTOR],
);
if (visits.length !== 1) {
  console.error(`Expected one visit for ${FILE_NO} on ${day}, found ${visits.length}`);
  process.exit(1);
}
const visit = visits[0];
if (!EXPECTED_NAME.test(visit.name)) {
  console.error(`Refusing: ${FILE_NO} on ${day} is "${visit.name}", not Laxmi`);
  process.exit(1);
}

const { rows: appts } = await pool.query(
  `SELECT id, doctor_name, visit_type, status FROM appointments
    WHERE patient_id = $1 AND appointment_date = $2::date ORDER BY id`,
  [visit.patient_id, day],
);
const { rows: consultEvents } = await pool.query(
  `SELECT status, occurred_at FROM giniflow_visit_events
    WHERE visit_id = $1 AND status = ANY($2::text[]) ORDER BY occurred_at`,
  [visit.id, CONSULT_STATUSES],
);
const hidden = await hideLabOnlyPatients(pool);

console.log(`${visit.name} (${FILE_NO}) · ${day} · status ${visit.current_status}`);
console.log(`Assigned doctor: ${visit.assigned_doctor || "none"}`);
console.log("Bookings that day:");
for (const a of appts) {
  console.log(
    `  #${a.id} ${a.doctor_name ?? "(no doctor)"} · ${a.visit_type ?? "—"} · ${a.status}`,
  );
}
console.log(`Counts as lab-only now: ${visit.lab_only ? "yes" : "no"}`);
console.log(`Floor setting "hide lab-only patients": ${hidden ? "on" : "off"}`);

if (visit.lab_only) {
  console.log(
    hidden
      ? "Nothing to fix in her record — she is hidden from every station once the API is restarted with the Reception fix."
      : "Nothing to fix in her record — turn the floor setting on to hide her.",
  );
  await pool.end();
  process.exit(0);
}

const realBookings = appts.filter((a) => !isLabOnlyName(a.doctor_name));
if (!appts.length || realBookings.length) {
  console.error(
    realBookings.length
      ? `Not changing anything: she is booked with ${realBookings
          .map((a) => a.doctor_name ?? "no doctor (walk-in)")
          .join(
            ", ",
          )} in HealthRay, so she is a consultation patient, not samples-only. Fix the booking in HealthRay if that is wrong.`
      : "Not changing anything: she has no HealthRay booking that day.",
  );
  await pool.end();
  process.exit(1);
}

if (!visit.assigned_doctor_id || isLabOnlyName(visit.assigned_doctor)) {
  console.error(
    "Not changing anything: the cause is not the assigned doctor — look at this by hand.",
  );
  await pool.end();
  process.exit(1);
}
if (consultEvents.length || CONSULT_STATUSES.includes(visit.current_status)) {
  console.error(
    `Not changing anything: she has already been in the consultation flow (${[
      ...consultEvents.map((e) => e.status),
      visit.current_status,
    ].join(", ")}). A doctor may be seeing her.`,
  );
  await pool.end();
  process.exit(1);
}

console.log(
  `Cause: every booking is with ${LAB_ONLY_DOCTOR}, but the visit is assigned to ${visit.assigned_doctor}. Will clear the assigned doctor so she counts as samples-only.`,
);
if (!apply) {
  console.log("Dry run — re-run with --apply.");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rowCount } = await client.query(
    `UPDATE giniflow_visits SET assigned_doctor_id = NULL, updated_at = NOW()
      WHERE id = $1 AND assigned_doctor_id = $2 AND current_status = $3`,
    [visit.id, visit.assigned_doctor_id, visit.current_status],
  );
  if (rowCount !== 1) throw new Error("The visit changed while the script ran");
  const { rows } = await client.query(
    `SELECT ${labOnlyPredicate("v", "$2")} AS lab_only FROM giniflow_visits v WHERE v.id = $1`,
    [visit.id, LAB_ONLY_DOCTOR],
  );
  if (!rows[0]?.lab_only) throw new Error("Still not samples-only after clearing the doctor");
  await client.query("COMMIT");
  console.log("Done — she now counts as samples-only.");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
