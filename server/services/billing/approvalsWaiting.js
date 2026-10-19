import pool from "../../config/db.js";
import { CAPABILITIES as CAP, hasCapability } from "../../../shared/permissions.js";

const WAITING_SQL = `
  SELECT COUNT(*) FILTER (WHERE kind <> 'test_cancel')::int AS desk,
         COUNT(*) FILTER (WHERE kind = 'test_cancel')::int AS cancellations
    FROM billing_requests
   WHERE status = 'pending'`;

export async function approvalsWaiting(who, db = pool) {
  const { rows } = await db.query(WAITING_SQL);
  return {
    deskRequests: hasCapability(who, CAP.BILLING_MASTER) ? rows[0].desk : null,
    testCancellations: hasCapability(who, CAP.GINIFLOW_TEST_CANCEL_DECIDE)
      ? rows[0].cancellations
      : null,
  };
}
