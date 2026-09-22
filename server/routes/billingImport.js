import express, { Router } from "express";
import pool from "../config/db.js";
import { requireCapability } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP, hasCapability } from "../../shared/permissions.js";
import {
  BILLING_FIELD_LABELS,
  billingImportFileQuerySchema,
  billingImportHistoryQuerySchema,
} from "../schemas/index.js";
import { billingRoute, sendFailure } from "./billingHttp.js";
import { auditContext } from "../services/billing/audit.js";
import { commitUpload } from "../services/billing/importCommit.js";
import { errorFile, errorFileName } from "../services/billing/importErrorFile.js";
import { listImports } from "../services/billing/importHistory.js";
import { MAX_UPLOAD_BYTES } from "../services/billing/importParse.js";
import { previewUpload } from "../services/billing/importPreview.js";
import { TEMPLATE_FILE_NAME, templateBuffer } from "../services/billing/importTemplate.js";

const router = Router();
const BASE = "/billing/import";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const master = requireCapability(CAP.BILLING_MASTER);
const rawBody = express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES });

const readFile = (req, res, next) =>
  rawBody(req, res, (e) => {
    if (e?.type === "entity.too.large") {
      return res.status(413).json({
        error: `The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB; split it into smaller files`,
      });
    }
    if (e) return res.status(400).json({ error: "The file could not be read" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res
        .status(400)
        .json({ error: "Attach the filled-in .xlsx file as the body of the request" });
    }
    next();
  });

const upload = [
  master,
  validateQuery(billingImportFileQuerySchema, BILLING_FIELD_LABELS),
  readFile,
];

const options = (req) => ({ canChangeDailyCap: hasCapability(req.doctor?.role, CAP.ADMIN) });

const disposition = (fileName) => {
  const plain = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return plain === fileName
    ? `attachment; filename="${fileName}"`
    : `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

const sendXlsx = (res, file, fileName) => {
  res.set({
    "Content-Type": XLSX_TYPE,
    "Content-Disposition": disposition(fileName),
    "Content-Length": file.length,
    "Cache-Control": "no-store",
  });
  res.send(file);
};

router.get(`${BASE}/template`, master, async (req, res) => {
  try {
    sendXlsx(res, Buffer.from(await templateBuffer()), TEMPLATE_FILE_NAME);
  } catch (e) {
    sendFailure("Billing import template", res, e);
  }
});

router.post(
  `${BASE}/preview`,
  upload,
  billingRoute("Billing import preview", 200, (req) => previewUpload(req.body, pool, options(req))),
);

router.post(
  `${BASE}/commit`,
  upload,
  billingRoute("Billing import", 200, (req) =>
    commitUpload(req.body, {
      fileName: req.query.fileName,
      ctx: auditContext(req),
      options: options(req),
    }),
  ),
);

router.post(`${BASE}/errors`, upload, async (req, res) => {
  try {
    const preview = await previewUpload(req.body, pool, options(req));
    const file = await errorFile(req.body, preview);
    if (!file) {
      return res.status(422).json({
        error: preview.problems.length
          ? "The file can't be checked row by row, so there is no error file — fix the problems listed first"
          : "No row in this file has an error, so there is no error file",
        problems: preview.problems,
      });
    }
    sendXlsx(res, file, errorFileName(req.query.fileName));
  } catch (e) {
    sendFailure("Billing import error file", res, e);
  }
});

router.get(
  `${BASE}/history`,
  master,
  validateQuery(billingImportHistoryQuerySchema, BILLING_FIELD_LABELS),
  billingRoute("Billing import history", 200, (req) => listImports(req.query)),
);

export default router;
