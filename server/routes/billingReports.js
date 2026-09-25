import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { BILLING_REPORT_LABELS, billingReportQuerySchema } from "../schemas/index.js";
import { billingRoute as run, sendFailure, sendXlsx } from "./billingHttp.js";
import { reportCatalog, runReport } from "../services/billing/reports.js";
import { reportWorkbook } from "../services/billing/reportsExport.js";

const router = Router();
const BASE = "/billing/reports";
const reports = requireCapability(CAP.BILLING_REPORTS);
const filters = validateQuery(billingReportQuerySchema, BILLING_REPORT_LABELS);

router.get(
  `${BASE}`,
  reports,
  run("Billing reports catalog", 200, () => reportCatalog()),
);

router.get(
  `${BASE}/:key`,
  reports,
  filters,
  run("Billing report", 200, (req) => runReport(req.params.key, req.query)),
);

router.get(`${BASE}/:key/export`, reports, filters, async (req, res) => {
  try {
    const { buffer, fileName } = await reportWorkbook(req.params.key, req.query);
    sendXlsx(res, buffer, fileName);
  } catch (e) {
    sendFailure("Billing report export", res, e);
  }
});

export default router;
