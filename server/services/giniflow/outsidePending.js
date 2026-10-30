import pool from "../../config/db.js";
import { SENT_OUTSIDE } from "../../../shared/labStages.js";
import { FLAT } from "./labCatalog.js";
import { IST_TODAY } from "./statusEngine.js";
import { LIVE_LAB_CASE_SQL } from "./testsHold.js";

export const OUTSIDE_PAGE_SIZE = 50;

const STATUSES = ["collected", "sent", "uploaded"];

const CASE_LOOKBACK_DAYS = 30;

const istDay = (column) => `(${column} AT TIME ZONE 'Asia/Kolkata')::date`;

const pendingTtlMs = () => {
  const value = Number(process.env.GINIFLOW_OUTSIDE_PENDING_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : 30_000;
};
const NAMES_TTL_MS = 10 * 60_000;

const OUTSIDE_NAMES_SQL = `
  SELECT ${FLAT("c.test_name")} AS flat
    FROM service_items i JOIN giniflow_test_catalog c ON c.id = i.test_catalog_id
   WHERE i.is_active AND i.is_outsourced
  UNION
  SELECT a.flat_name
    FROM service_item_aliases a JOIN service_items i ON i.id = a.service_item_id
   WHERE i.is_active AND i.is_outsourced`;

const caseAction = (action, alias) => `
  LEFT JOIN LATERAL (
    SELECT a.created_at, a.actor_id FROM giniflow_lab_case_actions a
     WHERE a.case_no = lc.case_no AND a.action = '${action}'
  ) ${alias} ON TRUE`;

const PENDING_CTE = `
  WITH outside_names AS (SELECT unnest($1::text[]) AS flat),
  pending AS (
    SELECT 'order' AS kind, o.id::text AS ref, v.visit_date,
           CASE o.sample_status WHEN '${SENT_OUTSIDE}' THEN 'sent'
                                WHEN 'uploaded' THEN 'uploaded'
                                ELSE 'collected' END AS status,
           p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
           (SELECT array_agg(t.test_name ORDER BY t.test_name)
              FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS tests,
           (SELECT max(e.occurred_at) FROM giniflow_lab_order_events e
             WHERE e.lab_order_id = o.id AND e.track = 'sample'
               AND e.status = 'sample_collected') AS collected_at,
           sent.occurred_at AS sent_at,
           COALESCE(sender.short_name, sender.name) AS sent_by,
           CASE WHEN o.sample_status = 'uploaded' THEN o.uploaded_at END AS uploaded_at,
           COALESCE(uploader.short_name, uploader.name) AS uploaded_by,
           (SELECT d.id FROM documents d WHERE d.giniflow_lab_order_id = o.id) AS doc_id,
           o.created_at AS created
      FROM giniflow_lab_orders o
      JOIN giniflow_visits v ON v.id = o.visit_id
      JOIN patients p ON p.id = v.patient_id
      LEFT JOIN LATERAL (
        SELECT e.occurred_at, e.actor_id FROM giniflow_lab_order_events e
         WHERE e.lab_order_id = o.id AND e.track = 'sample' AND e.status = '${SENT_OUTSIDE}'
         ORDER BY e.occurred_at DESC LIMIT 1
      ) sent ON TRUE
      LEFT JOIN doctors sender ON sender.id = sent.actor_id
      LEFT JOIN LATERAL (
        SELECT e.actor_id FROM giniflow_lab_order_events e
         WHERE e.lab_order_id = o.id AND e.track = 'sample'
           AND e.status IN ('uploaded', 'report_replaced')
         ORDER BY e.occurred_at DESC LIMIT 1
      ) upload ON TRUE
      LEFT JOIN doctors uploader ON uploader.id = upload.actor_id
     WHERE o.is_outsourced AND o.kind = 'lab'
       AND (o.sample_status IN ('sample_collected', '${SENT_OUTSIDE}')
            OR (o.sample_status = 'uploaded' AND ${istDay("o.uploaded_at")} = ${IST_TODAY}))
    UNION ALL
    SELECT 'case', lc.case_no, lc.case_date,
           CASE WHEN lc.pdf_storage_path IS NOT NULL THEN 'uploaded'
                WHEN sent.created_at IS NOT NULL THEN 'sent'
                ELSE 'collected' END,
           pt.id, COALESCE(pt.name, lc.raw_list_json->'patient'->>'patient_name'),
           COALESCE(pt.file_no, lc.raw_list_json->'patient'->>'healthray_uid'),
           pt.age, pt.sex,
           COALESCE(lc.test_names, ARRAY[]::text[]),
           COALESCE(taken.created_at,
                    (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on')::timestamptz),
           sent.created_at,
           COALESCE(sender.short_name, sender.name),
           doc.created_at,
           NULL,
           doc.id,
           lc.fetched_at
      FROM lab_cases lc
      LEFT JOIN LATERAL (
        SELECT u.id FROM patients u
         WHERE u.file_no = lc.raw_list_json->'patient'->>'healthray_uid' LIMIT 1
      ) uid ON TRUE
      LEFT JOIN patients pt ON pt.id = COALESCE(lc.patient_id, uid.id)
      ${caseAction(SENT_OUTSIDE, "sent")}
      ${caseAction("sample_taken", "taken")}
      LEFT JOIN doctors sender ON sender.id = sent.actor_id
      LEFT JOIN LATERAL (
        SELECT d.id, d.created_at FROM documents d
         WHERE lc.pdf_storage_path IS NOT NULL AND d.storage_path = lc.pdf_storage_path
         ORDER BY d.id DESC LIMIT 1
      ) doc ON TRUE
     WHERE lc.case_no IN (SELECT r.case_no FROM lab_cases r
                           WHERE r.case_date >= ${IST_TODAY} - ${CASE_LOOKBACK_DAYS}
                          UNION
                          SELECT s.case_no FROM giniflow_lab_case_actions s
                           WHERE s.action = '${SENT_OUTSIDE}')
       AND ${LIVE_LAB_CASE_SQL("lc")}
       AND ((lc.pdf_storage_path IS NULL
             AND COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' IS NULL
             AND NOT EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                              WHERE a.case_no = lc.case_no AND a.action = 'report_uploaded'))
            OR (lc.pdf_storage_path IS NOT NULL AND ${istDay("doc.created_at")} = ${IST_TODAY}))
       AND (sent.created_at IS NOT NULL OR taken.created_at IS NOT NULL
            OR lc.raw_list_json->>'phlebotomy_status' = 'Completed'
            OR COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on' IS NOT NULL)
       AND (sent.created_at IS NOT NULL
            OR lc.case_source = 'outsource'
            OR (cardinality(lc.test_names) > 0
                AND NOT EXISTS (SELECT 1 FROM unnest(lc.test_names) n
                                 WHERE ${FLAT("n")} NOT IN (SELECT flat FROM outside_names))))
       AND NOT EXISTS (
         SELECT 1 FROM giniflow_lab_orders o
           JOIN giniflow_visits gv ON gv.id = o.visit_id
          WHERE gv.visit_date = lc.case_date AND o.kind = 'lab' AND o.urgency = 'today'
            AND gv.patient_id = COALESCE(lc.patient_id, uid.id))
  )`;

const PENDING_SQL = `
  ${PENDING_CTE}
  SELECT kind, ref, visit_date::text AS visit_date, status,
         (${IST_TODAY} - visit_date)::int AS days_waiting,
         patient_id, name, file_no, age, sex, tests,
         collected_at, sent_at, sent_by, uploaded_at, uploaded_by, doc_id, created
    FROM pending`;

const istDate = (when = new Date()) =>
  when.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const cache = { names: null, namesAt: 0, rows: null, day: null, at: 0, building: null, epoch: 0 };

export function forgetOutsidePending({ names = false } = {}) {
  cache.rows = null;
  cache.epoch += 1;
  if (names) cache.names = null;
}

async function outsideNames(db, now) {
  if (cache.names && now - cache.namesAt < NAMES_TTL_MS) return cache.names;
  const { rows } = await db.query(OUTSIDE_NAMES_SQL);
  cache.names = rows.map((row) => row.flat);
  cache.namesAt = now;
  return cache.names;
}

export async function pendingRows(db = pool, now = Date.now()) {
  const day = istDate(new Date(now));
  if (cache.rows && cache.day === day && now - cache.at < pendingTtlMs()) return cache.rows;
  if (cache.building?.day === day && cache.building.epoch === cache.epoch) {
    return cache.building.promise;
  }
  const epoch = cache.epoch;
  const promise = (async () => {
    const { rows } = await db.query(PENDING_SQL, [await outsideNames(db, now)]);
    if (cache.epoch === epoch) Object.assign(cache, { rows, day, at: now });
    return rows;
  })();
  cache.building = { day, epoch, promise };
  try {
    return await promise;
  } finally {
    if (cache.building?.promise === promise) cache.building = null;
  }
}

const countsOf = (rows) => {
  const by = (status) => rows.filter((row) => row.status === status).length;
  const collected = by("collected");
  const sent = by("sent");
  const uploaded = by("uploaded");
  return {
    pending: collected + sent,
    all: collected + sent + uploaded,
    collected,
    sent,
    uploaded,
  };
};

const time = (value) => (value ? new Date(value).getTime() : 0);

const listOrder = (a, b) =>
  Number(a.status === "uploaded") - Number(b.status === "uploaded") ||
  a.visit_date.localeCompare(b.visit_date) ||
  time(a.created) - time(b.created) ||
  (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

const matches = (row, term) =>
  [row.name, row.file_no, (row.tests || []).join(" ")].some((text) =>
    String(text || "")
      .toLowerCase()
      .includes(term),
  );

const shape = (row) => ({
  key: `${row.kind}:${row.ref}`,
  kind: row.kind,
  orderId: row.kind === "order" ? row.ref : null,
  caseNo: row.kind === "case" ? row.ref : null,
  visitDate: row.visit_date,
  daysWaiting: row.days_waiting,
  status: row.status,
  patient: {
    id: row.patient_id,
    name: row.name || "Unnamed patient",
    fileNo: row.file_no,
    age: row.age,
    sex: row.sex,
  },
  tests: row.tests || [],
  collectedAt: row.collected_at,
  sentAt: row.sent_at,
  sentBy: row.sent_by,
  uploadedAt: row.uploaded_at,
  uploadedBy: row.uploaded_by,
  docId: row.doc_id,
});

export async function listOutsidePending(
  { q = "", from = null, to = null, status = "all", page = 1 } = {},
  db = pool,
) {
  const term = String(q || "")
    .trim()
    .toLowerCase();
  const pageNo = Math.max(1, Math.floor(Number(page)) || 1);
  const all = await pendingRows(db);
  const wanted = STATUSES.includes(status) ? [status] : STATUSES;
  const shown = all
    .filter(
      (row) =>
        wanted.includes(row.status) &&
        (!from || row.visit_date >= from) &&
        (!to || row.visit_date <= to) &&
        (!term || matches(row, term)),
    )
    .sort(listOrder);
  const start = (pageNo - 1) * OUTSIDE_PAGE_SIZE;
  return {
    rows: shown.slice(start, start + OUTSIDE_PAGE_SIZE).map(shape),
    total: shown.length,
    page: pageNo,
    pages: Math.max(1, Math.ceil(shown.length / OUTSIDE_PAGE_SIZE)),
    pageSize: OUTSIDE_PAGE_SIZE,
    counts: countsOf(all),
  };
}

export async function countOutsidePending(db = pool) {
  return countsOf(await pendingRows(db));
}
