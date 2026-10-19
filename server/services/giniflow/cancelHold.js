import { LIVE_LAB_CASE_SQL } from "./testsHold.js";

export const PENDING_HOLD_MESSAGE = "Cancellation requested — waiting for admin";

export async function assertNotHeld(db, { orderId = null, caseNo = null }) {
  if (!orderId && !caseNo) return;
  const { rows } = await db.query(
    `SELECT 1 FROM billing_requests
      WHERE kind = 'test_cancel' AND status = 'pending'
        AND (($1::text IS NOT NULL AND cancel_key LIKE 'order:' || $1 || ':%')
             OR ($2::text IS NOT NULL
                 AND (cancel_key = 'case:' || $2 OR cancel_key LIKE 'case:' || $2 || ':%')))
      LIMIT 1`,
    [orderId, caseNo],
  );
  if (rows.length)
    throw Object.assign(new Error(PENDING_HOLD_MESSAGE), { status: 409, code: "cancel_pending" });
}

export const HELD_ORDER_SQL = (o) => `EXISTS (
  SELECT 1 FROM billing_requests hr
   WHERE hr.kind = 'test_cancel' AND hr.status = 'pending'
     AND hr.cancel_key LIKE 'order:' || ${o}.id::text || ':%')`;

export const HELD_CASE_SQL = (lc) => `EXISTS (
  SELECT 1 FROM billing_requests hr
   WHERE hr.kind = 'test_cancel' AND hr.status = 'pending'
     AND (hr.cancel_key = 'case:' || ${lc}.case_no
          OR hr.cancel_key LIKE 'case:' || ${lc}.case_no || ':%'))`;

export const CASE_CANCEL_STAGE_SQL = (lc) => `(CASE
  WHEN NOT ${LIVE_LAB_CASE_SQL(lc)}
    OR COALESCE(${lc}.raw_detail_json, ${lc}.raw_list_json)->>'reported_on' IS NOT NULL
    OR COALESCE(${lc}.results_synced, FALSE)
    OR EXISTS (SELECT 1 FROM lab_results r WHERE r.lab_case_no = ${lc}.case_no)
    THEN 'locked'
  WHEN EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                WHERE a.case_no = ${lc}.case_no
                  AND a.action IN ('sample_taken', 'sample_sent', 'sample_received'))
    OR ${lc}.raw_list_json->>'phlebotomy_status' = 'Completed'
    OR COALESCE(${lc}.raw_detail_json, ${lc}.raw_list_json)->>'collected_on' IS NOT NULL
    OR COALESCE(${lc}.raw_detail_json, ${lc}.raw_list_json)->>'received_on' IS NOT NULL
    THEN 'request'
  WHEN EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                WHERE a.case_no = ${lc}.case_no AND a.action = 'drawing_started')
    THEN 'cancel_start_first'
  ELSE 'direct' END)`;
