import express from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import { CAPABILITIES as CAP, hasCapability } from "../../shared/permissions.js";
import { auditContext } from "../services/billing/audit.js";
import {
  reportReleaseApproveSchema,
  reportReleaseRejectSchema,
  reportReleaseRequestSchema,
} from "../schemas/index.js";
import {
  approveReleaseRequest,
  listReleaseRequests,
  raiseReleaseRequest,
  rejectReleaseRequest,
  releaseStateFor,
  withdrawReleaseRequest,
} from "../services/giniflow/reportRelease.js";

const router = express.Router();
const BASE = "/giniflow/report-releases";
const ask = requireCapability(CAP.LAB_REPORT_RELEASE_REQUEST);
const decide = requireCapability(CAP.LAB_REPORT_RELEASE_DECIDE);
const see = requireCapability([CAP.LAB_REPORT_RELEASE_REQUEST, CAP.LAB_REPORT_RELEASE_DECIDE]);

const ctx = (req) => ({
  ...auditContext(req),
  canDecide: hasCapability(req.doctor?.role, CAP.LAB_REPORT_RELEASE_DECIDE),
});

const run = (label, work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (e) {
    handleError(res, e, label);
  }
};

router.get(
  BASE,
  see,
  run("List report release requests", (req) => listReleaseRequests(req.query)),
);

router.get(
  `${BASE}/visit/:visitId`,
  see,
  run("Report release state", (req) => releaseStateFor(req.params.visitId)),
);

router.post(
  BASE,
  ask,
  validate(reportReleaseRequestSchema),
  run("Ask to release a report", (req) => raiseReleaseRequest(req.body, ctx(req))),
);

router.post(
  `${BASE}/:id/withdraw`,
  see,
  run("Withdraw a report release request", (req) =>
    withdrawReleaseRequest(req.params.id, ctx(req)),
  ),
);

router.post(
  `${BASE}/:id/approve`,
  decide,
  validate(reportReleaseApproveSchema),
  run("Approve a report release", (req) =>
    approveReleaseRequest(req.params.id, req.body, ctx(req)),
  ),
);

router.post(
  `${BASE}/:id/reject`,
  decide,
  validate(reportReleaseRejectSchema),
  run("Reject a report release", (req) => rejectReleaseRequest(req.params.id, req.body, ctx(req))),
);

export default router;
