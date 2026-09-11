import {
  CHAIN,
  HEALTHRAY_STATUS_TO_CHAIN,
  EXCEPTION_STATUSES,
  TERMINAL_STATUSES,
} from "../../../shared/giniflowStatus.js";
import { LAB_RUNGS, stageIndexOf, UNDRAWN_SAMPLE_STATUSES } from "../../../shared/labStages.js";
import { healthrayTarget } from "../../../shared/manualFloor.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";

// What HealthRay says, recorded beside where the floor actually is
// (docs/gini-flow/39-HYBRID-FLOOR-PLAN.md §5.3).
//
// The chain position belongs to the floor. This writes HealthRay's position
// alongside it and names the first station whose step nobody recorded, so a
// patient the hospital has already seen while Scribe still has them at vitals
// reads as a desk that is behind rather than as a patient who vanished.
//
// Only an OBSERVATION. It moves nobody. Step 4 of the plan is what makes the
// gap block an auto write; this exists first so that decision is made against a
// week of real numbers rather than a guess at how big the gap is.

// The stations that can be behind, in the order the patient meets them. Rx and
// Pharmacy are absent deliberately: they come AFTER the steps HealthRay knows
// about, so HealthRay can never be ahead of them — a slow counter is an SLA
// question, which the board already times.
export const BEHIND_STATIONS = ["reception", "vitals", "lab", "lab_results", "machine"];

export const BEHIND_STATION_LABEL = {
  reception: "Reception",
  vitals: "Vitals",
  lab: "Lab 1 — collection",
  lab_results: "Lab 2 — results",
  machine: "Machine Room",
};

const quoted = (values) => values.map((v) => `'${v}'`).join(", ");

const statusesBefore = (key) =>
  LAB_RUNGS.filter((r) => stageIndexOf(r.key) < stageIndexOf(key)).flatMap((r) => r.sampleStatuses);

// A tube nobody has drawn yet — the collection bench's step. Shared with the
// machine room, which will not start a test while blood is still owed.
const UNDRAWN = UNDRAWN_SAMPLE_STATUSES;

// Drawn, and no result filed — the analyzer bench's step.
const UNREPORTED = statusesBefore("reported").filter((s) => !UNDRAWN.includes(s));

// Where a status sits on the chain, as a number SQL can compare. Built from the
// chain itself so a status added there cannot silently rank as unknown.
const chainIdx = (col) =>
  `CASE ${col} ${CHAIN.map((s, i) => `WHEN '${s}' THEN ${i}`).join(" ")} ELSE -1 END`;

// Where HealthRay's own status sits on that same chain, through the same
// resolver the sync writes with — so "ahead" means ahead of what the sync would
// have done, not ahead of a second opinion about it. `cancelled` and `no_show`
// are not chain statuses and rank -1: an absence is never ahead of anybody.
const healthrayIdx = (col) =>
  `CASE ${col} ${Object.keys(HEALTHRAY_STATUS_TO_CHAIN)
    .map(
      (hr) => `WHEN '${hr}' THEN ${CHAIN.indexOf(healthrayTarget(hr, HEALTHRAY_STATUS_TO_CHAIN))}`,
    )
    .join(" ")} ELSE -1 END`;

// HealthRay's raw status as a position on our chain, for a screen that wants to
// say "HealthRay: with consultant" rather than "HealthRay: in_visit". Same
// resolver the sync writes with, so the card cannot claim a different reading
// than the one the observation was computed from.
export const healthrayChainStatus = (healthrayStatus) =>
  healthrayStatus ? healthrayTarget(healthrayStatus, HEALTHRAY_STATUS_TO_CHAIN) || null : null;

const OFF_THE_DAY = [...EXCEPTION_STATUSES, ...TERMINAL_STATUSES];

