import express from "express";
import { validate } from "../middleware/validate.js";
import { prescriptionFooterSchema } from "../schemas/index.js";
import { getPrescriptionFooter, setPrescriptionFooter } from "../services/prescriptionFooter.js";
import {
  getPrescriptionLogo,
  setPrescriptionLogo,
  resetPrescriptionLogo,
} from "../services/prescriptionLogo.js";
import { handleError } from "../utils/errorHandler.js";

const router = express.Router();

// Mounted flat under /api, so these sit at /api/admin/prescription-footer —
// covered by the ["/api/admin", CAP.ADMIN] prefix rule in middleware/auth.js
// rather than a new capability, because editing what every prescription prints
// is exactly the reach ADMIN already describes.
router.get("/admin/prescription-footer", async (_req, res) => {
  try {
    res.json(await getPrescriptionFooter({ fresh: true }));
  } catch (e) {
    handleError(res, e, "Read prescription footer");
  }
});

router.put("/admin/prescription-footer", validate(prescriptionFooterSchema), async (req, res) => {
  try {
    res.json(await setPrescriptionFooter(req.body));
  } catch (e) {
    handleError(res, e, "Update prescription footer");
  }
});

// The letterhead mark. Read separately from the footer text because the payload
// is a data URI measured in tens of kilobytes — the footer form should not carry
// it on every refetch.
router.get("/admin/prescription-logo", async (_req, res) => {
  try {
    res.json(await getPrescriptionLogo({ fresh: true }));
  } catch (e) {
    handleError(res, e, "Read prescription logo");
  }
});

router.put("/admin/prescription-logo", async (req, res) => {
  try {
    res.json(await setPrescriptionLogo(req.body?.dataUri));
  } catch (e) {
    handleError(res, e, "Update prescription logo");
  }
});

router.delete("/admin/prescription-logo", async (_req, res) => {
  try {
    res.json(await resetPrescriptionLogo());
  } catch (e) {
    handleError(res, e, "Reset prescription logo");
  }
});

export default router;
