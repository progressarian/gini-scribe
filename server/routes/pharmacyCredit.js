import { Router } from "express";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import {
  pharmacyCollectDueSchema,
  pharmacyCreditDecisionSchema,
  pharmacyCreditLabels,
  pharmacyCreditListQuerySchema,
  pharmacyCreditRequestSchema,
  pharmacyDuesQuerySchema,
} from "../schemas/index.js";
import { auditContext } from "../services/billing/audit.js";
import {
  collectDue,
  decideCredit,
  listCreditRequests,
  listDues,
  patientCreditHistory,
  requestCredit,
  withdrawCredit,
} from "../services/pharmacy/credit.js";

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const route =
  (label, work, status = 200) =>
  async (req, res) => {
    try {
      res.status(status).json(await work(req));
    } catch (e) {
      handleError(res, e, label);
    }
  };

const known = (noun) => (req, res, next) =>
  UUID.test(req.params.id) ? next() : res.status(404).json({ error: `${noun} not found` });

const canRequest = requireCapability(CAP.PHARMACY_CREDIT_REQUEST);
const canApprove = requireCapability(CAP.PHARMACY_CREDIT_APPROVE);

router.get(
  "/pharmacy/credit/requests",
  validateQuery(pharmacyCreditListQuerySchema),
  route("Credit requests", (req) => listCreditRequests(req.query)),
);

router.post(
  "/pharmacy/credit/bills/:id/requests",
  known("Pharmacy bill"),
  canRequest,
  validate(pharmacyCreditRequestSchema, pharmacyCreditLabels),
  route("Ask for credit", (req) => requestCredit(req.params.id, req.body, auditContext(req)), 201),
);

router.post(
  "/pharmacy/credit/requests/:id/withdraw",
  known("Credit request"),
  canRequest,
  route("Withdraw credit request", (req) => withdrawCredit(req.params.id, auditContext(req))),
);

router.post(
  "/pharmacy/credit/requests/:id/decision",
  known("Credit request"),
  canApprove,
  validate(pharmacyCreditDecisionSchema, pharmacyCreditLabels),
  route("Decide credit request", (req) => decideCredit(req.params.id, req.body, auditContext(req))),
);

router.get(
  "/pharmacy/credit/patients/:id/history",
  (req, res, next) =>
    /^[1-9][0-9]{0,9}$/.test(req.params.id)
      ? next()
      : res.status(404).json({ error: "Patient not found" }),
  route("Patient credit history", (req) => patientCreditHistory(Number(req.params.id))),
);

router.get(
  "/pharmacy/credit/dues",
  validateQuery(pharmacyDuesQuerySchema),
  route("Pharmacy dues", (req) => listDues(req.query)),
);

router.post(
  "/pharmacy/credit/bills/:id/payments",
  known("Pharmacy bill"),
  validate(pharmacyCollectDueSchema, pharmacyCreditLabels),
  route("Collect pharmacy due", (req) => collectDue(req.params.id, req.body, auditContext(req))),
);

export default router;
