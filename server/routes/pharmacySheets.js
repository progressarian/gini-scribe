import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { readSheetUpload, sendSheet } from "../middleware/sheetUpload.js";
import { handleError } from "../utils/errorHandler.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  pharmacySheetDecisionBodySchema,
  pharmacySheetDecisionQuerySchema,
} from "../schemas/index.js";
import { auditContext } from "../services/billing/audit.js";
import { decisionsFrom, publicPreview } from "../services/pharmacy/sheetImport.js";
import {
  applyDarpanMedicines,
  applyMedicineSheet,
  medicineProblemFile,
  medicineSample,
  medicineTemplate,
  previewDarpanMedicines,
  previewMedicineSheet,
} from "../services/pharmacy/medicineSheet.js";
import {
  applyVendorSheet,
  previewVendorSheet,
  vendorProblemFile,
  vendorSample,
  vendorTemplate,
} from "../services/pharmacy/vendorSheet.js";

const router = Router();
const canManage = requireCapability(CAP.PHARMACY_MASTER);

const route = (label, work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (e) {
    handleError(res, e, label);
  }
};

const download = (label, work, fileName) => async (req, res) => {
  try {
    sendSheet(res, await work(req), fileName);
  } catch (e) {
    handleError(res, e, label);
  }
};

function mountSheet({ base, noun, file, template, sample, preview, apply, problems }) {
  router.get(
    `${base}/sheet.xlsx`,
    canManage,
    download(`${noun} sheet`, () => template(), `${file}.xlsx`),
  );
  router.get(
    `${base}/sample.xlsx`,
    canManage,
    download(`${noun} sample`, () => sample(), `${file}-sample.xlsx`),
  );
  router.post(
    `${base}/import/preview`,
    canManage,
    readSheetUpload,
    route(`Check ${noun} sheet`, async (req) => publicPreview(await preview(req.body))),
  );
  router.post(
    `${base}/import/problems.xlsx`,
    canManage,
    readSheetUpload,
    download(`${noun} rows to fix`, (req) => problems(req.body), `${file}-to-fix.xlsx`),
  );
  router.post(
    `${base}/import`,
    canManage,
    validateQuery(pharmacySheetDecisionQuerySchema),
    readSheetUpload,
    route(`Import ${noun} sheet`, (req) =>
      apply(req.body, decisionsFrom(req.query), auditContext(req)),
    ),
  );
}

mountSheet({
  base: "/pharmacy/medicines",
  noun: "medicine",
  file: "pharmacy-medicines",
  template: medicineTemplate,
  sample: medicineSample,
  preview: previewMedicineSheet,
  apply: applyMedicineSheet,
  problems: medicineProblemFile,
});

mountSheet({
  base: "/pharmacy/vendors",
  noun: "vendor",
  file: "pharmacy-vendors",
  template: vendorTemplate,
  sample: vendorSample,
  preview: previewVendorSheet,
  apply: applyVendorSheet,
  problems: vendorProblemFile,
});

router.get(
  "/pharmacy/medicines/import/darpan",
  canManage,
  route("Check DARPAN medicines", async () => publicPreview(await previewDarpanMedicines())),
);

router.post(
  "/pharmacy/medicines/import/darpan",
  canManage,
  validate(pharmacySheetDecisionBodySchema),
  route("Import DARPAN medicines", (req) =>
    applyDarpanMedicines(decisionsFrom(req.body), auditContext(req)),
  ),
);

export default router;
