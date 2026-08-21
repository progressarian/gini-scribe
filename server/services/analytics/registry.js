import {
  AGE_BANDS,
  RECENCY_BANDS,
  CONTINUITY_DAYS,
  HISTORY_START_DATE,
  VISIT_STATUSES_COUNTED,
} from "./constants.js";
import { countBy, describe, median, monthOf, pct, quarterOf, round } from "./stats.js";

export function buildRegistry(patients, { asOf }) {
  const total = patients.length;
  const withVisit = patients.filter((p) => p.first_visit);
  const continuing = withVisit.filter((p) => p.continuing);

  const cohortCounts = countBy(
    withVisit.filter((p) => p.first_visit >= HISTORY_START_DATE),
    (p) => quarterOf(p.first_visit),
  );
  const growth = [...cohortCounts.entries()]
    .map(([quarter, count]) => ({ quarter, new_patients: count }))
    .sort((a, b) => a.quarter.localeCompare(b.quarter));
  let running = 0;
  for (const row of growth) {
    running += row.new_patients;
    row.cumulative = running;
  }

  const demographics = [];
  for (const band of AGE_BANDS) {
    const inBand = withVisit.filter((p) => p.ageBand === band.key);
    demographics.push({
      age_band: band.label,
      male: inBand.filter((p) => p.sex === "Male").length,
      female: inBand.filter((p) => p.sex === "Female").length,
      unspecified: inBand.filter((p) => p.sex === "Unspecified").length,
      total: inBand.length,
    });
  }
  const unknownAge = withVisit.filter((p) => p.ageBand == null).length;

  const recency = RECENCY_BANDS.map((band) => {
    const n = withVisit.filter((p) => p.recency === band.key).length;
    return { band: band.label, patients: n, share_pct: pct(n, withVisit.length) };
  });

  const visitBuckets = new Map([
    ["1 visit", 0],
    ["2 visits", 0],
    ["3-5 visits", 0],
    ["6-10 visits", 0],
    ["11+ visits", 0],
  ]);
  for (const p of withVisit) {
    const n = p.visit_days;
    const key =
      n === 1
        ? "1 visit"
        : n === 2
          ? "2 visits"
          : n <= 5
            ? "3-5 visits"
            : n <= 10
              ? "6-10 visits"
              : "11+ visits";
    visitBuckets.set(key, visitBuckets.get(key) + 1);
  }

  return {
    asOf,
    kpis: {
      registered_patients: total,
      patients_with_visit: withVisit.length,
      patients_without_visit: total - withVisit.length,
      continuing_patients: continuing.length,
      continuing_share_pct: pct(continuing.length, withVisit.length),
      lapsed_patients: withVisit.length - continuing.length,
      median_visits_per_patient: round(median(withVisit.map((p) => p.visit_days)), 1),
      median_tenure_days: round(median(withVisit.map((p) => p.tenure_days)), 0),
    },
    growth,
    demographics,
    unknown_age_patients: unknownAge,
    recency,
    visit_distribution: [...visitBuckets.entries()].map(([bucket, patients]) => ({
      bucket,
      patients,
      share_pct: pct(patients, withVisit.length),
    })),
    tenure: describe(
      withVisit.map((p) => p.tenure_days),
      0,
    ),
    notes: [
      "Registration date is derived as the patient's first recorded visit. patients.created_at is not usable: every row carries a bulk-import timestamp.",
      `Continuing means a visit within ${CONTINUITY_DAYS} days of ${asOf}. Everything else is counted as lapsed.`,
      "Visit counts are distinct visit days, merging consultations and attended appointments so one day is never double-counted.",
    ],
  };
}

export async function getVisitVolume(db, { asOf }) {
  const sql = `
    WITH visit_events AS (
      SELECT patient_id, visit_date AS d, 'consultation' AS src FROM consultations
       WHERE patient_id IS NOT NULL AND visit_date BETWEEN $1::date AND $2::date
      UNION ALL
      SELECT patient_id, appointment_date AS d, 'appointment' AS src FROM appointments
       WHERE patient_id IS NOT NULL AND appointment_date BETWEEN $1::date AND $2::date
         AND status = ANY($3::text[])
    ),
    visit_days AS (SELECT patient_id, d FROM visit_events GROUP BY patient_id, d)
    SELECT to_char(d, 'YYYY-MM') AS month,
           COUNT(*) AS visits,
           COUNT(DISTINCT patient_id) AS patients
      FROM visit_days
     GROUP BY 1 ORDER BY 1`;
  const { rows } = await db.query(sql, [HISTORY_START_DATE, asOf, VISIT_STATUSES_COUNTED]);
  return rows.map((r) => ({
    month: r.month,
    visits: Number(r.visits),
    patients: Number(r.patients),
  }));
}

