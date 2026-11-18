import { Router } from "express";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import { auditContext } from "../services/billing/audit.js";
import { signalPharmacy } from "../services/pharmacy/live.js";
import {
  listPrescriptionQueue,
  prescriptionPatient,
  requestFromPrescription,
  saveOutcomes,
} from "../services/pharmacy/prescriptionQueue.js";
import {
  pharmacyRxLabels,
  pharmacyRxOutcomesSchema,
  pharmacyRxPatientQuerySchema,
  pharmacyRxQueueQuerySchema,
  pharmacyRxRequestSchema,
} from "../schemas/pharmacyBills.js";

const router = Router();
const BASE = "/pharmacy/prescriptions";
const knownPatient = (req, res, next) =>
  /^[1-9][0-9]{0,9}$/.test(req.params.patientId)
    ? next()
    : res.status(404).json({ error: "Patient not found" });

const route =
  (label, work, status = 200) =>
  async (req, res) => {
    try {
      res.status(status).json(await work(req));
    } catch (e) {
      handleError(res, e, label);
    }
  };

router.get(
  BASE,
  validateQuery(pharmacyRxQueueQuerySchema, pharmacyRxLabels),
  route("Prescriptions to bill", (req) => listPrescriptionQueue(req.query)),
);

router.get(
  `${BASE}/patients/:patientId`,
  knownPatient,
  validateQuery(pharmacyRxPatientQuerySchema, pharmacyRxLabels),
  route("Prescription to bill", (req) =>
    prescriptionPatient(Number(req.params.patientId), req.query),
  ),
);

router.post(
  `${BASE}/patients/:patientId/outcomes`,
  knownPatient,
  validate(pharmacyRxOutcomesSchema, pharmacyRxLabels),
  route("Prescription decisions", async (req) => {
    const saved = await saveOutcomes(Number(req.params.patientId), req.body, auditContext(req));
    signalPharmacy("bill", saved.bill_id);
    return saved;
  }),
);

router.post(
  `${BASE}/patients/:patientId/requests`,
  knownPatient,
  validate(pharmacyRxRequestSchema, pharmacyRxLabels),
  route(
    "Request a medicine",
    (req) => requestFromPrescription(Number(req.params.patientId), req.body, auditContext(req)),
    201,
  ),
);

export default router;
