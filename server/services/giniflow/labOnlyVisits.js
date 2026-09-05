import { LAB_ONLY_DOCTOR } from "../../../shared/labOnly.js";

export { LAB_ONLY_DOCTOR };

// One definition of "samples-only", shared by every screen that has to place
// such a patient.
//
// It lives here because two screens deriving it separately is exactly how they
// came to contradict each other: the manager board moved these patients out of
// the SD / MO column, while the lab station kept deriving its pill from
// `columnForStatus(current_status)` alone — which knows only the status→column
// map in shared/giniflowStatus.js — and went on calling the same patient
// "With SD / MO" while the board showed that column empty.
//
// Asked of the PATIENT'S day rather than of the visit's own appointment: a visit
// is one row per patient per day and the sync's DISTINCT ON tiebreaks equally
// advanced appointments by id, so testing the carried appointment would
// intermittently classify a patient a consultant is waiting for. A NULL
// doctor_name counts as a real booking — the flow's own walk-ins and OBT rows
// have one — so an unknown provider is never treated as samples-only.
//
// The last clause is what makes it reversible: assigning a real consultant ends
// the samples-only state, and the patient rejoins the ordinary flow.
//
// `visit` is the giniflow_visits alias at the call site, `param` the placeholder
// carrying LAB_ONLY_DOCTOR.
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

// The timeline for a lab-only visit, built only from clocks that exist.
//
// The chain timeline could not tell the truth about these patients. It read the
// `vitals_done` event and drew "Vitals done — 3m wait + 128m station", of which
// three parts were wrong: HealthRay stamps every vitals row at midnight (all 334
// rows over seven days), so the 09:30 was when our poller noticed the row, not
// when anything was measured; the 128m was time-since-that-poll, not time spent
// at a station; and most of those rows carry a weight and height with no BP at
// all, so "vitals" overstates what was done. The event even points at a
// vitals_id the sync has since deleted and re-inserted — 66 of today's events
// reference a row that no longer exists.
//
// HealthRay's lab clocks, by contrast, are real times it recorded itself. So
// this returns arrival plus those, and nothing else.
//
// `collected_on` and `received_on` are deliberately not steps: HealthRay stamps
// them at case close, identical to `reported_on` on 389 of 422 cases, so drawing
// them would invent a collection time the hospital never recorded.
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
             OR (lc.patient_id IS NULL AND lc.raw_list_json->'patient'->>'healthray_uid' = $3))`,
    [visitDate, patientId, fileNo],
  );

  const marks = [];
  if (lab[0]?.registered)
    marks.push({
      status: "lab_registered",
      label: "Lab registered",
      at: new Date(lab[0].registered),
    });
  // Only once every case is back. A part-reported patient is still waiting, and
  // dating the step off the first result would close it early.
  if (lab[0]?.reported && lab[0].pending === 0)
    marks.push({ status: "lab_reported", label: "Reports ready", at: new Date(lab[0].reported) });
  return marks;
}

// `timestampOnly` for the lab-only timeline: those steps are a record of when
// things happened, not a queue anyone is working. A running "waiting 134m" on a
// patient whose reports are already back describes nobody's problem — the floor
// is not waiting on them and they are not waiting on the floor.
const shapeMarks = (marks, now, timestampOnly = false) =>
  [...marks]
    .sort((a, b) => a.at - b.at)
    .map((m, i, sorted) => {
      const next = sorted[i + 1];
      // Reports back is an end, not a stage in progress. Left as "current" it
      // drew the live dot and counted to now, so a visit from a previous day
      // claimed to still be happening — 1,456 minutes and rising.
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

// The lab leg of an ORDINARY visit. The board has always shown these patients on
// two tracks at once — a card in their queue column and a second one in the lab
// track — but the timeline read only giniflow_visit_events, so the lab was
// invisible there. A patient checked in at 10:30 with a sample ordered at 10:44
// showed one step and looked stalled, when the lab was the thing that had moved.
export async function getLabTrack(db, ids, now) {
  return shapeMarks(await labMarks(db, ids), now);
}
