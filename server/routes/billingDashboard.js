import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  BILLING_DASHBOARD_LABELS,
  BILLING_MIS_COLUMN_LABELS,
  billingDashboardQuerySchema,
  billingMisColumnSchema,
} from "../schemas/billingReports.js";
import { billingRoute as run, sendFailure, sendXlsx } from "./billingHttp.js";
import { auditContext } from "../services/billing/audit.js";
import { billingDashboard, clearDashboardCache } from "../services/billing/dashboard.js";
import { dashboardWorkbook } from "../services/billing/dashboardExport.js";
import { listMisColumns, updateMisColumn } from "../services/billing/misColumns.js";

const router = Router();
const BASE = "/billing/dashboard";
const reports = requireCapability(CAP.BILLING_REPORTS);
const master = requireCapability(CAP.BILLING_MASTER);

router.get(
  `${BASE}/columns`,
  reports,
  run("Billing MIS columns", 200, () => listMisColumns()),
);

router.put(
  `${BASE}/columns/:key`,
  master,
  validate(billingMisColumnSchema, BILLING_MIS_COLUMN_LABELS),
  run("Update billing MIS column", 200, async (req) => {
    const column = await updateMisColumn(req.params.key, req.body, auditContext(req));
    clearDashboardCache();
    return column;
  }),
);

const dashboardQuery = validateQuery(billingDashboardQuerySchema, BILLING_DASHBOARD_LABELS);

router.get(`${BASE}/export`, reports, dashboardQuery, async (req, res) => {
  try {
    const { buffer, fileName } = await dashboardWorkbook(req.query);
    sendXlsx(res, buffer, fileName);
  } catch (e) {
    sendFailure("Billing dashboard export", res, e);
  }
});

router.get(
  BASE,
  reports,
  dashboardQuery,
  run("Billing dashboard", 200, (req) => billingDashboard(req.query)),
);

export default router;
