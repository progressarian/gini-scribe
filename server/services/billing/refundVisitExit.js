import pool from "../../config/db.js";
import { CHAIN, chainIndex, isChainStatus } from "../../../shared/giniflowStatus.js";
import { endVisit } from "../giniflow/pharmacyStation.js";

export const REFUND_REASONS_ENDING_VISIT = ["long_wait", "patient_declined"];

const DOCTOR_STARTED = "with_doctor";
const SEEN = CHAIN.slice(chainIndex(DOCTOR_STARTED), chainIndex("dispensed") + 1);
const ON_FLOOR_FROM = chainIndex("checked_in");
const LEFT_FROM = chainIndex("dispensed");

const VISIT_SQL = `
  SELECT v.current_status,
         EXISTS (SELECT 1 FROM bill_lines l JOIN service_items i ON i.id = l.service_item_id
                  WHERE l.bill_id = $2 AND i.kind = 'consultation') AS consultation,
         EXISTS (SELECT 1 FROM giniflow_visit_events e
                  WHERE e.visit_id = v.id
                    AND (e.status = ANY($3::text[])
                         OR (e.status = 'exited'
                             AND e.meta ->> 'source' IS DISTINCT FROM 'counter_end_visit'
                             AND e.meta ->> 'reason' IS DISTINCT FROM 'lab_only_reports_complete')))
           AS seen
    FROM giniflow_visits v
   WHERE v.id = $1`;

const kept = (why) => ({ ended: false, why });

export async function endVisitAfterRefund(request, ctx, db = pool) {
  const refund = request?.refund;
  const creditNoteId = refund?.credit_note?.id;
  if (!creditNoteId || !request.visit_id) return null;
  if (!REFUND_REASONS_ENDING_VISIT.includes(refund.reason_code)) return null;
  const { rows } = await db.query(VISIT_SQL, [request.visit_id, creditNoteId, SEEN]);
  const visit = rows[0];
  if (!visit?.consultation) return null;
  const status = visit.current_status;
  const at = chainIndex(status);
  if (!isChainStatus(status) || at < ON_FLOOR_FROM || at >= LEFT_FROM) return kept("not_on_floor");
  if (visit.seen || at >= chainIndex(DOCTOR_STARTED)) return kept("seen");
  try {
    const done = await endVisit(
      request.visit_id,
      {
        actorId: ctx?.actorId ?? null,
        actorRole: ctx?.role || "billing",
        onlyBefore: DOCTOR_STARTED,
        meta: { refund_request_id: request.id, refund_reason: refund.reason_code },
      },
      db,
    );
    if (done.unchanged) return kept(done.tooLate ? "seen" : "not_on_floor");
    return { ended: true, from: done.from };
  } catch (error) {
    console.warn("[billing refunds] visit not ended:", request.visit_id, error?.message);
    return kept("error");
  }
}
