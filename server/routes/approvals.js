import express from "express";
import { requireCapability } from "../middleware/auth.js";
import { handleError } from "../utils/errorHandler.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { approvalsWaiting } from "../services/billing/approvalsWaiting.js";

const APPROVER_CAPABILITIES = [CAP.BILLING_MASTER, CAP.GINIFLOW_TEST_CANCEL_DECIDE];

const router = express.Router();

router.get("/approvals/waiting", requireCapability(APPROVER_CAPABILITIES), async (req, res) => {
  try {
    res.json(await approvalsWaiting(req.doctor));
  } catch (e) {
    handleError(res, e, "Approvals waiting");
  }
});

export default router;
