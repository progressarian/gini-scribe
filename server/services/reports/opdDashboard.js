import pool from "../../config/db.js";
import { LAB_ONLY_DOCTOR } from "../../../shared/labOnly.js";
import { OPD_BUCKETS, OPD_TYPE_SETS } from "../../../shared/opdSummary.js";
import { OPD_CONSULTANTS_SHOWN, OPD_TIMES_MIN_VISITS } from "../../../shared/opdMetrics.js";
import { addDays, bucketsOf, previousRange } from "../billing/dashboardPeriods.js";
import { BASE, GROUP_START_SQL, doctorList, typesFor } from "./opdSummary.js";
import { budgetMap, getSlaConfig } from "../giniflow/board.js";
import {
  bottlenecksOf,
  hopRows,
  JOURNEY_MARKS,
  median,
  STEP_HOPS,
  VISIT_MINUTES,
  WAITING_MINUTES,
} from "../giniflow/reports.js";

const CACHE_MS = 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map();

const n = (value) => Number(value) || 0;

const COUNTS = `
  count(*) AS booked,
  count(*) FILTER (WHERE came) AS came,
  count(*) FILTER (WHERE state = 'attended') AS completed,
  count(*) FILTER (WHERE state = 'not_closed' AND day = (SELECT d FROM today)) AS in_progress,
  count(*) FILTER (WHERE state = 'not_closed' AND day < (SELECT d FROM today)) AS not_closed,
  count(*) FILTER (WHERE state = 'booked') AS pending,
  count(*) FILTER (WHERE state = 'not_updated') AS not_updated,
  count(*) FILTER (WHERE state = 'no_show') AS no_show,
  count(*) FILTER (WHERE state = 'cancelled') AS cancelled`;

const countsOf = (r = {}) => {
  const c = {
    booked: n(r.booked),
    came: n(r.came),
    completed: n(r.completed),
    inProgress: n(r.in_progress),
    notClosed: n(r.not_closed),
    pending: n(r.pending),
    notUpdated: n(r.not_updated),
    noShow: n(r.no_show),
    cancelled: n(r.cancelled),
  };
  return { ...c, didNotCome: c.noShow + c.cancelled };
};

const TOTALS_SQL = `${BASE}
  SELECT ${COUNTS},
         count(DISTINCT person) FILTER (WHERE came) AS unique_patients,
         count(*) FILTER (WHERE came AND bucket = 'new') AS new,
         count(*) FILTER (WHERE came AND bucket = 'follow_up') AS follow_up,
         count(*) FILTER (WHERE came AND slot_hour IS NULL) AS no_slot,
         (SELECT count(*) FROM (
            SELECT person FROM base WHERE came AND bucket = ANY($5) GROUP BY person HAVING count(*) > 1
          ) r) AS repeat_patients
    FROM base
   WHERE bucket = ANY($5)`;

const trendSql = (group) => `${BASE}
  SELECT ${GROUP_START_SQL[group]}::text AS bucket, ${COUNTS},
         count(*) FILTER (WHERE came AND bucket = 'new') AS new,
         count(*) FILTER (WHERE came AND bucket = 'follow_up') AS follow_up
    FROM base
   WHERE bucket = ANY($5)
   GROUP BY 1`;

const TYPES_SQL = `${BASE}
  SELECT bucket, count(*) FILTER (WHERE came) AS came, count(*) AS booked
    FROM base
   WHERE bucket = ANY($5)
   GROUP BY bucket`;

const CONSULTANTS_SQL = `${BASE}
  SELECT doctor, ${COUNTS}
    FROM base
   WHERE bucket = ANY($5)
   GROUP BY doctor`;

const HEATMAP_SQL = `${BASE}
  SELECT extract(isodow FROM day)::int AS weekday, slot_hour AS hour, count(*) AS came
    FROM base
   WHERE bucket = ANY($5) AND came AND slot_hour IS NOT NULL
   GROUP BY 1, 2`;

function comparisonFor({ from, to }, today) {
  if (from === to && to === today) {
    const day = addDays(today, -7);
    return { from: day, to: day, kind: "same_weekday" };
  }
  return { ...previousRange({ from, to }), kind: "previous" };
}

