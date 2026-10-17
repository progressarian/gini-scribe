import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import { LIVE_LAB_CASE_SQL } from "./testsHold.js";
import { HOME_COLLECTION_SQL, VISIT_HOME_SAMPLE_SQL } from "./homeCollection.js";
import { sheet } from "../reports/opdSummaryExport.js";
import {
  FLOOR_ACTION_STAGE,
  LAB_RUNGS,
  LAB_SAMPLE_FLOW,
  SAMPLE_STATUS_TO_STAGE,
  rungFor,
} from "../../../shared/labStages.js";
import { HOME_SITE_LABEL, istClock } from "../../../shared/homeCollection.js";

export const HOME_REPORT_SORTS = {
  date_desc: "h.visit_date DESC, h.name",
  date_asc: "h.visit_date ASC, h.name",
  patient_asc: "h.name ASC, h.visit_date DESC",
  patient_desc: "h.name DESC, h.visit_date DESC",
  collected_desc: "h.collected_at DESC NULLS LAST, h.name",
  collected_asc: "h.collected_at ASC NULLS LAST, h.name",
};
export const HOME_REPORT_SITES = ["home", "ghm", "pending"];
export const HOME_REPORT_PAGE_MAX = 100;
const EXPORT_ROW_CAP = 5000;

const HOME_VISITS_SQL = `
  WITH home AS (
    SELECT v.id, v.visit_date, v.patient_id, p.name, p.file_no, p.phone,
           ${VISIT_HOME_SAMPLE_SQL("v")} AS sample,
           (SELECT array_agg(DISTINCT t.test_name ORDER BY t.test_name)
              FROM giniflow_lab_orders o
              JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
             WHERE o.visit_id = v.id AND o.kind = 'lab' AND o.urgency = 'today'
               AND o.sample_status <> 'cancelled') AS order_tests,
           (SELECT array_agg(o.sample_status)
              FROM giniflow_lab_orders o
             WHERE o.visit_id = v.id AND o.kind = 'lab' AND o.urgency = 'today'
               AND o.sample_status <> 'cancelled') AS order_statuses,
           (SELECT json_agg(json_build_object(
                     'tests', lc.test_names,
                     'reported', lc.raw_detail_json->>'reported_on' IS NOT NULL
                                 OR lc.pdf_storage_path IS NOT NULL,
                     'actions', (SELECT array_agg(a.action) FROM giniflow_lab_case_actions a
                                  WHERE a.case_no = lc.case_no)))
              FROM lab_cases lc
             WHERE lc.case_date = v.visit_date AND lc.patient_id = v.patient_id
               AND ${LIVE_LAB_CASE_SQL("lc")}) AS cases
      FROM giniflow_visits v
      JOIN patients p ON p.id = v.patient_id
     WHERE v.visit_date BETWEEN $1::date AND $2::date
       AND v.current_status NOT IN ('no_show', 'cancelled')
       AND NOT COALESCE(p.is_blocked, FALSE)
       AND ${HOME_COLLECTION_SQL("v")}
  ),
  rows AS (
    SELECT home.*, sample->>'site' AS site, sample->>'by' AS collected_by,
           (sample->>'byId')::int AS collector_id,
           (sample->>'at')::timestamptz AS collected_at
      FROM home
     WHERE order_statuses IS NOT NULL OR cases IS NOT NULL
  )`;

const SEARCH_SQL = (param) => `(
  ${param}::text IS NULL
  OR h.name ILIKE '%' || ${param} || '%'
  OR h.file_no ILIKE '%' || ${param} || '%'
  OR h.phone ILIKE '%' || ${param} || '%'
)`;

const caseStage = (c) => {
  if (c.reported) return "reported";
  const reached = (c.actions || []).reduce(
    (max, a) => Math.max(max, FLOOR_ACTION_STAGE[a] ?? 0),
    0,
  );
  return LAB_RUNGS[reached]?.key ?? "pending";
};

const stageOrder = (key) => LAB_RUNGS.findIndex((r) => r.key === key);

const labStatusOf = (row) => {
  const stages = (row.order_statuses || []).length
    ? row.order_statuses
        .slice()
        .sort((a, b) => LAB_SAMPLE_FLOW.indexOf(a) - LAB_SAMPLE_FLOW.indexOf(b))
        .map((s) => SAMPLE_STATUS_TO_STAGE[s] ?? "pending")
    : (row.cases || []).map(caseStage);
  const lowest = stages.sort((a, b) => stageOrder(a) - stageOrder(b))[0];
  return rungFor(lowest)?.stageLabel ?? "—";
};

const shapeRow = (row) => ({
  visitId: row.id,
  date: row.visit_date,
  patientId: row.patient_id,
  name: row.name,
  fileNo: row.file_no,
  tests: [
    ...new Set([...(row.order_tests || []), ...(row.cases || []).flatMap((c) => c.tests || [])]),
  ],
  site: row.site ?? "pending",
  collectedBy: row.collected_by ?? null,
  collectorId: row.collector_id ?? null,
  collectedAt: row.collected_at ? new Date(row.collected_at).toISOString() : null,
  labStatus: labStatusOf(row),
});

