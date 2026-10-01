import pool from "../../config/db.js";
import {
  JOURNEY_START_SQL,
  NOT_A_MARKER_SQL,
  slaKeyForStatus,
} from "../../../shared/giniflowStatus.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { budgetMap } from "./board.js";

export const MAX_REPORT_DAYS = 92;
const NO_BOOKING = "Walk-in (no booking)";

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);
const average = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const VISITS_IN_RANGE = `
  WITH vs AS MATERIALIZED (
    SELECT v.id, v.visit_date, v.patient_id, v.appointment_id
      FROM giniflow_visits v
     WHERE v.visit_date BETWEEN $1::date AND $2::date
       AND NOT ${labOnlyPredicate("v", "$3")}
  )`;

async function journeysIn(db, start, end) {
  const { rows } = await db.query(
    `${VISITS_IN_RANGE},
     marks AS (
       SELECT e.visit_id,
              MAX(e.occurred_at) FILTER (WHERE ${JOURNEY_START_SQL("e.status")}) AS started_at,
              MAX(e.occurred_at) FILTER (WHERE e.status IN ('exited', 'dispensed')) AS finished_at
         FROM giniflow_visit_events e JOIN vs ON vs.id = e.visit_id
        GROUP BY e.visit_id
     )
     SELECT vs.visit_date::text AS day, p.name AS patient_name,
            COALESCE(NULLIF(btrim(a.visit_type), ''), $4) AS visit_type,
            CASE WHEN m.finished_at >= m.started_at
                 THEN EXTRACT(EPOCH FROM (m.finished_at - m.started_at)) / 60 END AS minutes
       FROM vs
       JOIN marks m ON m.visit_id = vs.id AND m.started_at IS NOT NULL
       JOIN patients p ON p.id = vs.patient_id
       LEFT JOIN appointments a ON a.id = vs.appointment_id`,
    [start, end, LAB_ONLY_DOCTOR, NO_BOOKING],
  );
  return rows.map((row) => ({
    ...row,
    minutes: row.minutes === null ? null : Math.max(0, Number(row.minutes)),
  }));
}

async function hopsIn(db, start, end) {
  const { rows } = await db.query(
    `${VISITS_IN_RANGE},
     steps AS (
       SELECT e.status, e.occurred_at,
              LEAD(e.occurred_at) OVER (PARTITION BY e.visit_id ORDER BY e.occurred_at) AS next_at
         FROM giniflow_visit_events e JOIN vs ON vs.id = e.visit_id
        WHERE ${NOT_A_MARKER_SQL("e.status")}
     )
     SELECT status, EXTRACT(EPOCH FROM (next_at - occurred_at)) / 60 AS minutes
       FROM steps WHERE next_at > occurred_at`,
    [start, end, LAB_ONLY_DOCTOR],
  );
  return rows.map((row) => ({ key: slaKeyForStatus(row.status), minutes: Number(row.minutes) }));
}

async function labTurnaroundsIn(db, start, end) {
  const { rows } = await db.query(
    `SELECT EXTRACT(EPOCH FROM (o.uploaded_at - o.created_at)) / 60 AS minutes
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
                             AND v.visit_date BETWEEN $1::date AND $2::date
      WHERE o.uploaded_at IS NOT NULL AND o.kind = 'lab' AND o.uploaded_at >= o.created_at`,
    [start, end],
  );
  return rows.map((row) => ({ key: "lab_total", minutes: Number(row.minutes) }));
}

function bottlenecksOf(hops, slaConfig) {
  const byKey = new Map();
  for (const hop of hops) {
    if (!hop.key || hop.minutes < 0) continue;
    if (!byKey.has(hop.key)) byKey.set(hop.key, []);
    byKey.get(hop.key).push(hop.minutes);
  }
  return slaConfig
    .filter((station) => station.station !== "total_journey" && byKey.has(station.station))
    .map((station) => {
      const minutes = byKey.get(station.station);
      return {
        step_name: station.label,
        station: station.station,
        avg_budget: station.budgetMinutes,
        avg_actual: round1(average(minutes)),
        median_actual: round1(median(minutes)),
        total_count: minutes.length,
        exceeded_count: minutes.filter((value) => value > station.budgetMinutes).length,
      };
    })
    .sort((a, b) => b.median_actual - b.avg_budget - (a.median_actual - a.avg_budget));
}

function complianceOf(finished, target) {
  const byType = new Map();
  for (const journey of finished) {
    const entry = byType.get(journey.visit_type) || { total: 0, within_target: 0 };
    entry.total += 1;
    if (journey.minutes <= target) entry.within_target += 1;
    byType.set(journey.visit_type, entry);
  }
  return [...byType].map(([label, entry]) => ({
    visit_type_id: label,
    label,
    max_time_min: target,
    ...entry,
  }));
}

function dailyOf(journeys, target) {
  const byDay = new Map();
  for (const journey of journeys) {
    if (!byDay.has(journey.day)) byDay.set(journey.day, []);
    byDay.get(journey.day).push(journey);
  }
  return [...byDay.keys()].sort().map((day) => {
    const list = byDay.get(day);
    const finished = list.filter((journey) => journey.minutes !== null);
    const late = target ? finished.filter((journey) => journey.minutes > target) : [];
    const worst = late.reduce((a, b) => (!a || b.minutes > a.minutes ? b : a), null);
    return {
      day,
      patients: list.length,
      completed: finished.length,
      avg_visit_min: finished.length ? Math.round(average(finished.map((j) => j.minutes))) : null,
      within_target: finished.length - late.length,
      breaches: late.length,
      worst_breach: worst
        ? {
            patient_name: worst.patient_name,
            mins: Math.round(worst.minutes),
            max_time_min: target,
          }
        : null,
    };
  });
}

export async function getFlowReport(start, end, slaConfig, db = pool) {
  const budgets = budgetMap(slaConfig);
  const target = budgets.total_journey ?? null;
  const [journeys, hops, labs] = await Promise.all([
    journeysIn(db, start, end),
    hopsIn(db, start, end),
    labTurnaroundsIn(db, start, end),
  ]);
  const finished = journeys.filter((journey) => journey.minutes !== null);
  const breached = target ? finished.filter((journey) => journey.minutes > target).length : 0;
  return {
    start,
    end,
    journey_target_min: target,
    summary: {
      total_visits: journeys.length,
      completed: finished.length,
      breached,
      avg_visit_min: finished.length ? Math.round(average(finished.map((j) => j.minutes))) : null,
    },
    compliance: target ? complianceOf(finished, target) : [],
    bottlenecks: bottlenecksOf([...hops, ...labs], slaConfig),
    daily: dailyOf(journeys, target),
  };
}