function consultantRows(rows) {
  const sorted = rows
    .map((r) => ({ doctor: r.doctor, ...countsOf(r) }))
    .filter((r) => r.booked > 0)
    .sort((a, b) => b.came - a.came || b.booked - a.booked || a.doctor.localeCompare(b.doctor));
  const shown = sorted.slice(0, OPD_CONSULTANTS_SHOWN);
  const rest = sorted.slice(OPD_CONSULTANTS_SHOWN);
  if (!rest.length) return { shown, others: null };
  const others = rest.reduce(
    (sum, r) => {
      for (const key of Object.keys(sum)) if (key !== "count") sum[key] += r[key];
      return sum;
    },
    { ...countsOf(), count: rest.length },
  );
  return { shown, others };
}

function trendRows(buckets, rows, previousBuckets, previousRows) {
  const at = (list) =>
    new Map(
      list.map((r) => [r.bucket, { ...countsOf(r), new: n(r.new), followUp: n(r.follow_up) }]),
    );
  const current = at(rows);
  const before = at(previousRows);
  return buckets.map((b, i) => {
    const c = current.get(b.bucket) || { ...countsOf(), new: 0, followUp: 0 };
    const earlier = previousBuckets[i];
    const prev = earlier && !earlier.partial ? (before.get(earlier.bucket) ?? countsOf()) : null;
    return {
      bucket: b.bucket,
      start: b.start,
      end: b.end,
      partial: b.partial,
      ...(b.week ? { week: b.week } : {}),
      ...c,
      previousCame: prev ? prev.came : null,
    };
  });
}

