import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  OPD_SUMMARY_LABELS,
  opdExportQuerySchema,
  opdFiltersQuerySchema,
  opdSummaryQuerySchema,
  opdVisitsQuerySchema,
} from "../schemas/opdSummary.js";
import { billingRoute as run, sendFailure, sendXlsx } from "./billingHttp.js";
import { getOpdFilters, getOpdSummary, listOpdVisits } from "../services/reports/opdSummary.js";
import { opdSummaryWorkbook } from "../services/reports/opdSummaryExport.js";

const router = Router();
const BASE = "/reports/opd";
const allowed = requireCapability(CAP.OPD_SUMMARY);
const query = (schema) => validateQuery(schema, OPD_SUMMARY_LABELS);

router.get(
  `${BASE}/summary`,
  allowed,
  query(opdSummaryQuerySchema),
  run("OPD summary", 200, (req) => getOpdSummary(req.query)),
);

router.get(
  `${BASE}/visits`,
  allowed,
  query(opdVisitsQuerySchema),
  run("OPD visits", 200, (req) => listOpdVisits(req.query)),
);

router.get(
  `${BASE}/filters`,
  allowed,
  query(opdFiltersQuerySchema),
  run("OPD summary filters", 200, (req) => getOpdFilters(req.query)),
);

router.get(`${BASE}/export.xlsx`, allowed, query(opdExportQuerySchema), async (req, res) => {
  try {
    const { buffer, fileName } = await opdSummaryWorkbook(req.query);
    sendXlsx(res, buffer, fileName);
  } catch (e) {
    sendFailure("OPD summary export", res, e);
  }
});

export default router;
