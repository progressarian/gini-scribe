import express from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import { CAPABILITIES as CAP, hasCapability } from "../../shared/permissions.js";
import { auditContext } from "../services/billing/audit.js";
import {
  testCancelApproveSchema,
  testCancelNowSchema,
  testCancelRejectSchema,
  testCancelRequestSchema,
} from "../schemas/index.js";
import {
  approveCancelRequest,
  cancelNow,
  cancelRequestDetail,
  cancelStage,
  listCancelRequests,
  raiseCancelRequest,
  rejectCancelRequest,
  withdrawCancelRequest,
} from "../services/giniflow/cancelRequests.js";

const router = express.Router();
const BASE = "/giniflow/tests";
const ask = requireCapability(CAP.GINIFLOW_TEST_CANCEL);
const decide = requireCapability(CAP.GINIFLOW_TEST_CANCEL_DECIDE);

const ctx = (req) => ({
  ...auditContext(req),
  role: req.doctor?.role ?? null,
  canDecide: hasCapability(req.doctor?.role, CAP.GINIFLOW_TEST_CANCEL_DECIDE),
});

const run = (label, work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (e) {
    handleError(res, e, label);
  }
};

router.get(
  `${BASE}/cancel-stage`,
  ask,
  run("Test cancel stage", (req) =>
    cancelStage({
      orderId: req.query.orderId,
      testId: req.query.testId,
      caseNo: req.query.caseNo,
      patientId: req.query.patientId,
      date: req.query.date,
    }),
  ),
);

router.post(
  `${BASE}/cancel-requests`,
  ask,
  validate(testCancelRequestSchema),
  run("Ask to cancel a collected test", (req) => raiseCancelRequest(req.body, ctx(req))),
);

router.post(
  `${BASE}/cancel-requests/:id/withdraw`,
  ask,
  run("Withdraw a cancellation request", (req) => withdrawCancelRequest(req.params.id, ctx(req))),
);

router.get(
  `${BASE}/cancel-requests`,
  decide,
  run("List cancellation requests", (req) => listCancelRequests(req.query)),
);

router.get(
  `${BASE}/cancel-requests/:id`,
  decide,
  run("Read a cancellation request", (req) => cancelRequestDetail(req.params.id)),
);

router.post(
  `${BASE}/cancel-requests/:id/approve`,
  decide,
  validate(testCancelApproveSchema),
  run("Approve a cancellation", (req) => approveCancelRequest(req.params.id, req.body, ctx(req))),
);

router.post(
  `${BASE}/cancel-requests/:id/reject`,
  decide,
  validate(testCancelRejectSchema),
  run("Reject a cancellation", (req) => rejectCancelRequest(req.params.id, req.body, ctx(req))),
);

router.post(
  `${BASE}/cancel-now`,
  decide,
  validate(testCancelNowSchema),
  run("Cancel a collected test", (req) => cancelNow(req.body, ctx(req))),
);

export default router;