async function istToday(db) {
  const { rows } = await db.query(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`);
  return rows[0].d;
}

async function cached(kind, { fresh, ...filters }, db, build) {
  const today = await istToday(db);
  const key = JSON.stringify({ kind, ...filters, today });
  const hit = db === pool && !fresh ? cache.get(key) : null;
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await build(filters, today, db);
  if (db === pool) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });
  }
  return value;
}

export const getOpdDashboard = (filters, db = pool) =>
  cached("dashboard", filters, db, buildDashboard);

export const getOpdTimes = (filters, db = pool) => cached("times", filters, db, buildTimes);

const NEVER_TIMED = "bucket <> ALL (ARRAY['tele', 'lab_only'])";

const TIMEABLE_SQL = `${BASE}
  SELECT count(*) AS visits FROM base WHERE came AND bucket = ANY($5) AND ${NEVER_TIMED}`;

const TIMED_BASE = `${BASE},
  vs AS MATERIALIZED (
    SELECT v.id, base.day
      FROM base JOIN giniflow_visits v ON v.appointment_id = base.id
     WHERE base.came AND base.bucket = ANY($5) AND base.${NEVER_TIMED}
  )`;

const journeysSql = (group) => `${TIMED_BASE},
  ${JOURNEY_MARKS}
  SELECT ${GROUP_START_SQL[group]}::text AS bucket,
         ${VISIT_MINUTES} AS minutes, ${WAITING_MINUTES} AS waiting
    FROM vs JOIN marks m ON m.visit_id = vs.id AND m.started_at IS NOT NULL`;

const HOPS_SQL = `${TIMED_BASE},
  ${STEP_HOPS}
  SELECT status, EXTRACT(EPOCH FROM (next_at - occurred_at)) / 60 AS minutes
    FROM steps WHERE next_at > occurred_at`;

const LABS_SQL = `${TIMED_BASE}
  SELECT EXTRACT(EPOCH FROM (o.uploaded_at - o.created_at)) / 60 AS minutes
    FROM giniflow_lab_orders o JOIN vs ON vs.id = o.visit_id
   WHERE o.uploaded_at IS NOT NULL AND o.kind = 'lab' AND o.uploaded_at >= o.created_at`;

const wholeMedian = (values) => {
  const middle = median(values);
  return middle === null ? null : Math.round(middle);
};

function timesOf(rows, target) {
  const finished = rows
    .filter((r) => r.minutes !== null)
    .map((r) => Math.max(0, Number(r.minutes)));
  const waits = rows.filter((r) => r.waiting !== null).map((r) => Math.max(0, Number(r.waiting)));
  const within = target ? finished.filter((m) => m <= target).length : 0;
  return {
    tracked: rows.length,
    timed: finished.length,
    visitLength: wholeMedian(finished),
    waiting: wholeMedian(waits),
    onTime: target ? within : null,
    onTimePct: target && finished.length ? Math.round((100 * within) / finished.length) : null,
  };
}

async function buildTimes({ from, to, group, doctor, type = "opd" }, today, db) {
  const types = typesFor(type);
  const doctors = doctorList(doctor);
  const compare = comparisonFor({ from, to }, today);
  const params = (range) => [range.from, range.to, LAB_ONLY_DOCTOR, doctors, types];
  const range = { from, to };
  const slaConfig = await getSlaConfig(db);
  const target = budgetMap(slaConfig).total_journey ?? null;
  const [timeable, journeys, before, hops, labs] = await Promise.all([
    db.query(TIMEABLE_SQL, params(range)),
    db.query(journeysSql(group), params(range)),
    db.query(journeysSql(group), params(compare)),
    db.query(HOPS_SQL, params(range)),
    db.query(LABS_SQL, params(range)),
  ]);
  const overall = timesOf(journeys.rows, target);
  const byBucket = new Map();
  for (const row of journeys.rows) {
    if (!byBucket.has(row.bucket)) byBucket.set(row.bucket, []);
    byBucket.get(row.bucket).push(row);
  }
  return {
    from,
    to,
    group,
    compare,
    dayOpen: from === to && to === today,
    target,
    visits: n(timeable.rows[0]?.visits),
    enough: overall.timed >= OPD_TIMES_MIN_VISITS,
    minVisits: OPD_TIMES_MIN_VISITS,
    ...overall,
    previous: timesOf(before.rows, target),
    trend: bucketsOf({ from, to, period: group }).map((b) => ({
      bucket: b.bucket,
      start: b.start,
      end: b.end,
      partial: b.partial,
      ...(b.week ? { week: b.week } : {}),
      ...timesOf(byBucket.get(b.bucket) ?? [], target),
    })),
    stations: bottlenecksOf(
      [
        ...hopRows(hops.rows),
        ...labs.rows.map((r) => ({ key: "lab_total", minutes: Number(r.minutes) })),
      ],
      slaConfig,
    ),
  };
}

async function buildDashboard({ from, to, group, doctor, type = "opd" }, today, db) {
  const doctors = doctorList(doctor);
  const types = typesFor(type);
  const compare = comparisonFor({ from, to }, today);
  const params = (range, list = types) => [range.from, range.to, LAB_ONLY_DOCTOR, doctors, list];
  const range = { from, to };
  const [totals, previous, trend, previousTrend, mix, consultants, heatmap] = await Promise.all([
    db.query(TOTALS_SQL, params(range)),
    db.query(TOTALS_SQL, params(compare)),
    db.query(trendSql(group), params(range)),
    db.query(trendSql(group), params(compare)),
    db.query(TYPES_SQL, params(range, OPD_TYPE_SETS.all)),
    db.query(CONSULTANTS_SQL, params(range)),
    db.query(HEATMAP_SQL, params(range)),
  ]);
  const t = totals.rows[0] || {};
  const p = previous.rows[0] || {};
  const typeRows = new Map(mix.rows.map((r) => [r.bucket, r]));
  return {
    from,
    to,
    today,
    group,
    doctors: doctors || [],
    type,
    includesToday: to === today,
    dayOpen: from === to && to === today,
    compare,
    totals: {
      ...countsOf(t),
      uniquePatients: n(t.unique_patients),
      repeatPatients: n(t.repeat_patients),
      new: n(t.new),
      followUp: n(t.follow_up),
      noSlot: n(t.no_slot),
    },
    previous: {
      ...countsOf(p),
      uniquePatients: n(p.unique_patients),
      new: n(p.new),
      followUp: n(p.follow_up),
    },
    trend: trendRows(
      bucketsOf({ from, to, period: group }),
      trend.rows,
      bucketsOf({ from: compare.from, to: compare.to, period: group }),
      previousTrend.rows,
    ),
    types: Object.entries(OPD_BUCKETS).map(([key, label]) => ({
      key,
      label,
      came: n(typeRows.get(key)?.came),
      booked: n(typeRows.get(key)?.booked),
      selected: types.includes(key),
    })),
    consultants: consultantRows(consultants.rows),
    heatmap: heatmap.rows.map((r) => ({ weekday: r.weekday, hour: r.hour, came: n(r.came) })),
    asOf: new Date().toISOString(),
  };
}
