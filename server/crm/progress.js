import ExcelJS from "exceljs";
import { withCrmContext } from "./db.js";
import { VISIT_DUE_CTE } from "./visitDue.js";
import { ASSIGNABLE_ROLES, ASSIGNING_ROLES } from "./assignees.js";
import {
  REFERRAL_STATUSES,
  VISIT_OUTCOMES,
  VISIT_SOURCES,
  VISIT_TYPES,
} from "../../shared/crmVocab.js";
import {
  IST,
  IST_TODAY,
  addDays,
  addMonths,
  daysBetween,
  ddmmyyyy,
  istDate,
  istDayOf,
  mondayOf,
  monthEndOf,
  monthStartOf,
} from "./istPeriods.js";

const PAGE_SIZE = 50;
const MAX_DAYS = 366;
const MAX_EXPORT_ROWS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const GROUPS = ["day", "week", "month"];
const PERIODS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "custom",
];
const CONSULTED_RANK = REFERRAL_STATUSES.find((s) => s.value === "consulted").rank;
const REACHED = REFERRAL_STATUSES.filter((s) => s.rank >= CONSULTED_RANK && s.value !== "lost").map(
  (s) => s.value,
);

export class ProgressError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function realDay(d) {
  if (!ISO_DAY.test(d)) return false;
  const at = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === d;
}

function periodRange(period, today) {
  switch (period) {
    case "today":
      return {
        from: today,
        to: today,
        previous: { from: addDays(today, -1), to: addDays(today, -1) },
      };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y, previous: { from: addDays(y, -1), to: addDays(y, -1) } };
    }
    case "last_week": {
      const from = addDays(mondayOf(today), -7);
      return {
        from,
        to: addDays(from, 6),
        previous: { from: addDays(from, -7), to: addDays(from, -1) },
      };
    }
    case "this_month": {
      const from = monthStartOf(today);
      const prevFrom = addMonths(today, -1);
      const sameDay = addDays(prevFrom, daysBetween(from, today));
      const prevEnd = monthEndOf(prevFrom);
      return {
        from,
        to: today,
        previous: { from: prevFrom, to: sameDay < prevEnd ? sameDay : prevEnd },
      };
    }
    case "last_month": {
      const from = addMonths(today, -1);
      const before = addMonths(today, -2);
      return { from, to: monthEndOf(from), previous: { from: before, to: monthEndOf(before) } };
    }
    default: {
      const from = mondayOf(today);
      return {
        from,
        to: today,
        previous: { from: addDays(from, -7), to: addDays(today, -7) },
      };
    }
  }
}

const autoGroup = (from, to) => {
  const days = daysBetween(from, to) + 1;
  return days <= 31 ? "day" : days <= 182 ? "week" : "month";
};

async function staffOptions(sql) {
  const { rows } = await sql(
    `SELECT id, full_name, role FROM crm.users
      WHERE is_active AND deleted_at IS NULL AND role = ANY($1::text[])
      ORDER BY full_name`,
    [ASSIGNABLE_ROLES],
  );
  return rows;
}

async function territoryOptions(sql) {
  const { rows } = await sql(
    "SELECT id, name FROM crm.territories WHERE deleted_at IS NULL ORDER BY name",
  );
  return rows;
}

export const canPickStaff = (crmUser) => ASSIGNING_ROLES.includes(crmUser?.role);

