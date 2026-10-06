import pool from "../../config/db.js";
import { SENT_OUTSIDE } from "../../../shared/labStages.js";
import { FLAT } from "./labCatalog.js";
import { IST_TODAY } from "./statusEngine.js";
import { LIVE_LAB_CASE_SQL } from "./testsHold.js";

export const OUTSIDE_PAGE_SIZE = 50;

const STATUSES = ["collected", "sent", "uploaded"];

const likeOf = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const istDay = (column) => `(${column} AT TIME ZONE 'Asia/Kolkata')::date`;

const OUTSIDE_NAMES = `
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
  WITH outside_names AS (${OUTSIDE_NAMES}),
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
     WHERE ${LIVE_LAB_CASE_SQL("lc")}
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

const LIST_SQL = `
  ${PENDING_CTE}
  SELECT kind, ref, visit_date::text AS visit_date, status,
         (${IST_TODAY} - visit_date)::int AS days_waiting,
         patient_id, name, file_no, age, sex, tests,
         collected_at, sent_at, sent_by, uploaded_at, uploaded_by, doc_id,
         count(*) OVER ()::int AS total
    FROM pending
   WHERE status = ANY($1::text[])
     AND ($2::date IS NULL OR visit_date >= $2::date)
     AND ($3::date IS NULL OR visit_date <= $3::date)
     AND ($4::text IS NULL OR name ILIKE $4 OR file_no ILIKE $4
          OR array_to_string(tests, ' ') ILIKE $4)
   ORDER BY status = 'uploaded', visit_date, created, ref
   LIMIT $5 OFFSET $6`;

const COUNT_SQL = `
  ${PENDING_CTE}
  SELECT status, count(*)::int AS n FROM pending GROUP BY status`;

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
  const term = String(q || "").trim();
  const pageNo = Math.max(1, Math.floor(Number(page)) || 1);
  const [{ rows }, { rows: counted }] = await Promise.all([
    db.query(LIST_SQL, [
      STATUSES.includes(status) ? [status] : STATUSES,
      from || null,
      to || null,
      term ? likeOf(term) : null,
      OUTSIDE_PAGE_SIZE,
      (pageNo - 1) * OUTSIDE_PAGE_SIZE,
    ]),
    db.query(COUNT_SQL),
  ]);
  const byStatus = Object.fromEntries(counted.map((row) => [row.status, row.n]));
  const collected = byStatus.collected ?? 0;
  const sent = byStatus.sent ?? 0;
  const uploaded = byStatus.uploaded ?? 0;
  const total = rows[0]?.total ?? 0;
  return {
    rows: rows.map(shape),
    total,
    page: pageNo,
    pages: Math.max(1, Math.ceil(total / OUTSIDE_PAGE_SIZE)),
    pageSize: OUTSIDE_PAGE_SIZE,
    counts: {
      pending: collected + sent,
      all: collected + sent + uploaded,
      collected,
      sent,
      uploaded,
    },
  };
}
