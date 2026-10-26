import express from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { newPatientWorkupQuerySchema, newPatientWorkupSaveSchema } from "../schemas/index.js";
import { getWorkup, saveWorkup } from "../services/visit/newPatientWorkup.js";

const router = express.Router();

const route = (label, work) => async (req, res) => {
  try {
    const patientId = Number(req.params.patientId);
    if (!Number.isInteger(patientId) || patientId <= 0)
      return res.status(400).json({ error: "Invalid patient ID" });
    res.json(await work(req, patientId));
  } catch (e) {
    handleError(res, e, label);
  }
};

router.get(
  "/visit/:patientId/workup",
  requireCapability(CAP.PATIENT_CHART),
  validateQuery(newPatientWorkupQuerySchema),
  route("Load workup", (req, pid) => getWorkup(pid, req.query.appointment_id)),
);

router.put(
  "/visit/:patientId/workup",
  requireCapability(CAP.CLINICAL_WRITE),
  validate(newPatientWorkupSaveSchema),
  route("Save workup", (req, pid) => saveWorkup(pid, req.body, req.doctor?.doctor_id ?? null)),
);

export default router;
