import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { sendFailure } from "./billingHttp.js";
import { TEMPLATE_FILE_NAME, templateBuffer } from "../services/billing/importTemplate.js";

const router = Router();
const BASE = "/billing/import";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

router.get(`${BASE}/template`, requireCapability(CAP.BILLING_MASTER), async (req, res) => {
  try {
    const file = Buffer.from(await templateBuffer());
    res.set({
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${TEMPLATE_FILE_NAME}"`,
      "Content-Length": file.length,
      "Cache-Control": "no-store",
    });
    res.send(file);
  } catch (e) {
    sendFailure("Billing import template", res, e);
  }
});

export default router;