// The first station that owes a step for ONE visit — the enforcement half of
// the same question the day-wide observation answers.
//
// Deliberately the same SQL predicates, in one place: if the gate and the panel
// judged "recorded" differently, the floor would be held at a station the panel
// says is up to date, which is the worst of both.
export async function firstUnrecordedStation(db, visitId) {
  const { rows } = await db.query(
    `SELECT CASE
              WHEN NOT s.arrived THEN 'reception'
              WHEN NOT s.lab_only AND NOT s.vitals_recorded THEN 'vitals'
              WHEN s.lab_undrawn THEN 'lab'
              WHEN s.lab_unreported THEN 'lab_results'
              WHEN s.machine_open THEN 'machine'
              ELSE NULL
            END AS behind
       FROM (
         SELECT EXISTS (
                  SELECT 1 FROM giniflow_visit_events e
                   WHERE e.visit_id = v.id AND e.status = 'checked_in'
                     AND e.actor_role <> 'system'
                ) AS arrived,
                (
                  EXISTS (SELECT 1 FROM giniflow_vitals g WHERE g.visit_id = v.id)
                  OR EXISTS (
                    SELECT 1 FROM giniflow_visit_events e
                     WHERE e.visit_id = v.id
                       AND e.status IN ('with_vitals', 'vitals_done')
                       AND e.actor_role <> 'system'
                  )
                ) AS vitals_recorded,
                ${labOnlyPredicate("v", "$2")} AS lab_only,
                EXISTS (
                  SELECT 1 FROM giniflow_lab_orders o
                   WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
                     AND o.sample_status IN (${quoted(UNDRAWN)})
                ) AS lab_undrawn,
                EXISTS (
                  SELECT 1 FROM giniflow_lab_orders o
                   WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
                     AND o.sample_status IN (${quoted(UNREPORTED)})
                ) AS lab_unreported,
                EXISTS (
                  SELECT 1 FROM giniflow_lab_orders o
                   WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'machine'
                     AND o.sample_status <> 'reported'
                ) AS machine_open
           FROM giniflow_visits v WHERE v.id = $1
       ) s`,
    [visitId, LAB_ONLY_DOCTOR],
  );
  return rows[0]?.behind ?? null;
}

export async function recordHealthrayObservation(client, day) {
  const { rows } = await client.query(
    `WITH obs AS (
       -- One row per PATIENT, tie-broken exactly as the sync's own read is, so
       -- the observation cannot name a different appointment than the one the
       -- sync acted on.
       SELECT DISTINCT ON (a.patient_id) a.patient_id, a.status
         FROM appointments a
        WHERE a.appointment_date = $1::date
          AND a.patient_id IS NOT NULL
        ORDER BY a.patient_id,
                 CASE a.status
                   WHEN 'completed' THEN 4
                   WHEN 'seen'      THEN 4
                   WHEN 'in_visit'  THEN 3
                   WHEN 'checkedin' THEN 2
                   WHEN 'scheduled' THEN 1
                   ELSE 0
                 END DESC,
                 a.id DESC
     ),
     state AS (
       SELECT v.id,
              obs.status AS hr,
              ${healthrayIdx("obs.status")} > ${chainIdx("v.current_status")} AS ahead,
              -- Reception's own step. The actor_role test is the whole point:
              -- an arrival the sync wrote is not an arrival the desk recorded,
              -- and step 1 stopped writing those anyway.
              EXISTS (
                SELECT 1 FROM giniflow_visit_events e
                 WHERE e.visit_id = v.id AND e.status = 'checked_in'
                   AND e.actor_role <> 'system'
              ) AS arrived,
              (
                EXISTS (SELECT 1 FROM giniflow_vitals g WHERE g.visit_id = v.id)
                OR EXISTS (
                  SELECT 1 FROM giniflow_visit_events e
                   WHERE e.visit_id = v.id
                     AND e.status IN ('with_vitals', 'vitals_done')
                     AND e.actor_role <> 'system'
                )
              ) AS vitals_recorded,
              -- A samples-only registration never takes vitals and never sees a
              -- doctor, so that station cannot be behind for them.
              ${labOnlyPredicate("v", "$2")} AS lab_only,
              EXISTS (
                SELECT 1 FROM giniflow_lab_orders o
                 WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
                   AND o.sample_status IN (${quoted(UNDRAWN)})
              ) AS lab_undrawn,
              EXISTS (
                SELECT 1 FROM giniflow_lab_orders o
                 WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
                   AND o.sample_status IN (${quoted(UNREPORTED)})
              ) AS lab_unreported,
              EXISTS (
                SELECT 1 FROM giniflow_lab_orders o
                 WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'machine'
                   AND o.sample_status <> 'reported'
              ) AS machine_open
         FROM giniflow_visits v
         JOIN obs ON obs.patient_id = v.patient_id
        WHERE v.visit_date = $1::date
          -- A patient who went home, or never came, is nobody's backlog.
          AND v.current_status <> ALL($3::text[])
     ),
     decided AS (
       SELECT s.id, s.hr,
              CASE
                WHEN NOT s.ahead THEN NULL
                WHEN NOT s.arrived THEN 'reception'
                WHEN NOT s.lab_only AND NOT s.vitals_recorded THEN 'vitals'
                WHEN s.lab_undrawn THEN 'lab'
                WHEN s.lab_unreported THEN 'lab_results'
                WHEN s.machine_open THEN 'machine'
                ELSE NULL
              END AS behind
         FROM state s
     )
     UPDATE giniflow_visits v
        SET healthray_status = d.hr,
            healthray_status_at = NOW(),
            behind_station = d.behind
       FROM decided d
      WHERE v.id = d.id
        -- Written only when something actually changed, which is what makes the
        -- observed_at stamp mean "since when" rather than "last polled" — the
        -- Behind panel needs how long the gap has stood. It also keeps a
        -- 30-second loop from rewriting every row on the floor all day.
        AND (v.healthray_status IS DISTINCT FROM d.hr
             OR v.behind_station IS DISTINCT FROM d.behind)
      RETURNING v.behind_station`,
    [day, LAB_ONLY_DOCTOR, OFF_THE_DAY],
  );

  const behind = rows.filter((r) => r.behind_station).length;
  return { observed: rows.length, behind };
}