async function resolveIn(sql, crmUser, query = {}) {
  const today = istDate();
  const pick = canPickStaff(crmUser);
  const period = PERIODS.includes(query.period) ? query.period : "this_month";
  let range;
  if (period === "custom" || query.from || query.to) {
    const from = String(query.from ?? "");
    const to = String(query.to ?? "");
    if (!realDay(from) || !realDay(to)) {
      throw new ProgressError("Choose a From and To date, like 01-10-2026.");
    }
    if (from > to) throw new ProgressError("The From date must be on or before the To date.");
    if (to > today) throw new ProgressError("The To date cannot be in the future.");
    const days = daysBetween(from, to) + 1;
    if (days > MAX_DAYS) throw new ProgressError("Choose a range of one year or less.");
    range = {
      from,
      to,
      previous: { from: addDays(from, -days), to: addDays(from, -1) },
    };
  } else {
    range = periodRange(period, today);
  }
  const group = GROUPS.includes(query.group) ? query.group : autoGroup(range.from, range.to);

  const options = pick ? await staffOptions(sql) : [];
  let rep = crmUser.id;
  let repIds = [crmUser.id];
  if (pick) {
    const wanted = query.rep == null || query.rep === "" ? "all" : String(query.rep);
    if (wanted === "all") {
      rep = "all";
      repIds = options.map((o) => o.id);
    } else if (options.some((o) => o.id === wanted)) {
      rep = wanted;
      repIds = [wanted];
    } else {
      throw new ProgressError("Choose a staff member from the list.");
    }
  }

  let territory = null;
  if (query.territory) {
    if (!UUID.test(String(query.territory))) {
      throw new ProgressError("Choose a territory from the list.");
    }
    territory = String(query.territory);
  }

  return {
    period: query.from || query.to ? "custom" : period,
    from: range.from,
    to: range.to,
    previous: range.previous,
    group,
    rep,
    repIds,
    territory,
    canPickStaff: pick,
    staffOptions: options,
  };
}

export function resolveProgressFilters(crmUser, query) {
  return withCrmContext(crmUser, (sql) => resolveIn(sql, crmUser, query));
}

const startOf = (param) => `((${param}::date)::timestamp AT TIME ZONE ${IST})`;
const endOf = (param) => `((${param}::date + 1)::timestamp AT TIME ZONE ${IST})`;
const between = (col, fromParam, toParam) =>
  `${col} >= ${startOf(fromParam)} AND ${col} < ${endOf(toParam)}`;
const territoryClause = (alias, param) =>
  `(${param}::uuid IS NULL OR ${alias}.territory_id = ${param}::uuid)`;

async function visitMetrics(sql, f, from, to) {
  const { rows } = await sql(
    `SELECT v.executive_id,
            count(*)::int AS visits,
            count(DISTINCT v.doctor_id)::int AS unique_doctors,
            count(*) FILTER (WHERE v.outcome = 'doctor_unavailable')::int AS doctor_unavailable,
            count(*) FILTER (WHERE v.next_visit_date IS NOT NULL)::int AS follow_ups,
            count(*) FILTER (WHERE v.source = 'sheet')::int AS from_sheet,
            max(v.occurred_at) AS last_visit_at
       FROM crm.visits v
       JOIN crm.doctors d ON d.id = v.doctor_id
      WHERE v.deleted_at IS NULL AND v.executive_id = ANY($1::uuid[])
        AND ${between("v.occurred_at", "$2", "$3")}
        AND ${territoryClause("d", "$4")}
      GROUP BY GROUPING SETS ((v.executive_id), ())`,
    [f.repIds, from, to, f.territory],
  );
  return rows;
}

async function coverageMetrics(sql, f, from, to) {
  const { rows } = await sql(
    `WITH ${VISIT_DUE_CTE}
     SELECT a.executive_id,
            count(*)::int AS assigned,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM crm.visits v
               WHERE v.doctor_id = a.doctor_id AND v.executive_id = a.executive_id
                 AND v.deleted_at IS NULL AND ${between("v.occurred_at", "$2", "$3")}))::int AS covered,
            count(*) FILTER (WHERE vd.due_state = 'overdue')::int AS overdue_now,
            count(*) FILTER (WHERE vd.due_state = 'never_visited')::int AS never_visited_now
       FROM crm.doctor_assignments a
       JOIN crm.doctors d ON d.id = a.doctor_id AND d.deleted_at IS NULL AND d.is_active
       LEFT JOIN vd_all vd ON vd.doctor_id = d.id
      WHERE a.effective_to IS NULL AND a.executive_id = ANY($1::uuid[])
        AND ${territoryClause("d", "$4")}
      GROUP BY GROUPING SETS ((a.executive_id), ())`,
    [f.repIds, from, to, f.territory],
  );
  return rows;
}

