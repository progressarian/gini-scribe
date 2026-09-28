import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { BILLING_DUES_LABELS, billingDuesRegisterQuerySchema } from "../schemas/index.js";
import { billingRoute as run, sendFailure } from "./billingHttp.js";
import { exportDues, listDuesRegister } from "../services/billing/dues.js";

const router = Router();
const BASE = "/billing/dues-register";
const dues = requireCapability(CAP.BILLING_DUES);
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const query = validateQuery(billingDuesRegisterQuerySchema, BILLING_DUES_LABELS);

router.get(
  `${BASE}`,
  dues,
  query,
  run("Dues register", 200, (req) => listDuesRegister(req.query)),
);

router.get(`${BASE}/export`, dues, query, async (req, res) => {
  try {
    const made = await exportDues(req.query);
    res.set({
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${made.fileName}"`,
      "Content-Length": made.buffer.length,
      "Cache-Control": "no-store",
      "X-Dues-Count": String(made.totals.bills),
      "X-Dues-Amount": String(made.totals.outstanding),
    });
    res.send(made.buffer);
  } catch (e) {
    sendFailure("Dues export", res, e);
  }
});

export default router;
