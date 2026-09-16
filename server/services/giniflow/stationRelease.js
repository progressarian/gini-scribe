import pool from "../../config/db.js";
import { cancelDrawing, markLabCaseAction } from "./labStation.js";
import { cancelMachineStart } from "./machineStation.js";

export async function releaseVisit(visitId, { actorId = null, reason }, db = pool) {
  const { rows: visit } = await db.query(
    `SELECT v.id, v.visit_date, v.patient_id, p.file_no
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!visit.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const { visit_date: day, patient_id: patientId, file_no: fileNo } = visit[0];

  const { rows: orders } = await db.query(
    `SELECT id, kind FROM giniflow_lab_orders
      WHERE visit_id = $1 AND urgency = 'today'
        AND ((kind = 'lab' AND sample_status = 'drawing')
          OR (kind = 'machine' AND sample_status = 'in_progress'))`,
    [visitId],
  );
  const { rows: cases } = await db.query(
    `SELECT lc.case_no FROM lab_cases lc
      WHERE lc.case_date = $1
        AND (lc.patient_id = $2
             OR (lc.patient_id IS NULL AND lc.raw_list_json->'patient'->>'healthray_uid' = $3))
        AND EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                     WHERE a.case_no = lc.case_no AND a.action = 'drawing_started')
        AND NOT EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                         WHERE a.case_no = lc.case_no AND a.action = 'sample_taken')`,
    [day, patientId, fileNo],
  );
  if (!orders.length && !cases.length) {
    throw Object.assign(new Error("No station is holding this patient"), { status: 409 });
  }

  const released = [];
  const by = { actorId, actorRole: "coordinator", reason };
  for (const o of orders) {
    const r =
      o.kind === "lab"
        ? await cancelDrawing(o.id, by, db)
        : await cancelMachineStart(o.id, { ...by, station: null }, db);
    if (r.cancelled) released.push({ orderId: o.id, kind: o.kind });
  }
  for (const c of cases) {
    await markLabCaseAction(
      c.case_no,
      { action: "drawing_started", undo: true, actorId, actorRole: "coordinator" },
      db,
    );
    released.push({ caseNo: c.case_no, kind: "lab" });
  }

  if (!released.length) {
    throw Object.assign(new Error("The station finished before the release — nothing to free"), {
      status: 409,
    });
  }
  await db.query(
    `INSERT INTO giniflow_triage_events (visit_id, action, actor_id, note)
     VALUES ($1, 'station_release', $2, $3)`,
    [visitId, actorId, reason],
  );
  return { visitId, released };
}