async function referralMetrics(sql, f, from, to) {
  const { rows } = await sql(
    `SELECT r.responsible_executive_id AS executive_id,
            count(*) FILTER (WHERE ${between("r.referred_at", "$2", "$3")})::int AS logged,
            count(*) FILTER (WHERE ${between("r.referred_at", "$2", "$3")}
                               AND r.attribution_status = 'verified')::int AS verified,
            count(*) FILTER (WHERE ${between("r.referred_at", "$2", "$3")}
                               AND r.attribution_status = 'claimed')::int AS claimed,
            count(*) FILTER (WHERE ${between("r.referred_at", "$2", "$3")}
                               AND r.status = ANY($5::text[]))::int AS reached,
            count(*) FILTER (WHERE ${between("r.referred_at", "$2", "$3")}
                               AND r.status = 'lost')::int AS lost,
            count(*) FILTER (WHERE r.status = 'new')::int AS untouched_now
       FROM crm.doctor_referrals r
       LEFT JOIN crm.doctors d ON d.id = r.referring_doctor_id
      WHERE r.deleted_at IS NULL AND r.responsible_executive_id = ANY($1::uuid[])
        AND ${territoryClause("d", "$4")}
      GROUP BY GROUPING SETS ((r.responsible_executive_id), ())`,
    [f.repIds, from, to, f.territory, REACHED],
  );
  return rows;
}

async function taskMetrics(sql, f, from, to) {
  const { rows } = await sql(
    `SELECT t.owner_id AS executive_id,
            count(*) FILTER (WHERE t.status = 'done'
                               AND ${between("t.completed_at", "$2", "$3")})::int AS completed,
            count(*) FILTER (WHERE t.status = 'done'
                               AND ${between("t.completed_at", "$2", "$3")}
                               AND (t.due_date IS NULL
                                    OR ${istDayOf("t.completed_at")} <= t.due_date))::int AS on_time,
            count(*) FILTER (WHERE t.status IN ('open', 'in_progress')
                               AND t.due_date < ${IST_TODAY})::int AS overdue_now
       FROM crm.tasks t
       LEFT JOIN crm.doctors d ON d.id = t.doctor_id
      WHERE t.deleted_at IS NULL AND t.owner_id = ANY($1::uuid[])
        AND ($4::uuid IS NULL OR d.territory_id = $4::uuid)
      GROUP BY GROUPING SETS ((t.owner_id), ())`,
    [f.repIds, from, to, f.territory],
  );
  return rows;
}

const ZERO = {
  visits: 0,
  unique_doctors: 0,
  doctor_unavailable: 0,
  follow_ups: 0,
  from_sheet: 0,
  last_visit_at: null,
  assigned: 0,
  covered: 0,
  overdue_now: 0,
  never_visited_now: 0,
  logged: 0,
  verified: 0,
  claimed: 0,
  reached: 0,
  lost: 0,
  untouched_now: 0,
  completed: 0,
  on_time: 0,
  tasks_overdue_now: 0,
};

function shape(m) {
  return {
    visits: {
      visits: m.visits,
      unique_doctors: m.unique_doctors,
      assigned: m.assigned,
      covered: m.covered,
      coverage_pct: m.assigned ? Math.round((m.covered / m.assigned) * 100) : null,
      doctor_unavailable: m.doctor_unavailable,
      follow_ups: m.follow_ups,
      from_sheet: m.from_sheet,
      overdue_now: m.overdue_now,
      never_visited_now: m.never_visited_now,
      last_visit_at: m.last_visit_at,
    },
    referrals: {
      logged: m.logged,
      verified: m.verified,
      claimed: m.claimed,
      reached: m.reached,
      lost: m.lost,
      untouched_now: m.untouched_now,
    },
    tasks: { completed: m.completed, on_time: m.on_time, overdue_now: m.tasks_overdue_now },
  };
}

async function metricsFor(sql, f, from, to) {
  const [visits, coverage, referrals, tasks] = await Promise.all([
    visitMetrics(sql, f, from, to),
    coverageMetrics(sql, f, from, to),
    referralMetrics(sql, f, from, to),
    taskMetrics(sql, f, from, to),
  ]);
  const byRep = new Map();
  const merge = (rows, rename = {}) => {
    for (const row of rows) {
      const key = row.executive_id ?? "total";
      const target = byRep.get(key) ?? { ...ZERO };
      for (const [k, v] of Object.entries(row)) {
        if (k === "executive_id") continue;
        target[rename[k] ?? k] = v;
      }
      byRep.set(key, target);
    }
  };
  merge(visits);
  merge(coverage);
  merge(referrals);
  merge(tasks, { overdue_now: "tasks_overdue_now" });
  return byRep;
}

