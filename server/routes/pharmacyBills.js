import { Router } from "express";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import {
  pharmacyBillCreateSchema,
  pharmacyBillFinaliseSchema,
  pharmacyBillLabels,
  pharmacyBillListQuerySchema,
  pharmacyBillPatientQuerySchema,
  pharmacyBillUpdateSchema,
  pharmacyBillVersionSchema,
  pharmacySaleReturnSchema,
  pharmacyWalkinSchema,
} from "../schemas/index.js";
import { auditContext } from "../services/billing/audit.js";
import { createWalkinPatient, searchBillPatients } from "../services/pharmacy/billPatients.js";
import { generatePharmacyBillPdf } from "../services/pharmacy/billPdf.js";
import { billPrescription } from "../services/pharmacy/billPrescription.js";
import { billReturns, createSaleReturn } from "../services/pharmacy/saleReturns.js";
import {
  createBill,
  discardBill,
  finaliseBill,
  getBill,
  listBills,
  updateBill,
} from "../services/pharmacy/bills.js";

const router = Router();
const BILLS = "/pharmacy/bills";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const route =
  (label, work, status = 200) =>
  async (req, res) => {
    try {
      res.status(status).json(await work(req));
    } catch (e) {
      handleError(res, e, label);
    }
  };

const billId = (req, res, next) =>
  UUID.test(req.params.id) ? next() : res.status(404).json({ error: "Pharmacy bill not found" });

router.get(
  `${BILLS}/patients`,
  validateQuery(pharmacyBillPatientQuerySchema, pharmacyBillLabels),
  route("Pharmacy patient search", (req) => searchBillPatients(req.query)),
);

router.post(
  `${BILLS}/patients`,
  validate(pharmacyWalkinSchema, pharmacyBillLabels),
  route("Walk-in patient", async (req) => createWalkinPatient(req.body, auditContext(req))),
);

router.get(
  BILLS,
  validateQuery(pharmacyBillListQuerySchema),
  route("Pharmacy bills", (req) => listBills(req.query)),
);

router.get(
  `${BILLS}/:id`,
  billId,
  route("Pharmacy bill", (req) => getBill(req.params.id)),
);

router.get(
  `${BILLS}/:id/prescription`,
  billId,
  route("Prescription for pharmacy bill", (req) => billPrescription(req.params.id)),
);

router.get(`${BILLS}/:id/bill.pdf`, billId, async (req, res) => {
  try {
    const made = await generatePharmacyBillPdf(req.params.id);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="${made.filename}"`);
    res.set("Content-Length", String(made.pdf.length));
    res.send(made.pdf);
  } catch (e) {
    handleError(res, e, "Pharmacy bill PDF");
  }
});

router.post(
  BILLS,
  validate(pharmacyBillCreateSchema, pharmacyBillLabels),
  route("Start pharmacy bill", (req) => createBill(req.body, auditContext(req)), 201),
);

router.put(
  `${BILLS}/:id`,
  billId,
  validate(pharmacyBillUpdateSchema, pharmacyBillLabels),
  route("Save pharmacy bill", (req) => updateBill(req.params.id, req.body, auditContext(req))),
);

router.post(
  `${BILLS}/:id/finalise`,
  billId,
  validate(pharmacyBillFinaliseSchema, pharmacyBillLabels),
  route("Finalise pharmacy bill", (req) =>
    finaliseBill(req.params.id, req.body, {
      ...auditContext(req),
      actorName: req.doctor?.doctor_name ?? null,
    }),
  ),
);

router.get(
  `${BILLS}/:id/returns`,
  billId,
  route("Pharmacy bill returns", (req) => billReturns(req.params.id)),
);

router.post(
  `${BILLS}/:id/returns`,
  billId,
  validate(pharmacySaleReturnSchema, {
    ...pharmacyBillLabels,
    reason: "Reason",
    lines: "Medicines",
  }),
  route(
    "Pharmacy sale return",
    (req) => createSaleReturn(req.params.id, req.body, auditContext(req)),
    201,
  ),
);

router.post(
  `${BILLS}/:id/discard`,
  billId,
  validate(pharmacyBillVersionSchema),
  route("Discard pharmacy bill", (req) => discardBill(req.params.id, req.body, auditContext(req))),
);

export default router;
