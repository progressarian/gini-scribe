import "../loadEnv.js";
import pool from "../config/db.js";
import { CHAIN, chainIndex, isChainStatus, isMarkerStatus } from "../../shared/giniflowStatus.js";
import { syncFromStatus } from "../services/giniflow/journey.js";
import { LAB_ONLY_DOCTOR } from "../../shared/labOnly.js";

const FILE_NO = "P_177116";
const DAY = "2026-09-19";
const apply = process.argv.includes("--apply");

const { rows: visits } = await pool.query(
  `SELECT v.id, v.current_status, v.appointment_id, p.name, p.id AS patient_id
     FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
    WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
  [FILE_NO, DAY],
);
if (visits.length !== 1) {
  console.error(`Expected one visit for ${FILE_NO} on ${DAY}, found ${visits.length}`);
  process.exit(1);
}
const visit = visits[0];
console.log("visit", visit);

const { rows: appts } = await pool.query(
  `SELECT id, doctor_name, visit_type, status, healthray_id FROM appointments
    WHERE patient_id = $1 AND appointment_date = $2::date ORDER BY id`,
  [visit.patient_id, DAY],
);
console.table(appts);

const { rows: events } = await pool.query(
  `SELECT id, seq, status, actor_role, occurred_at, meta FROM giniflow_visit_events
    WHERE visit_id = $1 ORDER BY occurred_at, seq`,
  [visit.id],
);
console.table(events.map((e) => ({ ...e, meta: JSON.stringify(e.meta).slice(0, 80) })));

const { rows: steps } = await pool.query(
  `SELECT id, step_order, step_catalog_id, step_name, station, chain_status, status, completed_at
     FROM giniflow_visit_steps
    WHERE visit_id = $1 ORDER BY step_order`,
  [visit.id],
);
console.table(steps);

const wrongExit = events.find(
  (e) => e.status === "exited" && e.meta?.reason === "lab_only_reports_complete",
);
if (visit.current_status !== "exited" || !wrongExit) {
  console.error("Visit is not closed by the lab-only sweep — nothing to repair");
  process.exit(1);
}

const kept = events.filter((e) => e.id !== wrongExit.id && !isMarkerStatus(e.status));
const restoreTo = kept.at(-1)?.status;
if (!restoreTo) {
  console.error("No step before the exit to restore to");
  process.exit(1);
}

const stamped = new Set(kept.map((e) => e.status).filter(isChainStatus));
const evidenced = (st) => stamped.has(st) || stamped.has(CHAIN[chainIndex(st) + 1]);
const { rows: labCases } = await pool.query(
  `SELECT case_no,
          COALESCE(raw_detail_json, raw_list_json)->>'reported_on' AS reported_on
     FROM lab_cases WHERE patient_id = $1 AND case_date = $2::date`,
  [visit.patient_id, DAY],
);
console.table(labCases);
const labFinished = labCases.length > 0 && labCases.every((c) => c.reported_on);
const isLabStep = (s) =>
  !s.chain_status &&
  (/^(lab_|blood_)/.test(s.step_catalog_id || "") || /^lab/i.test(s.station || ""));
const toDone = labFinished ? steps.filter((s) => s.status === "skipped" && isLabStep(s)) : [];
const toReopen = steps.filter(
  (s) =>
    !toDone.includes(s) &&
    (s.status === "skipped" ||
      (s.status === "done" && isChainStatus(s.chain_status) && !evidenced(s.chain_status))),
);
const consult = appts
  .filter(
    (a) =>
      !["cancelled", "no_show"].includes(a.status) &&
      (a.doctor_name || "").trim().toLowerCase() !== LAB_ONLY_DOCTOR.toLowerCase(),
  )
  .at(-1);

console.log(`\nWill delete exit event ${wrongExit.id} (${wrongExit.occurred_at.toISOString()})`);
console.log(`Will restore current_status: exited → ${restoreTo}`);
console.log(
  `Will reopen ${toReopen.length} step(s): ${toReopen.map((s) => s.step_name).join(", ")}`,
);
console.log(
  `Will mark done (finished in HealthRay's lab): ${toDone.map((s) => s.step_name).join(", ") || "none"}`,
);
console.log(
  consult
    ? `Will point the visit at appointment ${consult.id} (${consult.doctor_name}, ${consult.visit_type})`
    : "No consultant appointment found — appointment_id left as is",
);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to write.");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`DELETE FROM giniflow_visit_events WHERE id = $1`, [wrongExit.id]);
  await client.query(
    `UPDATE giniflow_visits
        SET current_status = $2,
            appointment_id = COALESCE($3, appointment_id),
            updated_at = NOW()
      WHERE id = $1`,
    [visit.id, restoreTo, consult?.id ?? null],
  );
  if (toReopen.length) {
    await client.query(
      `UPDATE giniflow_visit_steps
          SET status = 'pending', started_at = NULL, completed_at = NULL
        WHERE id = ANY($1::uuid[])`,
      [toReopen.map((s) => s.id)],
    );
  }
  if (toDone.length) {
    await client.query(
      `UPDATE giniflow_visit_steps
          SET status = 'done', started_at = COALESCE(started_at, NOW()),
              completed_at = COALESCE(completed_at, NOW())
        WHERE id = ANY($1::uuid[])`,
      [toDone.map((s) => s.id)],
    );
  }
  await syncFromStatus(client, visit.id, restoreTo);
  await client.query("COMMIT");
  console.log("\nApplied.");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
