import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  pharmacyVendorActiveSchema,
  pharmacyVendorLabels,
  pharmacyVendorListQuerySchema,
  pharmacyVendorSchema,
  pharmacyVendorUpdateSchema,
} from "../schemas/index.js";
import { auditContext } from "../services/billing/audit.js";
import {
  createVendor,
  getVendor,
  listVendors,
  setVendorActive,
  updateVendor,
} from "../services/pharmacy/vendors.js";

const router = Router();
const BASE = "/pharmacy/vendors";

router.param("id", (req, res, next, id) =>
  /^[1-9][0-9]{0,9}$/.test(id) ? next() : res.status(404).json({ error: "Vendor not found" }),
);

const canManage = requireCapability(CAP.PHARMACY_MASTER);

const route =
  (label, work, status = 200) =>
  async (req, res) => {
    try {
      res.status(status).json(await work(req));
    } catch (e) {
      handleError(res, e, label);
    }
  };

router.get(
  BASE,
  validateQuery(pharmacyVendorListQuerySchema),
  route("Pharmacy vendor list", (req) => listVendors(req.query)),
);

router.get(
  `${BASE}/:id`,
  route("Pharmacy vendor", (req) => getVendor(Number(req.params.id))),
);

router.post(
  BASE,
  canManage,
  validate(pharmacyVendorSchema, pharmacyVendorLabels),
  route("Create pharmacy vendor", (req) => createVendor(req.body, auditContext(req)), 201),
);

router.put(
  `${BASE}/:id`,
  canManage,
  validate(pharmacyVendorUpdateSchema, pharmacyVendorLabels),
  route("Update pharmacy vendor", (req) =>
    updateVendor(Number(req.params.id), req.body, auditContext(req)),
  ),
);

router.patch(
  `${BASE}/:id/active`,
  canManage,
  validate(pharmacyVendorActiveSchema),
  route("Change pharmacy vendor status", (req) =>
    setVendorActive(Number(req.params.id), req.body.is_active, auditContext(req)),
  ),
);

export default router;
