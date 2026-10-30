import pool from "../../config/db.js";
import { SENT_OUTSIDE } from "../../../shared/labStages.js";
import { IST_TODAY } from "./statusEngine.js";
import {
  CASE_PATIENT_JOIN,
  IN_WINDOW_SQL,
  caseAction,
  refreshQueuedOutsideStages,
} from "./outsideStage.js";

export const OUTSIDE_PAGE_SIZE = 50;

const STATUSES = ["collected", "sent", "uploaded"];

const istDay = (column) => `(${column} AT TIME ZONE 'Asia/Kolkata')::date`;

const pendingTtlMs = () => {
  const value = Number(process.env.GINIFLOW_OUTSIDE_PENDING_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : 30_000;
};

const PENDING_CTE = `
  WITH pending AS (
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
    SELECT 'case', lc.case_no, lc.case_date, lc.outside_stage,
           pt.id, COALESCE(pt.name, lc.raw_list_json->'patient'->>'patient_name'),
           COALESCE(pt.file_no, lc.raw_list_json->'patient'->>'healthray_uid'),
           pt.age, pt.sex,
           COALESCE(lc.test_names, ARRAY[]::text[]),
           COALESCE(taken.created_at,
                    (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on')::timestamptz),
           sent.created_at,
           COALESCE(sender.short_name, sender.name),
           lc.outside_uploaded_at,
           NULL,
           doc.id,
           lc.fetched_at
      FROM lab_cases lc
      ${CASE_PATIENT_JOIN}
      LEFT JOIN patients pt ON pt.id = COALESCE(lc.patient_id, uid.id)
      ${caseAction(SENT_OUTSIDE, "sent")}
      ${caseAction("sample_taken", "taken")}
      LEFT JOIN doctors sender ON sender.id = sent.actor_id
      LEFT JOIN LATERAL (
        SELECT d.id FROM documents d
         WHERE lc.outside_stage = 'uploaded' AND d.storage_path = lc.pdf_storage_path
         ORDER BY d.id DESC LIMIT 1
      ) doc ON TRUE
     WHERE (lc.outside_stage IN ('collected', 'sent')
            OR (lc.outside_stage = 'uploaded'
                AND lc.outside_uploaded_at >= ${IST_TODAY}::timestamp AT TIME ZONE 'Asia/Kolkata'))
       AND ${IN_WINDOW_SQL}
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

const cache = { rows: null, day: null, at: 0, building: null, epoch: 0 };

export function forgetOutsidePending() {
  cache.rows = null;
  cache.epoch += 1;
}

export async function pendingRows(db = pool, now = Date.now()) {
  const day = istDate(new Date(now));
  if (cache.rows && cache.day === day && now - cache.at < pendingTtlMs()) return cache.rows;
  if (cache.building?.day === day && cache.building.epoch === cache.epoch) {
    return cache.building.promise;
  }
  const epoch = cache.epoch;
  const promise = (async () => {
    await refreshQueuedOutsideStages(db);
    const { rows } = await db.query(PENDING_SQL);
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
