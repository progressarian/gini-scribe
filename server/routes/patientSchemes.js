import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { listSchemes, createScheme, updateScheme } from "../services/patientSchemes.js";

const router = Router();

// Reading the vocabulary is not a privileged act — every screen that renders a
// scheme pill needs it, and the list is the same list the GHM sheet has shown
// for months. Writing it is admin-only (33-PATIENT-SCHEME-PLAN.md §6): a
// receptionist who can raise the ECHS cap has defeated the cap.
router.get("/patient-schemes", async (req, res) => {
  try {
    const all = ["1", "true", "yes"].includes(String(req.query.all || "").toLowerCase());
    res.json(await listSchemes({ all }));
  } catch (e) {
    handleError(res, e, "Patient schemes list");
  }
});

router.post("/patient-schemes", requireCapability(CAP.SCHEME_ADMIN), async (req, res) => {
  try {
    res.status(201).json(await createScheme(req.body || {}));
  } catch (e) {
    handleError(res, e, "Patient scheme create");
  }
});

router.patch("/patient-schemes/:code", requireCapability(CAP.SCHEME_ADMIN), async (req, res) => {
  try {
    res.json(await updateScheme(req.params.code, req.body || {}));
  } catch (e) {
    handleError(res, e, "Patient scheme update");
  }
});

export default router;
