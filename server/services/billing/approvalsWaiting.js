import pool from "../../config/db.js";
import { CAPABILITIES as CAP, hasCapability } from "../../../shared/permissions.js";
import { approvalCounts } from "../slots/approvalDecisions.js";

const WAITING_SQL = `
  SELECT COUNT(*) FILTER (WHERE kind NOT IN ('test_cancel', 'report_release'))::int AS desk,
         COUNT(*) FILTER (WHERE kind = 'test_cancel')::int AS cancellations,
         COUNT(*) FILTER (WHERE kind = 'report_release')::int AS releases
    FROM billing_requests
   WHERE status = 'pending'`;

export async function approvalsWaiting(who, db = pool) {
  const { rows } = await db.query(WAITING_SQL);
  return {
    deskRequests: hasCapability(who, CAP.BILLING_MASTER) ? rows[0].desk : null,
    testCancellations: hasCapability(who, CAP.GINIFLOW_TEST_CANCEL_DECIDE)
      ? rows[0].cancellations
      : null,
    reportReleases: hasCapability(who, CAP.LAB_REPORT_RELEASE_DECIDE) ? rows[0].releases : null,
    bookingApprovals: hasCapability(who, CAP.BOOKING_APPROVE)
      ? (await approvalCounts({ client: db })).pending
      : null,
  };
}