export async function getAttendance(db, { asOf }) {
  const sql = `
    SELECT status, COUNT(*) AS n, to_char(appointment_date, 'YYYY-MM') AS month
      FROM appointments
     WHERE appointment_date BETWEEN $1::date AND $2::date AND status IS NOT NULL
     GROUP BY status, month`;
  const { rows } = await db.query(sql, [HISTORY_START_DATE, asOf]);

  const totals = new Map();
  const byMonth = new Map();
  for (const r of rows) {
    const n = Number(r.n);
    totals.set(r.status, (totals.get(r.status) || 0) + n);
    const m = byMonth.get(r.month) || { month: r.month, attended: 0, no_show: 0, other: 0 };
    if (r.status === "no_show") m.no_show += n;
    else if (VISIT_STATUSES_COUNTED.includes(r.status)) m.attended += n;
    else m.other += n;
    byMonth.set(r.month, m);
  }

  const attended = [...totals.entries()]
    .filter(([s]) => VISIT_STATUSES_COUNTED.includes(s))
    .reduce((a, [, n]) => a + n, 0);
  const noShow = totals.get("no_show") || 0;

  return {
    by_status: [...totals.entries()]
      .map(([status, n]) => ({ status, appointments: n }))
      .sort((a, b) => b.appointments - a.appointments),
    no_show_rate_pct: pct(noShow, attended + noShow),
    monthly: [...byMonth.values()]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({ ...m, no_show_rate_pct: pct(m.no_show, m.attended + m.no_show) })),
    notes: [
      "Appointment records only exist from 2025 onward. Earlier attendance cannot be measured.",
      "One clinical visit can produce several appointment rows (a cancelled stub plus the attended visit), so status counts are rows, not people.",
    ],
  };
}

export async function getIntervals(db, { asOf }) {
  const sql = `
    WITH visit_events AS (
      SELECT patient_id, visit_date AS d FROM consultations
       WHERE patient_id IS NOT NULL AND visit_date BETWEEN $1::date AND $2::date
      UNION ALL
      SELECT patient_id, appointment_date AS d FROM appointments
       WHERE patient_id IS NOT NULL AND appointment_date BETWEEN $1::date AND $2::date
         AND status = ANY($3::text[])
    ),
    visit_days AS (SELECT patient_id, d FROM visit_events GROUP BY patient_id, d),
    gaps AS (
      SELECT patient_id, d - LAG(d) OVER (PARTITION BY patient_id ORDER BY d) AS gap_days
        FROM visit_days
    )
    SELECT patient_id, gap_days FROM gaps WHERE gap_days IS NOT NULL AND gap_days > 0`;
  const { rows } = await db.query(sql, [HISTORY_START_DATE, asOf, VISIT_STATUSES_COUNTED]);
  const gaps = rows.map((r) => Number(r.gap_days));
  return { intervals: describe(gaps, 0), sample_size: gaps.length };
}

export function buildRetentionCurve(patients, { asOf }) {
  const cohorts = new Map();
  for (const p of patients) {
    if (!p.first_visit || p.first_visit < HISTORY_START_DATE) continue;
    const key = quarterOf(p.first_visit);
    const entry = cohorts.get(key) || {
      cohort: key,
      size: 0,
      retained_180d: 0,
      retained_365d: 0,
      still_active: 0,
    };
    entry.size += 1;
    const span = p.tenure_days;
    const lifespan =
      p.last_visit && p.first_visit ? daysBetweenSafe(p.first_visit, p.last_visit) : 0;
    if (span >= 180 && lifespan >= 180) entry.retained_180d += 1;
    if (span >= 365 && lifespan >= 365) entry.retained_365d += 1;
    if (p.continuing) entry.still_active += 1;
    cohorts.set(key, entry);
  }
  return [...cohorts.values()]
    .sort((a, b) => a.cohort.localeCompare(b.cohort))
    .map((c) => ({
      ...c,
      retained_180d_pct: pct(c.retained_180d, c.size),
      retained_365d_pct: pct(c.retained_365d, c.size),
      still_active_pct: pct(c.still_active, c.size),
    }));
}

function daysBetweenSafe(a, b) {
  const x = new Date(`${a}T00:00:00Z`).getTime();
  const y = new Date(`${b}T00:00:00Z`).getTime();
  if (isNaN(x) || isNaN(y)) return 0;
  return Math.round((y - x) / 86400000);
}

export { monthOf };