const where = (filters, params) => {
  const parts = [SEARCH_SQL(`$${params.push(filters.q || null)}`)];
  if (filters.site === "pending") parts.push("h.site IS NULL");
  else if (filters.site) parts.push(`h.site = $${params.push(filters.site)}`);
  if (filters.collectorId) parts.push(`h.collector_id = $${params.push(filters.collectorId)}`);
  return parts.join(" AND ");
};

async function summaryOf(filters, db) {
  const params = [filters.from, filters.to];
  const search = SEARCH_SQL(`$${params.push(filters.q || null)}`);
  const { rows } = await db.query(
    `${HOME_VISITS_SQL}
     SELECT count(*) FILTER (WHERE h.site = 'home')::int AS home,
            count(*) FILTER (WHERE h.site = 'ghm')::int AS ghm,
            count(*) FILTER (WHERE h.site IS NULL)::int AS pending,
            COALESCE((SELECT json_agg(c ORDER BY c.count DESC, c.name)
                        FROM (SELECT h2.collector_id AS id, h2.collected_by AS name,
                                     count(*)::int AS count
                                FROM rows h2
                               WHERE h2.site = 'home' AND ${search.replaceAll("h.", "h2.")}
                               GROUP BY h2.collector_id, h2.collected_by) c), '[]'::json)
              AS by_collector
       FROM rows h
      WHERE ${search}`,
    params,
  );
  const r = rows[0];
  return { home: r.home, ghm: r.ghm, pending: r.pending, byCollector: r.by_collector };
}

export async function listHomeCollections(filters, db = pool) {
  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 25, HOME_REPORT_PAGE_MAX);
  const params = [filters.from, filters.to];
  const filter = where(filters, params);
  const sort = HOME_REPORT_SORTS[filters.sort] ?? HOME_REPORT_SORTS.date_desc;
  const { rows } = await db.query(
    `${HOME_VISITS_SQL}
     SELECT h.*, count(*) OVER ()::int AS total
       FROM rows h
      WHERE ${filter}
      ORDER BY ${sort}
      LIMIT $${params.push(pageSize)} OFFSET $${params.push((page - 1) * pageSize)}`,
    params,
  );
  let total = rows[0]?.total ?? 0;
  if (!rows.length && page > 1) {
    const counted = await db.query(
      `${HOME_VISITS_SQL} SELECT count(*)::int AS total FROM rows h WHERE ${filter}`,
      params.slice(0, -2),
    );
    total = counted.rows[0].total;
  }
  return {
    rows: rows.map(shapeRow),
    total,
    page,
    pageSize,
    summary: await summaryOf(filters, db),
  };
}

const SITE_TEXT = { ...HOME_SITE_LABEL, pending: "Not collected yet" };

export async function homeCollectionsWorkbook(filters, db = pool) {
  const listed = await listHomeCollections(
    { ...filters, page: 1, pageSize: HOME_REPORT_PAGE_MAX },
    db,
  );
  const all = [];
  for (let page = 1; all.length < Math.min(listed.total, EXPORT_ROW_CAP); page += 1) {
    const next =
      page === 1
        ? listed
        : await listHomeCollections({ ...filters, page, pageSize: HOME_REPORT_PAGE_MAX }, db);
    if (!next.rows.length) break;
    all.push(...next.rows);
  }
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const s = listed.summary;
  sheet(
    workbook,
    "Summary",
    [
      { header: "Measure", key: "label", width: 34 },
      { header: "Value", key: "value", width: 24 },
    ],
    [
      { label: "Dates", value: `${filters.from} to ${filters.to}` },
      { label: "Collected at home", value: s.home },
      { label: "Came to GHM", value: s.ghm },
      { label: "Not collected yet", value: s.pending },
      ...s.byCollector.map((c) => ({ label: `At home by ${c.name || "—"}`, value: c.count })),
    ],
  );
  sheet(
    workbook,
    "Home collections",
    [
      { header: "Date", key: "date", width: 12 },
      { header: "Patient", key: "name", width: 28 },
      { header: "UHID", key: "fileNo", width: 14 },
      { header: "Tests", key: "tests", width: 40 },
      { header: "Site", key: "site", width: 18 },
      { header: "Collected by", key: "collectedBy", width: 18 },
      { header: "Collected at", key: "collectedAt", width: 14 },
      { header: "Lab status", key: "labStatus", width: 18 },
    ],
    all.slice(0, EXPORT_ROW_CAP).map((r) => ({
      ...r,
      tests: r.tests.join(", "),
      site: SITE_TEXT[r.site] ?? r.site,
      collectedAt: r.collectedAt ? istClock(r.collectedAt) : "",
    })),
  );
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: `home-collections-${filters.from}-to-${filters.to}.xlsx`,
  };
}