function buckets(from, to, group) {
  const out = [];
  let start = group === "week" ? mondayOf(from) : group === "month" ? monthStartOf(from) : from;
  while (start <= to && out.length < 400) {
    out.push(start);
    start =
      group === "week"
        ? addDays(start, 7)
        : group === "month"
          ? addMonths(start, 1)
          : addDays(start, 1);
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function bucketLabel(start, group, withYear) {
  const [y, m, d] = start.split("-").map(Number);
  const year = withYear ? ` ${y}` : "";
  if (group === "month") return `${MONTHS[m - 1]} ${y}`;
  if (group === "week") return `Week of ${d} ${MONTHS[m - 1]}${year}`;
  return `${d} ${MONTHS[m - 1]}${year}`;
}

async function trend(sql, f) {
  const { rows } = await sql(
    `SELECT x.start, x.executive_id,
            count(*)::int AS visits,
            count(DISTINCT x.doctor_id)::int AS unique_doctors
       FROM (SELECT date_trunc($5, ${istDayOf("v.occurred_at")})::date::text AS start,
                    v.executive_id, v.doctor_id
               FROM crm.visits v
               JOIN crm.doctors d ON d.id = v.doctor_id
              WHERE v.deleted_at IS NULL AND v.executive_id = ANY($1::uuid[])
                AND ${between("v.occurred_at", "$2", "$3")}
                AND ${territoryClause("d", "$4")}) x
      GROUP BY GROUPING SETS ((x.start, x.executive_id), (x.start))`,
    [f.repIds, f.from, f.to, f.territory, f.group],
  );
  const all = buckets(f.from, f.to, f.group);
  const withYear = all[0].slice(0, 4) !== f.to.slice(0, 4);
  return all.map((start) => {
    const here = rows.filter((r) => r.start === start);
    const total = here.find((r) => r.executive_id == null);
    return {
      start,
      label: bucketLabel(start, f.group, withYear),
      visits: total?.visits ?? 0,
      unique_doctors: total?.unique_doctors ?? 0,
      by_rep: Object.fromEntries(
        here.filter((r) => r.executive_id).map((r) => [r.executive_id, r.visits]),
      ),
    };
  });
}

async function breakdowns(sql, f) {
  const { rows } = await sql(
    `SELECT v.visit_type, v.outcome, v.source, t.name AS territory
       FROM crm.visits v
       JOIN crm.doctors d ON d.id = v.doctor_id
       LEFT JOIN crm.territories t ON t.id = d.territory_id
      WHERE v.deleted_at IS NULL AND v.executive_id = ANY($1::uuid[])
        AND ${between("v.occurred_at", "$2", "$3")}
        AND ${territoryClause("d", "$4")}`,
    [f.repIds, f.from, f.to, f.territory],
  );
  const count = (key, labels, empty) => {
    const tally = new Map();
    for (const r of rows) {
      const k = r[key] ?? "";
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    return [...tally.entries()]
      .map(([value, n]) => ({
        value,
        label: value ? (labels?.find((l) => l.value === value)?.label ?? value) : empty,
        count: n,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  return {
    type: count("visit_type", VISIT_TYPES, "Not recorded"),
    outcome: count("outcome", VISIT_OUTCOMES, "No outcome"),
    source: count("source", VISIT_SOURCES, "Not recorded"),
    territory: count("territory", null, "No territory"),
  };
}

export async function progressReport(crmUser, query) {
  return withCrmContext(crmUser, async (sql) => {
    const f = await resolveIn(sql, crmUser, query);
    const [current, previous, trendRows, split, territories] = await Promise.all([
      metricsFor(sql, f, f.from, f.to),
      metricsFor(sql, f, f.previous.from, f.previous.to),
      trend(sql, f),
      breakdowns(sql, f),
      territoryOptions(sql),
    ]);
    const names = new Map(f.staffOptions.map((o) => [o.id, o.full_name]));
    if (!names.has(crmUser.id)) names.set(crmUser.id, crmUser.full_name);
    const staff =
      f.canPickStaff && f.rep === "all"
        ? f.repIds.map((id) => ({
            id,
            full_name: names.get(id),
            ...shape(current.get(id) ?? ZERO),
          }))
        : [];
    return {
      filters: {
        period: f.period,
        from: f.from,
        to: f.to,
        previous: f.previous,
        group: f.group,
        rep: f.rep,
        territory: f.territory,
      },
      can_pick_staff: f.canPickStaff,
      staff_options: f.staffOptions.map(({ id, full_name }) => ({ id, full_name })),
      territories,
      viewer: { id: crmUser.id, full_name: crmUser.full_name },
      cards: shape(current.get("total") ?? ZERO),
      previous_cards: shape(previous.get("total") ?? ZERO),
      staff,
      trend: {
        group: f.group,
        reps: f.repIds.map((id) => ({ id, full_name: names.get(id) })),
        buckets: trendRows,
      },
      breakdowns: split,
    };
  });
}

const textOf = (v) => (typeof v === "string" ? v.trim().slice(0, 100) : "");
const likeOf = (term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`;
const PRIORITY_RANK = `CASE d.priority WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END`;

async function doctorRows(sql, f, { state, q, limit, offset }) {
  const term = textOf(q);
  const params = [f.repIds, f.from, f.to, f.territory, term ? likeOf(term) : null];
  const search = `($5::text IS NULL OR d.full_name ILIKE $5 OR d.area ILIKE $5 OR d.mobile ILIKE $5)`;
  if (state === "not_visited") {
    const base = `
       FROM crm.doctor_assignments a
       JOIN crm.doctors d ON d.id = a.doctor_id AND d.deleted_at IS NULL AND d.is_active
       JOIN crm.users u ON u.id = a.executive_id
       LEFT JOIN crm.territories t ON t.id = d.territory_id
       LEFT JOIN vd_all vd ON vd.doctor_id = d.id
      WHERE a.effective_to IS NULL AND a.executive_id = ANY($1::uuid[])
        AND ${territoryClause("d", "$4")} AND ${search}
        AND NOT EXISTS (SELECT 1 FROM crm.visits v
                         WHERE v.doctor_id = a.doctor_id AND v.executive_id = a.executive_id
                           AND v.deleted_at IS NULL AND ${between("v.occurred_at", "$2", "$3")})`;
    const { rows: total } = await sql(
      `WITH ${VISIT_DUE_CTE} SELECT count(*)::int AS n ${base}`,
      params,
    );
    const { rows } = await sql(
      `WITH ${VISIT_DUE_CTE}
       SELECT d.id AS doctor_id, d.full_name, d.specialty, d.area, d.priority, t.name AS territory,
              u.full_name AS rep, vd.last_visit_at, vd.due_state
         ${base}
        ORDER BY ${PRIORITY_RANK}, vd.last_visit_at NULLS FIRST, d.full_name, d.id
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { rows, total: total[0].n };
  }
  const base = `
       FROM crm.visits v
       JOIN crm.doctors d ON d.id = v.doctor_id
       JOIN crm.users u ON u.id = v.executive_id
       LEFT JOIN crm.territories t ON t.id = d.territory_id
      WHERE v.deleted_at IS NULL AND v.executive_id = ANY($1::uuid[])
        AND ${between("v.occurred_at", "$2", "$3")}
        AND ${territoryClause("d", "$4")} AND ${search}`;
  const { rows: total } = await sql(`SELECT count(DISTINCT d.id)::int AS n ${base}`, params);
  const { rows } = await sql(
    `SELECT d.id AS doctor_id, d.full_name, d.specialty, d.area, d.priority, t.name AS territory,
            count(*)::int AS visits,
            max(v.occurred_at) AS last_visit_at,
            (array_agg(u.full_name ORDER BY v.occurred_at DESC))[1] AS rep,
            (array_agg(v.outcome ORDER BY v.occurred_at DESC))[1] AS last_outcome
       ${base}
      GROUP BY d.id, t.name
      ORDER BY max(v.occurred_at) DESC, d.full_name, d.id
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { rows, total: total[0].n };
}

export async function progressDoctors(crmUser, query) {
  const state = query.state === "not_visited" ? "not_visited" : "visited";
  return withCrmContext(crmUser, async (sql) => {
    const f = await resolveIn(sql, crmUser, query);
    const requested = Math.min(10_000, Math.max(1, Math.floor(Number(query.page)) || 1));
    let { rows, total } = await doctorRows(sql, f, {
      state,
      q: query.q,
      limit: PAGE_SIZE,
      offset: (requested - 1) * PAGE_SIZE,
    });
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(requested, pages);
    if (page !== requested) {
      ({ rows } = await doctorRows(sql, f, {
        state,
        q: query.q,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }));
    }
    return { state, rows, page, pages, page_size: PAGE_SIZE, total };
  });
}

const outcomeLabel = (v) => VISIT_OUTCOMES.find((o) => o.value === v)?.label ?? "";
const istDateOf = (ts) => (ts ? ddmmyyyy(istDate(new Date(ts))) : "");

export async function progressWorkbook(crmUser, query) {
  const report = await progressReport(crmUser, query);
  const lists = await withCrmContext(crmUser, async (sql) => {
    const f = await resolveIn(sql, crmUser, query);
    const visited = await doctorRows(sql, f, {
      state: "visited",
      limit: MAX_EXPORT_ROWS,
      offset: 0,
    });
    const notVisited = await doctorRows(sql, f, {
      state: "not_visited",
      limit: MAX_EXPORT_ROWS,
      offset: 0,
    });
    return { visited: visited.rows, notVisited: notVisited.rows };
  });

  const book = new ExcelJS.Workbook();
  const bold = (sheet) => {
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  };
  const { filters, cards, previous_cards: prev } = report;
  const who =
    filters.rep === "all"
      ? "All staff"
      : (report.staff_options.find((s) => s.id === filters.rep)?.full_name ??
        report.viewer.full_name);

  const summary = book.addWorksheet("Summary");
  summary.columns = [
    { header: "Measure", key: "label", width: 34 },
    { header: `${ddmmyyyy(filters.from)} to ${ddmmyyyy(filters.to)}`, key: "now", width: 24 },
    {
      header: `Previous: ${ddmmyyyy(filters.previous.from)} to ${ddmmyyyy(filters.previous.to)}`,
      key: "before",
      width: 30,
    },
  ];
  const line = (label, now, before = "") => summary.addRow({ label, now, before });
  line("Staff", who, who);
  line("Visits", cards.visits.visits, prev.visits.visits);
  line("Unique doctors", cards.visits.unique_doctors, prev.visits.unique_doctors);
  line("Assigned doctors (now)", cards.visits.assigned, "");
  line("Coverage %", cards.visits.coverage_pct ?? "", prev.visits.coverage_pct ?? "");
  line("Doctor unavailable", cards.visits.doctor_unavailable, prev.visits.doctor_unavailable);
  line("Follow-ups set", cards.visits.follow_ups, prev.visits.follow_ups);
  line("Visits from sheet", cards.visits.from_sheet, prev.visits.from_sheet);
  line("Overdue doctors (now)", cards.visits.overdue_now, "");
  line("Never visited (now)", cards.visits.never_visited_now, "");
  line("Referrals logged", cards.referrals.logged, prev.referrals.logged);
  line("— verified", cards.referrals.verified, prev.referrals.verified);
  line("— claimed", cards.referrals.claimed, prev.referrals.claimed);
  line("Reached consultation", cards.referrals.reached, prev.referrals.reached);
  line("Lost", cards.referrals.lost, prev.referrals.lost);
  line("Referrals untouched (now)", cards.referrals.untouched_now, "");
  line("Tasks completed", cards.tasks.completed, prev.tasks.completed);
  line("— on time", cards.tasks.on_time, prev.tasks.on_time);
  line("Tasks overdue (now)", cards.tasks.overdue_now, "");
  bold(summary);
  summary.addRow([]);
  summary.addRow(["India time; weeks start Monday. '(now)' rows are as of the download."]);

  const trendSheet = book.addWorksheet("Trend");
  trendSheet.columns = [
    { header: "Period", key: "label", width: 20 },
    { header: "Visits", key: "visits", width: 10 },
    { header: "Unique doctors", key: "unique_doctors", width: 16 },
    ...report.trend.reps.map((r) => ({ header: r.full_name, key: `rep:${r.id}`, width: 18 })),
  ];
  report.trend.buckets.forEach((b) =>
    trendSheet.addRow({
      label: b.label,
      visits: b.visits,
      unique_doctors: b.unique_doctors,
      ...Object.fromEntries(report.trend.reps.map((r) => [`rep:${r.id}`, b.by_rep[r.id] ?? 0])),
    }),
  );
  bold(trendSheet);

  if (report.staff.length) {
    const staff = book.addWorksheet("Staff");
    staff.columns = [
      { header: "Rep", key: "name", width: 22 },
      { header: "Visits", key: "visits", width: 9 },
      { header: "Unique doctors", key: "unique", width: 15 },
      { header: "Assigned", key: "assigned", width: 10 },
      { header: "Coverage %", key: "coverage", width: 11 },
      { header: "Doctor unavailable", key: "unavailable", width: 18 },
      { header: "Follow-ups set", key: "follow_ups", width: 14 },
      { header: "Overdue doctors (now)", key: "overdue", width: 20 },
      { header: "Referrals logged", key: "referrals", width: 16 },
      { header: "Referrals verified", key: "verified", width: 17 },
      { header: "Tasks completed", key: "tasks", width: 15 },
      { header: "Tasks overdue (now)", key: "tasks_overdue", width: 18 },
      { header: "Last visit", key: "last", width: 12 },
    ];
    for (const s of report.staff) {
      staff.addRow({
        name: s.full_name,
        visits: s.visits.visits,
        unique: s.visits.unique_doctors,
        assigned: s.visits.assigned,
        coverage: s.visits.coverage_pct ?? "",
        unavailable: s.visits.doctor_unavailable,
        follow_ups: s.visits.follow_ups,
        overdue: s.visits.overdue_now,
        referrals: s.referrals.logged,
        verified: s.referrals.verified,
        tasks: s.tasks.completed,
        tasks_overdue: s.tasks.overdue_now,
        last: istDateOf(s.visits.last_visit_at),
      });
    }
    staff.addRow({
      name: "Team total",
      visits: cards.visits.visits,
      unique: cards.visits.unique_doctors,
      assigned: cards.visits.assigned,
      coverage: cards.visits.coverage_pct ?? "",
      unavailable: cards.visits.doctor_unavailable,
      follow_ups: cards.visits.follow_ups,
      overdue: cards.visits.overdue_now,
      referrals: cards.referrals.logged,
      verified: cards.referrals.verified,
      tasks: cards.tasks.completed,
      tasks_overdue: cards.tasks.overdue_now,
      last: istDateOf(cards.visits.last_visit_at),
    }).font = { bold: true };
    bold(staff);
  }

  const visited = book.addWorksheet("Visited doctors");
  visited.columns = [
    { header: "Doctor", key: "full_name", width: 28 },
    { header: "Specialty", key: "specialty", width: 18 },
    { header: "Area", key: "area", width: 16 },
    { header: "Territory", key: "territory", width: 14 },
    { header: "Priority", key: "priority", width: 9 },
    { header: "Visits in period", key: "visits", width: 15 },
    { header: "Last visit", key: "last", width: 12 },
    { header: "Last outcome", key: "outcome", width: 18 },
    { header: "Rep", key: "rep", width: 18 },
  ];
  lists.visited.forEach((r) =>
    visited.addRow({
      ...r,
      last: istDateOf(r.last_visit_at),
      outcome: outcomeLabel(r.last_outcome),
    }),
  );
  bold(visited);

  const missing = book.addWorksheet("Not visited");
  missing.columns = [
    { header: "Doctor", key: "full_name", width: 28 },
    { header: "Specialty", key: "specialty", width: 18 },
    { header: "Area", key: "area", width: 16 },
    { header: "Territory", key: "territory", width: 14 },
    { header: "Priority", key: "priority", width: 9 },
    { header: "Owner", key: "rep", width: 18 },
    { header: "Last visit (ever)", key: "last", width: 16 },
  ];
  lists.notVisited.forEach((r) => missing.addRow({ ...r, last: istDateOf(r.last_visit_at) }));
  bold(missing);

  const slug = who
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    buffer: await book.xlsx.writeBuffer(),
    fileName: `crm-progress-${slug || "report"}-${filters.from}-to-${filters.to}.xlsx`,
  };
}
