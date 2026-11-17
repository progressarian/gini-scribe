import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  pharmacyLevelLabels,
  pharmacyLevelListQuerySchema,
  pharmacyLevelSchema,
  pharmacyLocationActiveSchema,
  pharmacyLocationLabels,
  pharmacyLocationListQuerySchema,
  pharmacyLocationSchema,
  pharmacyLocationUpdateSchema,
  pharmacyMedicineActiveSchema,
  pharmacySettingsLabels,
  pharmacySettingsSchema,
  pharmacyMedicineLabels,
  pharmacyMedicineListQuerySchema,
  pharmacyMedicineSchema,
  pharmacyMedicineUpdateSchema,
  pharmacyVendorActiveSchema,
  pharmacyVendorLabels,
  pharmacyVendorListQuerySchema,
  pharmacyVendorSchema,
  pharmacyVendorUpdateSchema,
} from "../schemas/index.js";
import { auditContext } from "../services/billing/audit.js";
import * as vendors from "../services/pharmacy/vendors.js";
import * as medicines from "../services/pharmacy/medicines.js";
import * as locations from "../services/pharmacy/locations.js";
import { getPharmacySettings, updatePharmacySettings } from "../services/pharmacy/settings.js";
import { PHARMACY_BILL_SERIES, listSeries, saveSeries } from "../services/billing/billSeries.js";
import pool from "../config/db.js";

const router = Router();
const canManage = requireCapability(CAP.PHARMACY_MASTER);
const ID = /^[1-9][0-9]{0,9}$/;

const route =
  (label, work, status = 200) =>
  async (req, res) => {
    try {
      res.status(status).json(await work(req));
    } catch (e) {
      handleError(res, e, label);
    }
  };

function mount({ base, noun, schemas, labels, service, manage = canManage }) {
  const knownId = (req, res, next) =>
    ID.test(req.params.id) ? next() : res.status(404).json({ error: `${noun} not found` });

  router.get(
    base,
    validateQuery(schemas.list),
    route(`${noun} list`, (req) => service.list(req.query)),
  );
  router.get(
    `${base}/:id`,
    knownId,
    route(noun, (req) => service.get(Number(req.params.id))),
  );
  router.post(
    base,
    manage,
    validate(schemas.create, labels),
    route(`Create ${noun}`, (req) => service.create(req.body, auditContext(req)), 201),
  );
  router.put(
    `${base}/:id`,
    knownId,
    manage,
    validate(schemas.update, labels),
    route(`Update ${noun}`, (req) =>
      service.update(Number(req.params.id), req.body, auditContext(req)),
    ),
  );
  router.patch(
    `${base}/:id/active`,
    knownId,
    manage,
    validate(schemas.active),
    route(`Change ${noun} status`, (req) =>
      service.setActive(Number(req.params.id), req.body.is_active, auditContext(req)),
    ),
  );
}

mount({
  base: "/pharmacy/vendors",
  noun: "Vendor",
  labels: pharmacyVendorLabels,
  schemas: {
    list: pharmacyVendorListQuerySchema,
    create: pharmacyVendorSchema,
    update: pharmacyVendorUpdateSchema,
    active: pharmacyVendorActiveSchema,
  },
  service: {
    list: vendors.listVendors,
    get: vendors.getVendor,
    create: vendors.createVendor,
    update: vendors.updateVendor,
    setActive: vendors.setVendorActive,
  },
});

mount({
  base: "/pharmacy/medicines",
  noun: "Medicine",
  labels: pharmacyMedicineLabels,
  schemas: {
    list: pharmacyMedicineListQuerySchema,
    create: pharmacyMedicineSchema,
    update: pharmacyMedicineUpdateSchema,
    active: pharmacyMedicineActiveSchema,
  },
  service: {
    list: medicines.listMedicines,
    get: medicines.getMedicine,
    create: medicines.createMedicine,
    update: medicines.updateMedicine,
    setActive: medicines.setMedicineActive,
  },
});

const canManageDepartments = requireCapability([CAP.PHARMACY_MASTER, CAP.PHARMACY_DEPT_MANAGE]);

mount({
  base: "/pharmacy/locations",
  noun: "Department",
  labels: pharmacyLocationLabels,
  manage: canManageDepartments,
  schemas: {
    list: pharmacyLocationListQuerySchema,
    create: pharmacyLocationSchema,
    update: pharmacyLocationUpdateSchema,
    active: pharmacyLocationActiveSchema,
  },
  service: {
    list: locations.listLocations,
    get: locations.getLocation,
    create: locations.createLocation,
    update: locations.updateLocation,
    setActive: locations.setLocationActive,
  },
});

const levelIds = (req, res, next) =>
  ID.test(req.params.id) && (!req.params.medicineId || ID.test(req.params.medicineId))
    ? next()
    : res.status(404).json({ error: "Stock level not found" });

router.get(
  "/pharmacy/locations/:id/levels",
  levelIds,
  validateQuery(pharmacyLevelListQuerySchema),
  route("Department stock levels", (req) => locations.listLevels(Number(req.params.id), req.query)),
);

router.put(
  "/pharmacy/locations/:id/levels/:medicineId",
  levelIds,
  canManageDepartments,
  validate(pharmacyLevelSchema, pharmacyLevelLabels),
  route("Save department stock level", (req) =>
    locations.saveLevel(
      Number(req.params.id),
      Number(req.params.medicineId),
      req.body,
      auditContext(req),
    ),
  ),
);

router.delete(
  "/pharmacy/locations/:id/levels/:medicineId",
  levelIds,
  canManageDepartments,
  route("Remove department stock level", (req) =>
    locations.removeLevel(Number(req.params.id), Number(req.params.medicineId), auditContext(req)),
  ),
);

router.get(
  "/pharmacy/settings",
  route("Pharmacy settings", () => getPharmacySettings()),
);

router.put(
  "/pharmacy/settings",
  canManage,
  validate(pharmacySettingsSchema, pharmacySettingsLabels),
  route("Save pharmacy settings", (req) => updatePharmacySettings(req.body, auditContext(req))),
);

router.get(
  "/pharmacy/settings/series",
  route("Pharmacy number series", () => listSeries(pool, undefined, PHARMACY_BILL_SERIES)),
);

router.put(
  "/pharmacy/settings/series",
  canManage,
  route("Save pharmacy number series", (req) =>
    saveSeries(req.body, auditContext(req), pool, PHARMACY_BILL_SERIES),
  ),
);

export default router;
