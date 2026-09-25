import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  BILLING_CLAIMS_LABELS,
  billingClaimsClearSchema,
  billingClaimsListQuerySchema,
  billingClaimsUndoSchema,
} from "../schemas/index.js";
import { billingRoute as run, sendFailure } from "./billingHttp.js";
import { auditContext } from "../services/billing/audit.js";
import {
  clearBills,
  exportRegister,
  listCleared,
  listPending,
  readSettlement,
  undoClear,
} from "../services/billing/cghsRegister.js";

const router = Router();
const BASE = "/billing/claims";
const claims = requireCapability(CAP.BILLING_CLAIMS);
const adminOnly = requireCapability(CAP.ADMIN);
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ctx = (req) => ({ ...auditContext(req), role: req.doctor.role });
const listQuery = validateQuery(billingClaimsListQuerySchema, BILLING_CLAIMS_LABELS);

const exportRoute = (tab) => async (req, res) => {
  try {
    const made = await exportRegister(tab, req.query);
    res.set({
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${made.fileName}"`,
      "Content-Length": made.buffer.length,
      "Cache-Control": "no-store",
      "X-Claims-Count": String(made.totals.count),
      "X-Claims-Amount": String(made.totals.amount),
    });
    res.send(made.buffer);
  } catch (e) {
    sendFailure(`CGHS ${tab} export`, res, e);
  }
};

router.get(
  `${BASE}/pending`,
  claims,
  listQuery,
  run("CGHS pending list", 200, (req) => listPending(req.query)),
);
router.get(
  `${BASE}/cleared`,
  claims,
  listQuery,
  run("CGHS cleared list", 200, (req) => listCleared(req.query)),
);
router.get(`${BASE}/pending/export`, claims, listQuery, exportRoute("pending"));
router.get(`${BASE}/cleared/export`, claims, listQuery, exportRoute("cleared"));
router.post(
  `${BASE}/clear`,
  claims,
  validate(billingClaimsClearSchema, BILLING_CLAIMS_LABELS),
  run("CGHS clear", 201, (req) => clearBills(req.body, ctx(req))),
);
router.get(
  `${BASE}/settlements/:id`,
  claims,
  run("CGHS payment read", 200, (req) => readSettlement(req.params.id)),
);
router.post(
  `${BASE}/settlements/:id/undo`,
  claims,
  adminOnly,
  validate(billingClaimsUndoSchema, BILLING_CLAIMS_LABELS),
  run("CGHS undo clear", 200, (req) => undoClear(req.params.id, req.body, ctx(req))),
);

export default router;
