import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  BILLING_PRICING_LABELS,
  billingPreviewSchema,
  billingRuleTestSchema,
} from "../schemas/index.js";
import { billingRoute } from "./billingHttp.js";
import { priceBill } from "../services/billing/priceBill.js";

const router = Router();
const BASE = "/billing";

const pricedLines = (lines) =>
  lines.map((line) => ({
    item: line.item_id,
    quantity: line.quantity,
    visitType: line.visit_type,
    doctorId: line.doctor_id,
  }));

const pricing = (req) => ({
  lines: pricedLines(req.body.lines),
  category: req.body.category,
  date: req.body.date,
  visitType: req.body.visit_type,
  doctorId: req.body.doctor_id,
  codes: req.body.codes,
  role: req.doctor.role,
});

router.post(
  `${BASE}/preview`,
  requireCapability(CAP.BILLING_DESK),
  validate(billingPreviewSchema, BILLING_PRICING_LABELS),
  billingRoute("Billing preview", 200, (req) =>
    priceBill({
      ...pricing(req),
      patientId: req.body.patient_id,
      appointmentId: req.body.appointment_id,
    }),
  ),
);

router.post(
  `${BASE}/master/test-rule`,
  requireCapability(CAP.BILLING_MASTER),
  validate(billingRuleTestSchema, BILLING_PRICING_LABELS),
  billingRoute("Billing rule test", 200, (req) =>
    priceBill({
      ...pricing(req),
      role: req.body.role ?? req.doctor.role,
      patient: { age: req.body.age ?? null, gender: req.body.gender ?? null },
    }),
  ),
);

export default router;
