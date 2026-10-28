import { CONSULT_STATUSES, LAB_ONLY_DOCTOR, isLabOnlyDoctor } from "../../../shared/labOnly.js";
import { CHAIN, chainIndex } from "../../../shared/giniflowStatus.js";
import { slotStartTime } from "../../../shared/slotHour.js";
import { LIVE_LAB_CASE_SQL } from "./testsHold.js";

export { LAB_ONLY_DOCTOR };
export const labOnlyPredicate = (visit, param) => `(
  ${visit}.id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM appointments la
     WHERE la.patient_id = ${visit}.patient_id
       AND la.appointment_date = ${visit}.visit_date
       AND lower(btrim(la.doctor_name)) = lower(${param})
  )
  AND NOT EXISTS (
    SELECT 1 FROM appointments oa
     WHERE oa.patient_id = ${visit}.patient_id
       AND oa.appointment_date = ${visit}.visit_date
       AND lower(COALESCE(btrim(oa.doctor_name), '')) <> lower(${param})
  )
  AND (
    ${visit}.assigned_doctor_id IS NULL
    OR EXISTS (
      SELECT 1 FROM doctors lod
       WHERE lod.id = ${visit}.assigned_doctor_id
         AND lower(btrim(lod.name)) = lower(${param})
    )
  )
)`;
export const labOnlyHiddenPredicate = (visit, doctorParam, hideParam) =>
  `(${hideParam}::boolean AND ${labOnlyPredicate(visit, doctorParam)})`;

async function labMarks(db, { visitDate, patientId, fileNo }) {
  const { rows: lab } = await db.query(
    `SELECT min(COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at') AS registered,
            max(COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on')   AS reported,
            count(*)::int                                                          AS cases,
            count(*) FILTER (
              WHERE COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' IS NULL
            )::int                                                                 AS pending
       FROM lab_cases lc
      WHERE lc.case_date = $1::date
        AND (lc.patient_id = $2
             OR (lc.patient_id IS NULL AND lc.raw_list_json->'patient'->>'healthray_uid' = $3))
        AND ${LIVE_LAB_CASE_SQL("lc")}`,
    [visitDate, patientId, fileNo],
  );

  const marks = [];
  if (lab[0]?.registered)
    marks.push({
      status: "lab_registered",
      label: "Lab registered",
      at: new Date(lab[0].registered),
    });
  if (lab[0]?.reported && lab[0].pending === 0)
    marks.push({ status: "lab_reported", label: "Reports ready", at: new Date(lab[0].reported) });
  return marks;
}

const shapeMarks = (marks, now, timestampOnly = false) =>
  [...marks]
    .sort((a, b) => a.at - b.at)
    .map((m, i, sorted) => {
      const next = sorted[i + 1];
      const ended = m.status === "lab_reported";
      const minutes = next ? Math.max(0, Math.round((next.at - m.at) / 60000)) : null;
      return {
        status: m.status,
        label: m.label,
        plain: true,
        enteredAt: m.at.toISOString(),
        leftAt: next ? next.at.toISOString() : null,
        waitMinutes: 0,
        waitBudget: null,
        stationMinutes: minutes ?? 0,
        stationBudget: null,
        totalMinutes: minutes,
        budgetMinutes: null,
        overBy: 0,
        colour: "neutral",
        isCurrent: !next && !ended,
        timestampOnly,
        meta: null,
      };
    });

export async function getLabOnlyTimeline(db, { visitId, visitDate, patientId, fileNo }, now) {
  const { rows: ev } = await db.query(
    `SELECT occurred_at FROM giniflow_visit_events
      WHERE visit_id = $1 AND status = 'checked_in' ORDER BY occurred_at LIMIT 1`,
    [visitId],
  );
  const marks = await labMarks(db, { visitDate, patientId, fileNo });
  if (ev[0]?.occurred_at)
    marks.push({ status: "checked_in", label: "Checked in", at: new Date(ev[0].occurred_at) });
  return shapeMarks(marks, now, true);
}

export async function getLabTrack(db, ids, now) {
  return shapeMarks(await labMarks(db, ids), now, true);
}

