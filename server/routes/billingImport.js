import express, { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  BILLING_FIELD_LABELS,
  BILLING_IMPORT_LABELS,
  billingImportDecisionSchema,
  billingImportFileQuerySchema,
  billingImportHistoryQuerySchema,
  billingImportRowsQuerySchema,
} from "../schemas/index.js";
import { billingRoute, sendFailure } from "./billingHttp.js";
import { auditContext } from "../services/billing/audit.js";
import { listImports } from "../services/billing/importHistory.js";
import { MAX_UPLOAD_BYTES } from "../services/billing/importParse.js";
import * as sessions from "../services/billing/importSessions.js";
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

const ctx = (req) => ({ ...auditContext(req), role: req.doctor.role });

const SESSIONS = `${BASE}/sessions`;

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

router.get(
  `${BASE}/history`,
  master,
  validateQuery(billingImportHistoryQuerySchema, BILLING_FIELD_LABELS),
  billingRoute("Billing import history", 200, (req) => listImports(req.query)),
);

router.post(
  SESSIONS,
  upload,
  billingRoute("Billing import session", 201, (req) =>
    sessions.createSession(req.body, { fileName: req.query.fileName, ctx: ctx(req) }),
  ),
);

router.get(
  `${SESSIONS}/:id`,
  master,
  billingRoute("Billing import session", 200, (req) => sessions.getSession(req.params.id)),
);

router.get(
  `${SESSIONS}/:id/rows`,
  master,
  validateQuery(billingImportRowsQuerySchema, BILLING_IMPORT_LABELS),
  billingRoute("Billing import rows", 200, (req) => sessions.listRows(req.params.id, req.query)),
);

router.post(
  `${SESSIONS}/:id/decisions`,
  master,
  validate(billingImportDecisionSchema, BILLING_IMPORT_LABELS),
  billingRoute("Billing import decision", 200, (req) =>
    sessions.decideRows(req.params.id, req.body, ctx(req)),
  ),
);

router.post(
  `${SESSIONS}/:id/commit`,
  master,
  billingRoute("Billing import commit", 200, (req) =>
    sessions.commitSession(req.params.id, { ctx: ctx(req) }),
  ),
);

router.get(`${SESSIONS}/:id/failed`, master, async (req, res) => {
  try {
    const { file, fileName } = await sessions.failedRowsFile(req.params.id);
    sendXlsx(res, file, fileName);
  } catch (e) {
    sendFailure("Billing import failed rows", res, e);
  }
});

router.post(
  `${SESSIONS}/:id/abandon`,
  master,
  billingRoute("Billing import abandon", 200, (req) =>
    sessions.abandonSession(req.params.id, ctx(req)),
  ),
);

export default router;
