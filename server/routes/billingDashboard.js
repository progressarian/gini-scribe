import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  BILLING_DASHBOARD_CHARGES_LABELS,
  BILLING_DASHBOARD_LABELS,
  billingDashboardChargesQuerySchema,
  billingDashboardQuerySchema,
} from "../schemas/billingReports.js";
import { billingRoute as run, sendFailure, sendXlsx } from "./billingHttp.js";
import { billingDashboard } from "../services/billing/dashboard.js";
import { chargeDetail } from "../services/billing/dashboardCharges.js";
import { dashboardWorkbook } from "../services/billing/dashboardExport.js";

const router = Router();
const BASE = "/billing/dashboard";
const reports = requireCapability(CAP.BILLING_REPORTS);
const dashboardQuery = validateQuery(billingDashboardQuerySchema, BILLING_DASHBOARD_LABELS);

router.get(
  `${BASE}/charges`,
  reports,
  validateQuery(billingDashboardChargesQuerySchema, BILLING_DASHBOARD_CHARGES_LABELS),
  run("Billing dashboard charges", 200, (req) => chargeDetail(req.query)),
);

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
