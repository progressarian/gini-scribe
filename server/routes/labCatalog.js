import express from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  labAddFieldSchema,
  labFormulaFromTextSchema,
  labCreateReportSchema,
  labLinkReportSchema,
  labMoveFieldSchema,
  labRemoveFieldSchema,
  labRangesSchema,
  labReportSearchSchema,
  labResultsAsFileSchema,
  labUnlinkReportSchema,
  labUpdateFieldSchema,
} from "../schemas/index.js";
import { formulaFromText } from "../services/labCatalog/formulaFromText.js";
import { readHistory, readTest } from "../services/labCatalog/read.js";
import {
  addField,
  createAndLinkReport,
  linkReport,
  moveField,
  removeField,
  replaceRanges,
  searchReports,
  setResultsAsFile,
  unlinkReport,
  updateField,
} from "../services/labCatalog/write.js";

const router = express.Router();
const gate = requireCapability([CAP.ADMIN, CAP.LAB_TEST_CATALOG]);
const actor = (req) => req.doctor?.doctor_id ?? null;

const route = (label, work) => async (req, res) => {
  try {
    res.json(await work(req));
  } catch (e) {
    handleError(res, e, label);
  }
};

const ID = "([0-9]+)";

router.get(
  "/lab-catalog/reports",
  gate,
  validateQuery(labReportSearchSchema),
  route("Lab catalogue report search", (req) => searchReports(req.query.q)),
);

router.get(
  "/lab-catalog/tests/:catalogId",
  gate,
  route("Lab catalogue test", (req) => readTest(req.params.catalogId)),
);

router.get(
  "/lab-catalog/tests/:catalogId/history",
  gate,
  route("Lab catalogue history", (req) => readHistory(req.params.catalogId)),
);

router.put(
  "/lab-catalog/tests/:catalogId/report",
  gate,
  validate(labLinkReportSchema),
  route("Lab catalogue link report", (req) =>
    linkReport(req.params.catalogId, req.body, actor(req)),
  ),
);

router.delete(
  "/lab-catalog/tests/:catalogId/report",
  gate,
  validate(labUnlinkReportSchema),
  route("Lab catalogue unlink report", (req) =>
    unlinkReport(req.params.catalogId, req.body, actor(req)),
  ),
);

router.post(
  "/lab-catalog/tests/:catalogId/report",
  gate,
  validate(labCreateReportSchema),
  route("Lab catalogue create report", (req) =>
    createAndLinkReport(req.params.catalogId, req.body, actor(req)),
  ),
);

router.put(
  "/lab-catalog/tests/:catalogId/results-as-file",
  gate,
  validate(labResultsAsFileSchema),
  route("Lab catalogue file-only", (req) =>
    setResultsAsFile(req.params.catalogId, req.body, actor(req)),
  ),
);

router.post(
  `/lab-catalog/reports/:reportId${ID}/fields`,
  gate,
  validate(labAddFieldSchema),
  route("Lab catalogue add field", (req) => addField(req.params.reportId, req.body, actor(req))),
);

router.post(
  `/lab-catalog/reports/:reportId${ID}/formula-from-text`,
  gate,
  validate(labFormulaFromTextSchema),
  route("Lab catalogue formula from text", (req) => formulaFromText(req.params.reportId, req.body)),
);

router.put(
  `/lab-catalog/reports/:reportId${ID}/order`,
  gate,
  validate(labMoveFieldSchema),
  route("Lab catalogue field order", (req) => moveField(req.params.reportId, req.body, actor(req))),
);

router.delete(
  `/lab-catalog/reports/:reportId${ID}/fields/:fieldId${ID}`,
  gate,
  validate(labRemoveFieldSchema),
  route("Lab catalogue remove field", (req) =>
    removeField(req.params.reportId, req.params.fieldId, req.body, actor(req)),
  ),
);

router.patch(
  `/lab-catalog/fields/:fieldId${ID}`,
  gate,
  validate(labUpdateFieldSchema),
  route("Lab catalogue update field", (req) =>
    updateField(req.params.fieldId, req.body, actor(req)),
  ),
);

router.put(
  `/lab-catalog/fields/:fieldId${ID}/ranges`,
  gate,
  validate(labRangesSchema),
  route("Lab catalogue ranges", (req) => replaceRanges(req.params.fieldId, req.body, actor(req))),
);

export default router;
