import express, { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import { CAPABILITIES as CAP, hasCapability } from "../../shared/permissions.js";
import {
  pharmacyStockFileQuerySchema,
  pharmacyStockHistoryQuerySchema,
  pharmacyStockLinkSchema,
  pharmacyStockListQuerySchema,
  pharmacyNeededClearSchema,
  pharmacyNeededOrderSchema,
} from "../schemas/index.js";
import { MAX_STOCK_UPLOAD_BYTES } from "../services/pharmacy/stockParse.js";
import {
  commitUpload,
  createPreview,
  discardUpload,
  getUpload,
  listUploads,
} from "../services/pharmacy/stockUpload.js";
import { listStock, stockSummary } from "../services/pharmacy/stockQuery.js";
import { addLink, getItemLinks, removeLink } from "../services/pharmacy/stockLinks.js";
import { clearOrdered, listNeeded, markOrdered } from "../services/pharmacy/stockNeeded.js";

const router = Router();
const BASE = "/pharmacy/stock";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.param("id", (req, res, next, id) =>
  UUID.test(id) ? next() : res.status(404).json({ error: "Upload not found" }),
);

const canView = requireCapability(CAP.PHARMACY_STOCK_VIEW);
const canUpload = requireCapability(CAP.PHARMACY_STOCK_UPLOAD);
const withRates = (req) => hasCapability(req.doctor?.role, CAP.PHARMACY_STOCK_UPLOAD);
const actorOf = (req) => req.doctor?.doctor_id ?? null;

const rawBody = express.raw({ type: "*/*", limit: MAX_STOCK_UPLOAD_BYTES });

const readFile = (req, res, next) =>
  rawBody(req, res, (e) => {
    if (e?.type === "entity.too.large") {
      return res.status(413).json({
        error: `The file is larger than ${MAX_STOCK_UPLOAD_BYTES / 1024 / 1024} MB`,
      });
    }
    if (e) return res.status(400).json({ error: "The file could not be read" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "Attach the stock report .xlsx file" });
    }
    next();
  });

const route = (label, work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (e) {
    handleError(res, e, label);
  }
};

router.get(
  BASE,
  canView,
  validateQuery(pharmacyStockListQuerySchema),
  route("Pharmacy stock list", (req) => listStock({ ...req.query, withRates: withRates(req) })),
);

router.get(
  `${BASE}/summary`,
  canView,
  route("Pharmacy stock summary", (req) => stockSummary({ withRates: withRates(req) })),
);

router.get(
  `${BASE}/uploads`,
  canUpload,
  validateQuery(pharmacyStockHistoryQuerySchema),
  route("Pharmacy stock uploads", (req) => listUploads(req.query)),
);

router.post(
  `${BASE}/uploads`,
  canUpload,
  validateQuery(pharmacyStockFileQuerySchema),
  readFile,
  route("Pharmacy stock upload", (req) =>
    createPreview(req.body, { fileName: req.query.fileName, actorId: actorOf(req) }),
  ),
);

router.get(
  `${BASE}/uploads/:id`,
  canUpload,
  route("Pharmacy stock upload", (req) => getUpload(req.params.id)),
);

router.post(
  `${BASE}/uploads/:id/commit`,
  canUpload,
  route("Pharmacy stock apply", (req) => commitUpload(req.params.id, actorOf(req))),
);

router.post(
  `${BASE}/uploads/:id/discard`,
  canUpload,
  route("Pharmacy stock discard", (req) => discardUpload(req.params.id)),
);

router.get(
  `${BASE}/items/:itemKey/links`,
  canUpload,
  route("Pharmacy stock links", (req) => getItemLinks(req.params.itemKey)),
);

router.post(
  `${BASE}/items/:itemKey/links`,
  canUpload,
  validate(pharmacyStockLinkSchema),
  route("Pharmacy stock link", (req) =>
    addLink(req.params.itemKey, req.body.medicineName, actorOf(req)),
  ),
);

router.delete(
  `${BASE}/items/:itemKey/links/:medicineKey`,
  canUpload,
  route("Pharmacy stock unlink", (req) => removeLink(req.params.itemKey, req.params.medicineKey)),
);

router.get(
  `${BASE}/needed`,
  canView,
  route("Medicines needed in stock", () => listNeeded()),
);

router.post(
  `${BASE}/needed/ordered`,
  canUpload,
  validate(pharmacyNeededOrderSchema),
  route("Mark a needed medicine ordered", (req) => markOrdered(req.body, actorOf(req))),
);

router.post(
  `${BASE}/needed/ordered/clear`,
  canUpload,
  validate(pharmacyNeededClearSchema),
  route("Clear a needed medicine's order mark", (req) => clearOrdered(req.body.medicineKey)),
);

export default router;
