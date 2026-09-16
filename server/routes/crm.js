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
import {
  createReferral,
  advanceReferral,
  openReferrals,
  referralDetail,
  serviceLines,
} from "../crm/referrals.js";
import { logVisit, fillDoctorGap, repHome, suggestedNextVisit, doctor360 } from "../crm/visits.js";
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

// ---- Rep home and visit logging (brief §5, §13) -------------------------
router.get("/crm/home", crm, async (req, res) => {
  try {
    res.json(await repHome(req.crmUser));
  } catch (e) {
    handleError(res, e, "Rep home");
  }
});

// ---- Referral capture and the patient journey (brief §6, §7) ------------
router.get("/crm/service-lines", crm, async (req, res) => {
  try {
    res.json(await serviceLines(req.crmUser));
  } catch (e) {
    handleError(res, e, "Service lines");
  }
});

router.get("/crm/referrals", crm, async (req, res) => {
  try {
    res.json(await openReferrals(req.crmUser, { limit: req.query.limit }));
  } catch (e) {
    handleError(res, e, "Open referrals");
  }
});

router.post("/crm/referrals", crm, express.json(), async (req, res) => {
  try {
    res.json(await createReferral(req.crmUser, req.body));
  } catch (e) {
    handleError(res, e, "Log referral");
  }
});

router.get("/crm/referrals/:id", crm, async (req, res) => {
  try {
    res.json(await referralDetail(req.crmUser, req.params.id));
  } catch (e) {
    handleError(res, e, "Referral");
  }
});

// The journey control. `lost` without a reason is refused by the database, not
// just by this handler.
router.post("/crm/referrals/:id/status", crm, express.json(), async (req, res) => {
  try {
    res.json(await advanceReferral(req.crmUser, req.params.id, req.body));
  } catch (e) {
    handleError(res, e, "Advance referral");
  }
});

router.get("/crm/doctors/:id", crm, async (req, res) => {
  try {
    res.json(await doctor360(req.crmUser, req.params.id));
  } catch (e) {
    handleError(res, e, "Doctor 360");
  }
});

router.get("/crm/doctors/:id/next-visit", crm, async (req, res) => {
  try {
    res.json((await suggestedNextVisit(req.crmUser, req.params.id)) || {});
  } catch (e) {
    handleError(res, e, "Cadence lookup");
  }
});

// Idempotent on the client-generated id, which is what lets the offline queue
// retry without thinking. A replay returns 200 with duplicate:true rather than
// a conflict, so a queue draining after a flaky send does not see an error and
// keep the item forever.
router.post("/crm/visits", crm, express.json({ limit: "1mb" }), async (req, res) => {
  try {
    res.json(await logVisit(req.crmUser, req.body));
  } catch (e) {
    handleError(res, e, "Log visit");
  }
});

// Bulk A/B/C. Separate from PATCH /crm/doctors/:id because it is a different
// action with a different blast radius — one doctor versus a whole territory.
router.post("/crm/doctors/priority", crm, express.json(), async (req, res) => {
  try {
    res.json(await setPriority(req.crmUser, req.body));
  } catch (e) {
    handleError(res, e, "Set priority");
  }
});

router.patch("/crm/doctors/:id", crm, express.json(), async (req, res) => {
  try {
    res.json(await fillDoctorGap(req.crmUser, req.params.id, req.body));
  } catch (e) {
    handleError(res, e, "Update doctor");
  }
});

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
