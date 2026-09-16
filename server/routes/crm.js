import express from "express";
import { searchReferringDoctors } from "../crm/registration.js";
import {
  IMPORT_FIELDS,
  parseSheet,
  suggestMapping,
  createBatch,
  previewBatch,
  commitBatch,
} from "../crm/importDoctors.js";
import { crmContext } from "../crm/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = express.Router();

// The doctor picker behind "who referred you?" on the registration forms.
// Search-as-you-type, so it must stay cheap and must never make the front desk
// wait: the query is capped, the result set is capped, and a short query
// returns nothing rather than scanning the universe.
router.get("/crm/registration/referring-doctors", async (req, res) => {
  try {
    const rows = await searchReferringDoctors(req.query.q, Number(req.query.limit) || 8);
    res.json(rows);
  } catch (e) {
    handleError(res, e, "Referring doctor search");
  }
});

// ---- Doctor import wizard (brief §10) ----------------------------------
// Everything below is a CRM operation, so it runs as a CRM user through
// withCrmContext. crmContext() refuses a caller with no crm.users row.
const crm = crmContext();

router.get("/crm/import/fields", crm, (_req, res) => res.json(IMPORT_FIELDS));

// Step 1 — read the file and guess the mapping. Nothing is stored yet.
router.post("/crm/import/parse", crm, express.raw({ type: "*/*", limit: "8mb" }), (req, res) => {
  try {
    const { headers, rows } = parseSheet(req.body, req.query.name || "upload");
    res.json({
      headers,
      suggested_mapping: suggestMapping(headers),
      total_rows: rows.length,
      sample: rows.slice(0, 5),
      // The mapping step only needs a sample; the preview step needs the lot.
      rows: req.query.full ? rows : undefined,
    });
  } catch (e) {
    handleError(res, e, "Import parse");
  }
});

// Step 2 — store the rows with the operator's mapping.
router.post("/crm/import/batches", crm, express.json({ limit: "16mb" }), async (req, res) => {
  try {
    const { file_name, headers, rows, mapping } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows to import" });
    }
    res.json(await createBatch(req.crmUser, { fileName: file_name, headers, rows, mapping }));
  } catch (e) {
    handleError(res, e, "Import batch");
  }
});

// Step 3 — resolve, dedup and flag. Still writes nothing to crm.doctors.
router.get("/crm/import/batches/:id/preview", crm, async (req, res) => {
  try {
    res.json(await previewBatch(req.crmUser, req.params.id));
  } catch (e) {
    handleError(res, e, "Import preview");
  }
});

// Step 4 — the only call that changes the doctor universe.
router.post("/crm/import/batches/:id/commit", crm, express.json(), async (req, res) => {
  try {
    res.json(await commitBatch(req.crmUser, req.params.id, req.body?.skip_rows || []));
  } catch (e) {
    handleError(res, e, "Import commit");
  }
});

export default router;
