import { Router } from "express";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import {
  pharmacyAccountLabels,
  pharmacyDepositRefundSchema,
  pharmacyDepositSchema,
  pharmacyLedgerQuerySchema,
  pharmacyVoucherSchema,
  pharmacyWriteOffSchema,
} from "../schemas/index.js";
import { auditContext } from "../services/billing/audit.js";
import {
  addVoucher,
  patientAccount,
  patientLedger,
  receiveDeposit,
  refundDeposit,
  writeOffDue,
} from "../services/pharmacy/accounts.js";

const router = Router();
const ID = /^[1-9][0-9]{0,9}$/;
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

const patientId = (req, res, next) =>
  ID.test(req.params.patientId) ? next() : res.status(404).json({ error: "Patient not found" });

const canCollect = requireCapability([CAP.PHARMACY_BILL, CAP.PHARMACY_COLLECT]);
const canAdjust = requireCapability(CAP.PHARMACY_CREDIT_APPROVE);
const canReport = requireCapability([CAP.PHARMACY_REPORTS, CAP.PHARMACY_CREDIT_APPROVE]);

router.get(
  "/pharmacy/accounts/ledger",
  canReport,
  validateQuery(pharmacyLedgerQuerySchema),
  route("Pharmacy patient ledger", (req) => patientLedger(req.query)),
);

router.get(
  "/pharmacy/accounts/:patientId",
  patientId,
  route("Pharmacy patient account", (req) => patientAccount(Number(req.params.patientId))),
);

router.post(
  "/pharmacy/accounts/:patientId/deposits",
  patientId,
  canCollect,
  validate(pharmacyDepositSchema, pharmacyAccountLabels),
  route(
    "Pharmacy deposit",
    (req) => receiveDeposit(Number(req.params.patientId), req.body, auditContext(req)),
    201,
  ),
);

router.post(
  "/pharmacy/accounts/:patientId/deposit-refunds",
  patientId,
  canCollect,
  validate(pharmacyDepositRefundSchema, pharmacyAccountLabels),
  route(
    "Pharmacy deposit refund",
    (req) => refundDeposit(Number(req.params.patientId), req.body, auditContext(req)),
    201,
  ),
);

router.post(
  "/pharmacy/accounts/:patientId/vouchers",
  patientId,
  canAdjust,
  validate(pharmacyVoucherSchema, pharmacyAccountLabels),
  route(
    "Pharmacy manual voucher",
    (req) => addVoucher(Number(req.params.patientId), req.body, auditContext(req)),
    201,
  ),
);

router.post(
  "/pharmacy/accounts/bills/:billId/write-off",
  (req, res, next) =>
    UUID.test(req.params.billId)
      ? next()
      : res.status(404).json({ error: "Pharmacy bill not found" }),
  canAdjust,
  validate(pharmacyWriteOffSchema, pharmacyAccountLabels),
  route("Pharmacy write-off", (req) => writeOffDue(req.params.billId, req.body, auditContext(req))),
);

export default router;
