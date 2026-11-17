import { Router } from "express";
import { CAPABILITIES as CAP, hasAnyCapability } from "../../shared/permissions.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import {
  pharmacyBillLabels,
  pharmacyBillPatientQuerySchema,
  pharmacyCollectDueSchema,
  pharmacyCreditLabels,
  pharmacyDepartmentLabels,
  pharmacyDuesQuerySchema,
  pharmacyIndentListQuerySchema,
  pharmacyIndentSchema,
  pharmacyIndentReturnSchema,
  pharmacyTransferListQuerySchema,
  pharmacyTransferSchema,
  pharmacyExpiryQuerySchema,
  pharmacyReportQuerySchema,
  pharmacyTopItemsQuerySchema,
  pharmacyVendorReturnLabels,
  pharmacyVendorReturnListQuerySchema,
  pharmacyVendorReturnSchema,
} from "../schemas/index.js";
import {
  REPORT_LIST,
  pharmacyDashboard,
  reportWorkbook,
  runReport,
  topItems,
  topItemsWorkbook,
} from "../services/pharmacy/reports.js";
import {
  createVendorReturn,
  expiryList,
  getVendorReturn,
  listVendorReturns,
} from "../services/pharmacy/vendorReturns.js";
import { auditContext } from "../services/billing/audit.js";
import { createTransfer, getTransfer, listTransfers } from "../services/pharmacy/transfers.js";
import {
  createIndent,
  getIndent,
  listIndents,
  returnIndent,
} from "../services/pharmacy/indents.js";
import { searchBillPatients } from "../services/pharmacy/billPatients.js";
import { getBill } from "../services/pharmacy/bills.js";
import { collectDue, listDues } from "../services/pharmacy/credit.js";

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

const known = (pattern, noun) => (req, res, next) =>
  pattern.test(req.params.id) ? next() : res.status(404).json({ error: `${noun} not found` });

router.get(
  "/pharmacy/transfers",
  validateQuery(pharmacyTransferListQuerySchema),
  route("Stock transfers", (req) => listTransfers(req.query)),
);

router.get(
  "/pharmacy/transfers/:id",
  known(ID, "Stock transfer"),
  route("Stock transfer", (req) => getTransfer(Number(req.params.id))),
);

router.post(
  "/pharmacy/transfers",
  validate(pharmacyTransferSchema, pharmacyDepartmentLabels),
  route("Move stock", (req) => createTransfer(req.body, auditContext(req)), 201),
);

router.get(
  "/pharmacy/indents/patients",
  validateQuery(pharmacyBillPatientQuerySchema, pharmacyBillLabels),
  route("Indent patient search", (req) => searchBillPatients(req.query)),
);

router.get(
  "/pharmacy/indents",
  validateQuery(pharmacyIndentListQuerySchema),
  route("Indents", (req) => listIndents(req.query)),
);

router.get(
  "/pharmacy/indents/:id",
  known(ID, "Indent"),
  route("Indent", (req) => getIndent(Number(req.params.id))),
);

router.post(
  "/pharmacy/indents",
  validate(pharmacyIndentSchema, pharmacyDepartmentLabels),
  route("Issue indent", (req) => createIndent(req.body, auditContext(req)), 201),
);

router.post(
  "/pharmacy/indents/:id/returns",
  known(ID, "Indent"),
  validate(pharmacyIndentReturnSchema, { ...pharmacyDepartmentLabels, reason: "Reason" }),
  route(
    "Indent return",
    (req) => returnIndent(Number(req.params.id), req.body, auditContext(req)),
    201,
  ),
);

router.get(
  "/pharmacy/collect/dues",
  validateQuery(pharmacyDuesQuerySchema),
  route("Pharmacy dues at reception", (req) => listDues(req.query)),
);

router.get(
  "/pharmacy/collect/bills/:id",
  known(UUID, "Pharmacy bill"),
  route("Pharmacy bill at reception", (req) => getBill(req.params.id)),
);

router.post(
  "/pharmacy/collect/bills/:id/payments",
  known(UUID, "Pharmacy bill"),
  validate(pharmacyCollectDueSchema, pharmacyCreditLabels),
  route("Collect pharmacy bill at reception", (req) =>
    collectDue(req.params.id, req.body, auditContext(req), undefined, {
      requireShiftForCash: true,
    }),
  ),
);

router.get(
  "/pharmacy/expiry",
  validateQuery(pharmacyExpiryQuerySchema),
  route("Expiry list", (req) =>
    expiryList({
      ...req.query,
      withCost: hasAnyCapability(req.doctor, [CAP.PHARMACY_PURCHASE, CAP.PHARMACY_MASTER]),
    }),
  ),
);

router.get(
  "/pharmacy/vendor-returns",
  validateQuery(pharmacyVendorReturnListQuerySchema),
  route("Vendor returns", (req) => listVendorReturns(req.query)),
);

router.get(
  "/pharmacy/vendor-returns/:id",
  known(ID, "Vendor return"),
  route("Vendor return", (req) => getVendorReturn(Number(req.params.id))),
);

router.post(
  "/pharmacy/vendor-returns",
  validate(pharmacyVendorReturnSchema, pharmacyVendorReturnLabels),
  route("Return to vendor", (req) => createVendorReturn(req.body, auditContext(req)), 201),
);

const REPORT_KEY = /^[a-z0-9_]{2,40}$/;
const reportKey = (req, res, next) =>
  REPORT_KEY.test(req.params.key) ? next() : res.status(404).json({ error: "Report not found" });

router.get(
  "/pharmacy/reports",
  route("Pharmacy reports", () => REPORT_LIST),
);

router.get(
  "/pharmacy/reports/dashboard",
  route("Pharmacy dashboard", () => pharmacyDashboard()),
);

router.get(
  "/pharmacy/reports/top-items",
  validateQuery(pharmacyTopItemsQuerySchema, { from: "From", to: "To" }),
  route("Top selling items", (req) => topItems(req.query)),
);

router.get(
  "/pharmacy/reports/top-items.xlsx",
  validateQuery(pharmacyTopItemsQuerySchema, { from: "From", to: "To" }),
  async (req, res) => {
    try {
      const file = await topItemsWorkbook(req.query);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      res.send(file.buffer);
    } catch (e) {
      handleError(res, e, "Top selling items export");
    }
  },
);

router.get(
  "/pharmacy/reports/:key/export.xlsx",
  reportKey,
  validateQuery(pharmacyReportQuerySchema, { from: "From", to: "To" }),
  async (req, res) => {
    try {
      const file = await reportWorkbook(req.params.key, req.query);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      res.send(file.buffer);
    } catch (e) {
      handleError(res, e, "Pharmacy report export");
    }
  },
);

router.get(
  "/pharmacy/reports/:key",
  reportKey,
  validateQuery(pharmacyReportQuerySchema, { from: "From", to: "To" }),
  route("Pharmacy report", (req) => runReport(req.params.key, req.query)),
);

export default router;
