import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { patientAppUnlinkSchema } from "../schemas/index.js";
import {
  getFamilyForPatient,
  relinkFamilyMember,
  unlinkFamilyMember,
} from "../services/patientAppUnlinks.js";

const router = Router();

const sendError = (res, e, label) =>
  e.status ? res.status(e.status).json({ error: e.message }) : handleError(res, e, label);

router.get("/patient-app-unlinks/family", async (req, res) => {
  try {
    const patientId = parseInt(req.query.patientId, 10);
    if (!Number.isInteger(patientId)) return res.status(400).json({ error: "patientId required" });
    res.json(await getFamilyForPatient(patientId));
  } catch (e) {
    sendError(res, e, "Family on this phone");
  }
});

router.post("/patient-app-unlinks", validate(patientAppUnlinkSchema), async (req, res) => {
  try {
    res.json(await unlinkFamilyMember(req.body, req.doctor?.doctor_id ?? null));
  } catch (e) {
    sendError(res, e, "Remove from app account");
  }
});

router.post("/patient-app-unlinks/:id/relink", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
    res.json(await relinkFamilyMember(id, req.doctor?.doctor_id ?? null));
  } catch (e) {
    sendError(res, e, "Restore to app account");
  }
});

export default router;
