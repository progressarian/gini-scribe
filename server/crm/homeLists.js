import { withCrmContext } from "./db.js";
import { VISIT_DUE_CTE } from "./visitDue.js";
import {
  DOCTOR_PRIORITY_VALUES,
  REFERRAL_STATUS_VALUES,
  URGENCY_VALUES,
  VISIT_DUE_STATE_VALUES,
} from "../../shared/crmVocab.js";

export const PAGE_SIZE = 50;
const WAITING_STATES = ["overdue", "due", "never_visited"];

const MAX_PAGE = 10_000;
const MAX_TEXT = 100;

const pageOf = (v) => Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(v)) || 1));
const textOf = (v) => (typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "");
const likeOf = (term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`;
const pagesOf = (total) => Math.max(1, Math.ceil(total / PAGE_SIZE));
const fitPage = (requested, total) => Math.min(requested, pagesOf(total));
const pageWindow = (page) => `LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
const paged = (rows, total, page) => ({
  rows,
  page,
  page_size: PAGE_SIZE,
  total,
  pages: pagesOf(total),
});

function builder() {
  const params = [];
  const where = [];
  const bind = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  return { params, where, bind };
}

const DOCTOR_FROM = `
  FROM crm.doctors d
  LEFT JOIN crm.territories t ON t.id = d.territory_id
  LEFT JOIN vd_all vd ON vd.doctor_id = d.id`;

const DOCTOR_COLUMNS = `d.id AS doctor_id, d.full_name, d.specialty, d.area, d.city, d.priority,
       d.relationship_stage, d.mobile, d.profile_complete, d.missing_fields,
       d.needs_verification, t.name AS territory_name,
       vd.due_state, vd.last_visit_at, vd.next_due_on`;

const PRIORITY_RANK = `CASE d.priority WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 ELSE 3 END`;

function doctorFilters(filters, { waitingOnly }) {
  const q = builder();
  q.where.push("d.deleted_at IS NULL", "d.is_active");
  if (waitingOnly) q.where.push(`vd.due_state = ANY(${q.bind(WAITING_STATES)}::text[])`);
  if (DOCTOR_PRIORITY_VALUES.includes(filters.priority)) {
    q.where.push(`d.priority = ${q.bind(filters.priority)}`);
  }
  if (textOf(filters.territory)) q.where.push(`t.name = ${q.bind(textOf(filters.territory))}`);
  if (filters.incomplete === "1" || filters.incomplete === true) {
    q.where.push("d.profile_complete IS NOT TRUE");
  }
  const term = textOf(filters.q);
  if (term) {
    const p = q.bind(likeOf(term));
    q.where.push(
      `(d.full_name ILIKE ${p} OR d.specialty ILIKE ${p} OR d.area ILIKE ${p}
        OR d.city ILIKE ${p} OR d.mobile ILIKE ${p})`,
    );
  }
  return q;
}

async function territoriesOf(sql) {
  const { rows } = await sql(
    `SELECT DISTINCT t.name FROM crm.doctors d JOIN crm.territories t ON t.id = d.territory_id
      WHERE d.deleted_at IS NULL AND d.is_active ORDER BY t.name`,
  );
  return rows.map((r) => r.name);
}

export async function listDueDoctors(crmUser, filters = {}) {
  const requested = pageOf(filters.page);
  const q = doctorFilters(filters, { waitingOnly: true });
  const scoped = q.where.join(" AND ");
  const state = WAITING_STATES.includes(filters.state) ? filters.state : null;
  const stateParam = state ? q.bind(state) : null;
  const where = stateParam ? `${scoped} AND vd.due_state = ${stateParam}` : scoped;
  return withCrmContext(crmUser, async (sql) => {
    const { rows: counts } = await sql(
      `WITH ${VISIT_DUE_CTE}
       SELECT count(*)::int AS "all",
              count(*) FILTER (WHERE vd.due_state = 'overdue')::int AS overdue,
              count(*) FILTER (WHERE vd.due_state = 'due')::int AS due,
              count(*) FILTER (WHERE vd.due_state = 'never_visited')::int AS never_visited
         ${DOCTOR_FROM} WHERE ${scoped}`,
      q.params.slice(0, stateParam ? -1 : undefined),
    );
    const total = state ? counts[0][state] : counts[0].all;
    const page = fitPage(requested, total);
    const { rows } = await sql(
      `WITH ${VISIT_DUE_CTE}
       SELECT ${DOCTOR_COLUMNS} ${DOCTOR_FROM} WHERE ${where}
        ORDER BY CASE vd.due_state WHEN 'overdue' THEN 0 WHEN 'due' THEN 1 ELSE 2 END,
                 ${PRIORITY_RANK}, vd.last_visit_at NULLS FIRST, d.full_name, d.id
        ${pageWindow(page)}`,
      q.params,
    );
    return {
      ...paged(rows, total, page),
      counts: counts[0],
      territories: await territoriesOf(sql),
    };
  });
}

export async function listMyDoctors(crmUser, filters = {}) {
  const requested = pageOf(filters.page);
  const q = doctorFilters(filters, { waitingOnly: false });
  if (VISIT_DUE_STATE_VALUES.includes(filters.due)) {
    q.where.push(`vd.due_state = ${q.bind(filters.due)}`);
  }
  const where = q.where.join(" AND ");
  return withCrmContext(crmUser, async (sql) => {
    const { rows: counts } = await sql(
      `WITH ${VISIT_DUE_CTE}
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE d.profile_complete IS NOT TRUE)::int AS incomplete
         ${DOCTOR_FROM} WHERE ${where}`,
      q.params,
    );
    const page = fitPage(requested, counts[0].total);
    const { rows } = await sql(
      `WITH ${VISIT_DUE_CTE}
       SELECT ${DOCTOR_COLUMNS} ${DOCTOR_FROM} WHERE ${where}
        ORDER BY t.name NULLS LAST, ${PRIORITY_RANK}, d.full_name, d.id
        ${pageWindow(page)}`,
      q.params,
    );
    let territoryTotal = null;
    if (textOf(filters.territory)) {
      const { rows: inTerritory } = await sql(
        `SELECT count(*)::int AS n FROM crm.doctors d JOIN crm.territories t ON t.id = d.territory_id
          WHERE d.deleted_at IS NULL AND d.is_active AND t.name = $1`,
        [textOf(filters.territory)],
      );
      territoryTotal = inTerritory[0].n;
    }
    return {
      ...paged(rows, counts[0].total, page),
      counts: { ...counts[0], territory: territoryTotal },
      territories: await territoriesOf(sql),
    };
  });
}

export async function listReferrals(crmUser, filters = {}) {
  const requested = pageOf(filters.page);
  const q = builder();
  q.where.push("TRUE");
  if (URGENCY_VALUES.includes(filters.urgency)) {
    q.where.push(`r.urgency = ${q.bind(filters.urgency)}`);
  }
  const term = textOf(filters.q);
  if (term) {
    const p = q.bind(likeOf(term));
    q.where.push(
      `(r.patient_name_raw ILIKE ${p} OR r.patient_phone_raw ILIKE ${p}
        OR r.referral_code ILIKE ${p} OR r.doctor_name ILIKE ${p})`,
    );
  }
  const scoped = q.where.join(" AND ");
  const status = REFERRAL_STATUS_VALUES.includes(filters.status) ? filters.status : null;
  const statusParam = status ? q.bind(status) : null;
  const where = statusParam ? `${scoped} AND r.status = ${statusParam}` : scoped;
  return withCrmContext(crmUser, async (sql) => {
    const [summary, byStatus] = await Promise.all([
      sql(
        `SELECT count(*)::int AS open,
                count(*) FILTER (WHERE status = 'new')::int AS untouched,
                count(*) FILTER (WHERE urgency IN ('urgent','emergency'))::int AS urgent,
                count(*) FILTER (WHERE attribution_status = 'verified')::int AS verified
           FROM crm.v_open_referrals`,
      ),
      sql(
        `SELECT r.status, count(*)::int AS n FROM crm.v_open_referrals r
          WHERE ${scoped} GROUP BY r.status`,
        q.params.slice(0, statusParam ? -1 : undefined),
      ),
    ]);
    const counts = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n]));
    const matching = Object.values(counts).reduce((a, b) => a + b, 0);
    const total = status ? counts[status] || 0 : matching;
    const page = fitPage(requested, total);
    const { rows } = await sql(
      `SELECT r.* FROM crm.v_open_referrals r
        WHERE ${where}
        ORDER BY CASE r.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1
                                WHEN 'soon' THEN 2 ELSE 3 END,
                 r.status_changed_at, r.id
        ${pageWindow(page)}`,
      q.params,
    );
    return {
      ...paged(rows, total, page),
      referrals: rows,
      summary: summary.rows[0],
      counts: { all: matching, by_status: counts },
    };
  });
}
