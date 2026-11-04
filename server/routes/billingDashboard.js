import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  BILLING_DASHBOARD_CHARGES_LABELS,
  BILLING_DASHBOARD_LABELS,
  billingDashboardChargesQuerySchema,
  billingDashboardQuerySchema,
  STAFF_DASHBOARD_LABELS,
  staffDashboardQuerySchema,
} from "../schemas/billingReports.js";
import { billingRoute as run, sendFailure, sendXlsx } from "./billingHttp.js";
import { billingDashboard } from "../services/billing/dashboard.js";
import { chargeDetail } from "../services/billing/dashboardCharges.js";
import { dashboardWorkbook } from "../services/billing/dashboardExport.js";
import { staffDashboard, staffShiftDetail } from "../services/billing/staffDashboard.js";
import { staffWorkbook } from "../services/billing/staffExport.js";

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

router.get(
  "/billing/staff/shifts/:id",
  reports,
  run("Staff shift", 200, (req) => staffShiftDetail(req.params.id)),
);

router.get(
  "/billing/staff/export",
  reports,
  validateQuery(staffDashboardQuerySchema, STAFF_DASHBOARD_LABELS),
  async (req, res) => {
    try {
      const { buffer, fileName } = await staffWorkbook(req.query);
      sendXlsx(res, buffer, fileName);
    } catch (e) {
      sendFailure("Staff dashboard export", res, e);
    }
  },
);

router.get(
  "/billing/staff",
  reports,
  validateQuery(staffDashboardQuerySchema, STAFF_DASHBOARD_LABELS),
  run("Staff dashboard", 200, (req) => staffDashboard(req.query)),
);

export default router;
