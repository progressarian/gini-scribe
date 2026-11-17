import express, { Router } from "express";
import { CAPABILITIES as CAP, hasAnyCapability } from "../../shared/permissions.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import {
  pharmacyAdjustmentLabels,
  pharmacyAdjustmentListQuerySchema,
  pharmacyAdjustmentSchema,
  pharmacyBatchMovementsQuerySchema,
  pharmacyMedicineBatchesQuerySchema,
  pharmacyStockLocationQuerySchema,
  pharmacyStockViewQuerySchema,
  pharmacyBatchListQuerySchema,
  pharmacyPurchaseCancelSchema,
  pharmacyPurchaseCreateSchema,
  pharmacyPurchaseLabels,
  pharmacyPurchaseListQuerySchema,
  pharmacyPurchaseUpdateSchema,
  pharmacyPurchaseVersionSchema,
} from "../schemas/index.js";
import { auditContext } from "../services/billing/audit.js";
import {
  cancelPurchase,
  createPurchase,
  getPurchase,
  listPurchases,
  postPurchase,
  updatePurchase,
} from "../services/pharmacy/purchases.js";
import { adjustStock, listAdjustments } from "../services/pharmacy/adjustments.js";
import {
  MAX_RECEIPT_UPLOAD_BYTES,
  importReceiptLines,
  receiptTemplate,
} from "../services/pharmacy/receiptImport.js";
import {
  batchMovements,
  listStock,
  medicineBatches,
  stockLocations,
  stockSummary,
} from "../services/pharmacy/stockView.js";
import { stockList, stockListWorkbook } from "../services/pharmacy/stockList.js";

const router = Router();
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

const knownId = (noun) => (req, res, next) =>
  ID.test(req.params.id) ? next() : res.status(404).json({ error: `${noun} not found` });

const PURCHASES = "/pharmacy/purchases";
const purchaseId = knownId("Goods receipt");

router.get(
  PURCHASES,
  validateQuery(pharmacyPurchaseListQuerySchema),
  route("Goods receipts", (req) => listPurchases(req.query)),
);

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

router.get(`${PURCHASES}/template.xlsx`, async (req, res) => {
  try {
    const file = await receiptTemplate();
    res.setHeader("Content-Type", XLSX);
    res.setHeader("Content-Disposition", 'attachment; filename="pharmacy-stock-template.xlsx"');
    res.send(file);
  } catch (e) {
    handleError(res, e, "Stock template");
  }
});

const rawBody = express.raw({ type: "*/*", limit: MAX_RECEIPT_UPLOAD_BYTES });
const readFile = (req, res, next) =>
  rawBody(req, res, (e) => {
    if (e?.type === "entity.too.large") {
      return res.status(413).json({ error: "The file is larger than 5 MB" });
    }
    if (e) return res.status(400).json({ error: "The file could not be read" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "Attach the filled template .xlsx file" });
    }
    next();
  });

router.post(
  `${PURCHASES}/:id/import`,
  purchaseId,
  validateQuery(pharmacyPurchaseVersionSchema),
  readFile,
  route("Import receipt lines", (req) =>
    importReceiptLines(Number(req.params.id), req.body, req.query, auditContext(req)),
  ),
);

router.get(
  `${PURCHASES}/:id`,
  purchaseId,
  route("Goods receipt", (req) => getPurchase(Number(req.params.id))),
);

router.post(
  PURCHASES,
  validate(pharmacyPurchaseCreateSchema, pharmacyPurchaseLabels),
  route("Start goods receipt", (req) => createPurchase(req.body, auditContext(req)), 201),
);

router.put(
  `${PURCHASES}/:id`,
  purchaseId,
  validate(pharmacyPurchaseUpdateSchema, pharmacyPurchaseLabels),
  route("Save goods receipt", (req) =>
    updatePurchase(Number(req.params.id), req.body, auditContext(req)),
  ),
);

router.post(
  `${PURCHASES}/:id/post`,
  purchaseId,
  validate(pharmacyPurchaseVersionSchema),
  route("Post goods receipt", (req) =>
    postPurchase(Number(req.params.id), req.body, auditContext(req)),
  ),
);

router.post(
  `${PURCHASES}/:id/cancel`,
  purchaseId,
  validate(pharmacyPurchaseCancelSchema),
  route("Cancel goods receipt", (req) =>
    cancelPurchase(Number(req.params.id), req.body, auditContext(req)),
  ),
);

const BATCHES = "/pharmacy/batches";
const withCost = (req) =>
  hasAnyCapability(req.doctor, [CAP.PHARMACY_PURCHASE, CAP.PHARMACY_MASTER]);

router.get(
  `${BATCHES}/locations`,
  route("Stock locations", () => stockLocations()),
);

router.get(
  `${BATCHES}/stock`,
  validateQuery(pharmacyStockViewQuerySchema),
  route("Batch stock", (req) => listStock({ ...req.query, withCost: withCost(req) })),
);

router.get(
  `${BATCHES}/list`,
  validateQuery(pharmacyBatchListQuerySchema),
  route("Stock list", (req) => stockList(req.query, { withCost: withCost(req) })),
);

router.get(
  `${BATCHES}/list.xlsx`,
  validateQuery(pharmacyBatchListQuerySchema),
  async (req, res) => {
    try {
      const file = await stockListWorkbook(req.query, { withCost: withCost(req) });
      res.setHeader("Content-Type", XLSX);
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      res.send(file.buffer);
    } catch (e) {
      handleError(res, e, "Stock list export");
    }
  },
);

router.get(
  `${BATCHES}/summary`,
  validateQuery(pharmacyStockLocationQuerySchema),
  route("Batch stock summary", (req) => stockSummary({ ...req.query, withCost: withCost(req) })),
);

router.get(
  BATCHES,
  validateQuery(pharmacyMedicineBatchesQuerySchema),
  route("Medicine batches", (req) => medicineBatches({ ...req.query, withCost: withCost(req) })),
);

router.get(
  `${BATCHES}/:id/movements`,
  knownId("Batch"),
  validateQuery(pharmacyBatchMovementsQuerySchema),
  route("Batch history", (req) =>
    batchMovements({ ...req.query, batch_id: Number(req.params.id) }),
  ),
);

router.get(
  "/pharmacy/adjustments",
  validateQuery(pharmacyAdjustmentListQuerySchema),
  route("Stock adjustments", (req) => listAdjustments(req.query)),
);

router.post(
  "/pharmacy/adjustments",
  validate(pharmacyAdjustmentSchema, pharmacyAdjustmentLabels),
  route("Adjust stock", (req) => adjustStock(req.body, auditContext(req)), 201),
);

export default router;