export const ARRIVED_FOR_APPOINTMENT = "arrived_for_appointment";

export const APPOINTMENT_ARRIVED_AT_SQL = (visit) => `(
  SELECT max(ae.occurred_at) FROM giniflow_visit_events ae
   WHERE ae.visit_id = ${visit}.id AND ae.status = 'checked_in'
     AND ae.meta->>'reason' = '${ARRIVED_FOR_APPOINTMENT}'
)`;

const BEFORE_ANY_DOCTOR = CHAIN.slice(0, chainIndex("with_sd"));

export async function followRebookingToLabOnly(db, { appointmentId, previousDoctor }) {
  if (!appointmentId || !previousDoctor || isLabOnlyDoctor(previousDoctor)) return null;
  const { rows } = await db.query(
    `SELECT v.id, a.time_slot
       FROM giniflow_visits v
       JOIN appointments a ON a.id = v.appointment_id AND a.appointment_date = v.visit_date
       JOIN doctors d ON d.id = v.assigned_doctor_id
      WHERE a.id = $1
        AND lower(btrim(a.doctor_name)) = lower($2)
        AND lower(btrim(d.name)) = lower(btrim($3))
        AND v.current_status = ANY($4)
        AND NOT EXISTS (
          SELECT 1 FROM appointments oa
           WHERE oa.patient_id = v.patient_id
             AND oa.appointment_date = v.visit_date
             AND lower(COALESCE(btrim(oa.doctor_name), '')) <> lower($2)
        )`,
    [appointmentId, LAB_ONLY_DOCTOR, previousDoctor, BEFORE_ANY_DOCTOR],
  );
  if (!rows.length) return null;
  const { id, time_slot } = rows[0];
  await db.query(
    `WITH dropped AS (
       DELETE FROM giniflow_visit_steps
        WHERE visit_id = $1 AND status = 'pending'
          AND (step_catalog_id = 'billing' OR chain_status = ANY($3))
       RETURNING planned_duration_min
     )
     UPDATE giniflow_visits v
        SET assigned_doctor_id = NULL,
            appointment_time = COALESCE($2::time, v.appointment_time),
            planned_total_min = v.planned_total_min
              - (SELECT COALESCE(sum(planned_duration_min), 0)::int FROM dropped),
            updated_at = NOW()
      WHERE v.id = $1`,
    [id, slotStartTime(time_slot), CONSULT_STATUSES],
  );
  return id;
}

const CONSULT_STOPS_SQL = CONSULT_STATUSES.map((s) => `'${s}'`).join(", ");

export const consultBookingSql = (visit, param) => `(
  SELECT ca.id FROM appointments ca
   WHERE ca.patient_id = ${visit}.patient_id
     AND ca.appointment_date = ${visit}.visit_date
     AND ca.status NOT IN ('cancelled', 'no_show')
     AND btrim(COALESCE(ca.doctor_name, '')) <> ''
     AND lower(btrim(ca.doctor_name)) <> lower(${param})
   ORDER BY ca.id DESC LIMIT 1
)`;

export const awaitsAppointmentArrivalSql = (visit, param) => `(
  ${visit}.merged_into_visit_id IS NULL
  AND (
    ${visit}.current_status = 'checked_in'
    OR (${visit}.current_status = 'exited'
        AND EXISTS (SELECT 1 FROM giniflow_visit_events xe
                     WHERE xe.visit_id = ${visit}.id AND xe.status = 'exited'
                       AND xe.meta->>'reason' = 'lab_only_reports_complete'))
  )
  AND EXISTS (SELECT 1 FROM giniflow_visit_events ce
               WHERE ce.visit_id = ${visit}.id AND ce.status = 'checked_in')
  AND EXISTS (SELECT 1 FROM giniflow_visit_steps ls WHERE ls.visit_id = ${visit}.id)
  AND NOT EXISTS (SELECT 1 FROM giniflow_visit_steps cs
                   WHERE cs.visit_id = ${visit}.id AND cs.status <> 'skipped'
                     AND cs.chain_status IN (${CONSULT_STOPS_SQL}))
  AND ${consultBookingSql(visit, param)} IS NOT NULL
)`;