// The patients behind each desk — the worklist half of the panel.
//
// Ordered by how long the gap has stood, worst first: the floor manager wants
// the patient who has been waiting on a tick for an hour, not the one from two
// minutes ago. Capped, because a panel is something you work through, and a
// list of 300 is a report.
export async function getBehindVisits(day, db, { station = null, limit = 60 } = {}) {
  const wanted = BEHIND_STATIONS.includes(station) ? station : null;
  const { rows } = await db.query(
    `SELECT v.id AS visit_id, v.behind_station, v.current_status, v.healthray_status,
            round(extract(epoch FROM NOW() - v.healthray_status_at) / 60)::int AS minutes,
            p.id AS patient_id, p.name, p.file_no,
            COALESCE(doc.short_name, sd.short_name) AS doctor
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
       LEFT JOIN doctors sd ON sd.id = v.assigned_sd_id
      WHERE v.visit_date = $1::date
        AND v.behind_station IS NOT NULL
        AND ($2::text IS NULL OR v.behind_station = $2)
        AND NOT COALESCE(p.is_blocked, FALSE)
      ORDER BY v.healthray_status_at
      LIMIT $3`,
    [day, wanted, limit],
  );
  return rows.map((r) => ({
    visitId: r.visit_id,
    patientId: r.patient_id,
    name: r.name,
    fileNo: r.file_no,
    doctor: r.doctor,
    station: r.behind_station,
    stationLabel: BEHIND_STATION_LABEL[r.behind_station] || r.behind_station,
    // Both readings, side by side — the whole point of the screen is that they
    // disagree, so neither is presented as the truth.
    scribeStatus: r.current_status,
    healthrayStatus: healthrayChainStatus(r.healthray_status),
    healthrayRaw: r.healthray_status,
    minutes: r.minutes,
  }));
}

// The Behind panel's read (step 3 builds the screen on this). Grouped by the
// station that owes the step, newest gap last, so the desk with the longest
// queue of un-recorded work reads first.
export async function getBehindTheFloor(day, db) {
  const { rows } = await db.query(
    `SELECT v.behind_station, count(*)::int AS visits,
            round(avg(extract(epoch FROM NOW() - v.healthray_status_at)) / 60)::int AS avg_minutes,
            max(extract(epoch FROM NOW() - v.healthray_status_at) / 60)::int AS worst_minutes
       FROM giniflow_visits v
      WHERE v.visit_date = $1::date AND v.behind_station IS NOT NULL
      GROUP BY 1 ORDER BY 2 DESC`,
    [day],
  );
  return rows.map((r) => ({
    station: r.behind_station,
    label: BEHIND_STATION_LABEL[r.behind_station] || r.behind_station,
    visits: r.visits,
    avgMinutes: r.avg_minutes,
    worstMinutes: r.worst_minutes,
  }));
}
