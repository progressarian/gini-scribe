import pool from "../../config/db.js";
import { SENT_OUTSIDE } from "../../../shared/labStages.js";
import { FLAT } from "./labCatalog.js";
import { IST_TODAY } from "./statusEngine.js";
import { LIVE_LAB_CASE_SQL } from "./testsHold.js";

export const CASE_LOOKBACK_DAYS = 30;

const BATCH_SIZE = 100;

const OUTSIDE_NAMES_SQL = `
  SELECT ${FLAT("c.test_name")} AS flat
    FROM service_items i JOIN giniflow_test_catalog c ON c.id = i.test_catalog_id
   WHERE i.is_active AND i.is_outsourced
  UNION
  SELECT a.flat_name
    FROM service_item_aliases a JOIN service_items i ON i.id = a.service_item_id
   WHERE i.is_active AND i.is_outsourced`;

export const caseAction = (action, alias) => `
  LEFT JOIN LATERAL (
    SELECT a.created_at, a.actor_id FROM giniflow_lab_case_actions a
     WHERE a.case_no = lc.case_no AND a.action = '${action}'
  ) ${alias} ON TRUE`;

export const CASE_PATIENT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT u.id FROM patients u
     WHERE u.file_no = lc.raw_list_json->'patient'->>'healthray_uid' LIMIT 1
  ) uid ON TRUE`;

export const IN_WINDOW_SQL = `(lc.case_date >= ${IST_TODAY} - ${CASE_LOOKBACK_DAYS}
  OR sent.created_at IS NOT NULL)`;

const WINDOW_CASES_SQL = `
  SELECT lc.case_no FROM lab_cases lc
   WHERE lc.case_date >= ${IST_TODAY} - ${CASE_LOOKBACK_DAYS}
      OR lc.outside_stage IS NOT NULL
      OR lc.case_no IN (SELECT s.case_no FROM giniflow_lab_case_actions s
                         WHERE s.action = '${SENT_OUTSIDE}')`;

const COMPUTED_CTE = `
  outside_names AS (${OUTSIDE_NAMES_SQL}),
  facts AS (
    SELECT lc.case_no, lc.pdf_storage_path, sent.created_at AS sent_at, doc.created_at AS doc_at,
           COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' IS NOT NULL
             OR EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                         WHERE a.case_no = lc.case_no AND a.action = 'report_uploaded') AS reported,
           COALESCE(
             ${IN_WINDOW_SQL}
             AND ${LIVE_LAB_CASE_SQL("lc")}
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
                  AND gv.patient_id = COALESCE(lc.patient_id, uid.id)),
             FALSE) AS listed
      FROM lab_cases lc
      JOIN targets t ON t.case_no = lc.case_no
      ${CASE_PATIENT_JOIN}
      ${caseAction(SENT_OUTSIDE, "sent")}
      ${caseAction("sample_taken", "taken")}
      LEFT JOIN LATERAL (
        SELECT d.created_at FROM documents d
         WHERE lc.pdf_storage_path IS NOT NULL AND d.storage_path = lc.pdf_storage_path
         ORDER BY d.id DESC LIMIT 1
      ) doc ON TRUE
  ),
  computed AS (
    SELECT case_no,
           CASE WHEN NOT listed THEN NULL
                WHEN pdf_storage_path IS NOT NULL THEN 'uploaded'
                WHEN reported THEN NULL
                WHEN sent_at IS NOT NULL THEN 'sent'
                ELSE 'collected' END AS stage,
           CASE WHEN listed AND pdf_storage_path IS NOT NULL THEN doc_at END AS uploaded_at
      FROM facts
  )`;

const APPLY_SQL = `
  UPDATE lab_cases lc
     SET outside_stage = c.stage, outside_uploaded_at = c.uploaded_at, outside_stage_at = NOW()
    FROM computed c
   WHERE lc.case_no = c.case_no
     AND (lc.outside_stage IS DISTINCT FROM c.stage
          OR lc.outside_uploaded_at IS DISTINCT FROM c.uploaded_at)
  RETURNING lc.case_no`;

const DIFF_SQL = `
  SELECT c.case_no FROM computed c JOIN lab_cases lc ON lc.case_no = c.case_no
   WHERE lc.outside_stage IS DISTINCT FROM c.stage
      OR lc.outside_uploaded_at IS DISTINCT FROM c.uploaded_at`;

const REFRESH_SQL = `
  WITH targets AS (SELECT DISTINCT unnest($1::text[]) AS case_no),
  ${COMPUTED_CTE}
  ${APPLY_SQL}`;

const DRY_RUN_SQL = `
  WITH targets AS (SELECT DISTINCT unnest($1::text[]) AS case_no),
  ${COMPUTED_CTE}
  ${DIFF_SQL}`;

const DRAIN_SQL = `
  WITH taken AS (
    DELETE FROM giniflow_outside_stage_queue RETURNING case_no, patient_id, day, every_case
  ),
  targets AS (
    SELECT case_no FROM taken WHERE case_no IS NOT NULL
    UNION
    SELECT lc.case_no FROM lab_cases lc
      JOIN taken q ON q.patient_id = lc.patient_id AND q.day = lc.case_date
    UNION
    SELECT w.case_no FROM (${WINDOW_CASES_SQL}) w WHERE EXISTS (SELECT 1 FROM taken WHERE every_case)
  ),
  ${COMPUTED_CTE}
  ${APPLY_SQL}`;

export async function refreshOutsideStage(db, caseNos) {
  if (!caseNos?.length) return 0;
  const { rowCount } = await db.query(REFRESH_SQL, [caseNos]);
  return rowCount;
}

export async function refreshQueuedOutsideStages(db = pool) {
  const { rowCount } = await db.query(DRAIN_SQL);
  return rowCount;
}

export async function sweepOutsideStage(
  db = pool,
  { dryRun = false, onBatch = () => {}, pauseMs = 0 } = {},
) {
  const startedAt = (await db.query(`SELECT NOW() AS at`)).rows[0].at;
  const caseNos = (await db.query(WINDOW_CASES_SQL)).rows.map((row) => row.case_no);
  let fixed = 0;
  for (let start = 0; start < caseNos.length; start += BATCH_SIZE) {
    const batch = caseNos.slice(start, start + BATCH_SIZE);
    const changed = dryRun
      ? (await db.query(DRY_RUN_SQL, [batch])).rowCount
      : await refreshOutsideStage(db, batch);
    fixed += changed;
    onBatch({ done: Math.min(start + BATCH_SIZE, caseNos.length), of: caseNos.length, changed });
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  if (!dryRun) {
    await db.query(`DELETE FROM giniflow_outside_stage_queue WHERE queued_at <= $1`, [startedAt]);
  }
  return { checked: caseNos.length, fixed };
}
