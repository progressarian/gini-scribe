import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  BILLING_DESK_LABELS,
  BILLING_PRICING_LABELS,
  billingCancelSchema,
  billingCategorySetSchema,
  billingCodeAddSchema,
  billingDraftOpenSchema,
  billingDuesQuerySchema,
  billingFinaliseSchema,
  billingItemSearchQuerySchema,
  billingLineAddSchema,
  billingLineQuantitySchema,
  billingLineRemoveSchema,
  billingMyShiftsQuerySchema,
  billingNewItemRequestSchema,
  billingPaymentsTakeSchema,
  billingPreviewSchema,
  billingReceiptQuerySchema,
  billingRepeatRequestSchema,
  billingRequestApproveSchema,
  billingRequestListQuerySchema,
  billingRequestRejectSchema,
  billingRuleTestSchema,
  billingShiftCloseSchema,
  billingShiftListQuerySchema,
  billingShiftOpenSchema,
} from "../schemas/index.js";
import { billingRoute, sendFailure } from "./billingHttp.js";
import { auditContext } from "../services/billing/audit.js";
import { priceBill } from "../services/billing/priceBill.js";
import { generateBillPdf } from "../services/billing/billPdf.js";
import { generateReceiptPdf } from "../services/billing/receiptPdf.js";
import * as bills from "../services/billing/bills.js";
import * as payments from "../services/billing/payments.js";
import * as shifts from "../services/billing/cashShifts.js";
import * as requests from "../services/billing/billingRequests.js";
import { notPricedForVisit } from "../services/billing/visitLines.js";
import { deskSettings } from "../services/billing/billingSettings.js";
import { searchDeskItems } from "../services/billing/serviceItems.js";

const router = Router();
const BASE = "/billing";
const desk = requireCapability(CAP.BILLING_DESK);
const master = requireCapability(CAP.BILLING_MASTER);

const run = billingRoute;

const ctx = (req) => ({ ...auditContext(req), role: req.doctor?.role ?? null });

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

const shiftFilters = (req) => ({
  from: req.query.from,
  to: req.query.to,
  status: req.query.status,
  limit: req.query.limit,
});

const requestFilters = (req) => ({
  status: req.query.status,
  kind: req.query.kind,
  visitId: req.query.visit_id,
  limit: req.query.limit,
});

const pdfRoute = (context, make) =>
  async function send(req, res) {
    try {
      const made = await make(req);
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `inline; filename="${made.filename}"`);
      res.set("Content-Length", String(made.pdf.length));
      return res.send(made.pdf);
    } catch (e) {
      return sendFailure(context, res, e);
    }
  };

router.post(
  `${BASE}/preview`,
  desk,
  validate(billingPreviewSchema, BILLING_PRICING_LABELS),
  run("Billing preview", 200, (req) =>
    priceBill({
      ...pricing(req),
      patientId: req.body.patient_id,
      appointmentId: req.body.appointment_id,
    }),
  ),
);

router.get(
  `${BASE}/desk-settings`,
  desk,
  run("Desk billing settings", 200, () => deskSettings()),
);

router.get(
  `${BASE}/items/search`,
  desk,
  validateQuery(billingItemSearchQuerySchema, BILLING_DESK_LABELS),
  run("Item search", 200, (req) => searchDeskItems({ q: req.query.q, limit: req.query.limit })),
);

router.get(
  `${BASE}/visits/:visitId/bills`,
  desk,
  run("Visit bills", 200, (req) => bills.listVisitBills(req.params.visitId)),
);

router.post(
  `${BASE}/visits/:visitId/bills`,
  desk,
  validate(billingDraftOpenSchema, BILLING_DESK_LABELS),
  run("Open draft bill", 200, (req) => bills.openDraft(req.params.visitId, ctx(req))),
);

router.get(
  `${BASE}/visits/:visitId/not-priced`,
  desk,
  run("Tests without a price", 200, (req) => notPricedForVisit(req.params.visitId)),
);

router.get(
  `${BASE}/bills/:billId`,
  desk,
  run("Read bill", 200, (req) => bills.readBill(req.params.billId)),
);

router.post(
  `${BASE}/bills/:billId/lines`,
  desk,
  validate(billingLineAddSchema, BILLING_DESK_LABELS),
  run("Add bill line", 200, (req) => bills.addLine(req.params.billId, req.body, ctx(req))),
);

router.patch(
  `${BASE}/bills/:billId/lines/:lineId`,
  desk,
  validate(billingLineQuantitySchema, BILLING_DESK_LABELS),
  run("Change line quantity", 200, (req) =>
    bills.changeQuantity(req.params.billId, req.params.lineId, req.body, ctx(req)),
  ),
);

router.post(
  `${BASE}/bills/:billId/lines/:lineId/remove`,
  desk,
  validate(billingLineRemoveSchema, BILLING_DESK_LABELS),
  run("Remove bill line", 200, (req) =>
    bills.removeLine(req.params.billId, req.params.lineId, req.body, ctx(req)),
  ),
);

router.post(
  `${BASE}/bills/:billId/codes`,
  desk,
  validate(billingCodeAddSchema, BILLING_DESK_LABELS),
  run("Add discount code", 200, (req) => bills.addCode(req.params.billId, req.body, ctx(req))),
);

router.delete(
  `${BASE}/bills/:billId/codes/:code`,
  desk,
  run("Remove discount code", 200, (req) =>
    bills.removeCode(req.params.billId, { code: req.params.code }, ctx(req)),
  ),
);

router.patch(
  `${BASE}/bills/:billId/category`,
  desk,
  validate(billingCategorySetSchema, BILLING_DESK_LABELS),
  run("Set bill category", 200, (req) => bills.setCategory(req.params.billId, req.body, ctx(req))),
);

router.post(
  `${BASE}/bills/:billId/finalise`,
  desk,
  validate(billingFinaliseSchema, BILLING_DESK_LABELS),
  run("Finalise bill", 200, (req) => bills.finaliseBill(req.params.billId, req.body, ctx(req))),
);

router.post(
  `${BASE}/bills/:billId/cancel`,
  desk,
  validate(billingCancelSchema, BILLING_DESK_LABELS),
  run("Cancel bill", 200, (req) => bills.cancelBill(req.params.billId, req.body, ctx(req))),
);

router.post(
  `${BASE}/bills/:billId/payments`,
  desk,
  validate(billingPaymentsTakeSchema, BILLING_DESK_LABELS),
  run("Take payment", 201, (req) => payments.takePayments(req.params.billId, req.body, ctx(req))),
);

router.get(
  `${BASE}/bills/:billId/payments`,
  desk,
  run("Bill payments", 200, (req) => payments.listPayments(req.params.billId)),
);

router.get(
  `${BASE}/bills/:billId/bill.pdf`,
  desk,
  pdfRoute("Bill PDF", (req) => generateBillPdf(req.params.billId, ctx(req))),
);

router.get(
  `${BASE}/bills/:billId/receipt.pdf`,
  desk,
  validateQuery(billingReceiptQuerySchema, BILLING_DESK_LABELS),
  pdfRoute("Receipt PDF", (req) =>
    generateReceiptPdf(
      req.params.billId,
      { payment_id: req.query.payment_id, receipt_no: req.query.receipt_no },
      ctx(req),
    ),
  ),
);

router.get(
  `${BASE}/dues`,
  desk,
  validateQuery(billingDuesQuerySchema, BILLING_DESK_LABELS),
  run("Dues list", 200, (req) =>
    payments.listDues({
      patientId: req.query.patient_id,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    }),
  ),
);

router.get(
  `${BASE}/shifts/current`,
  desk,
  run("Current shift", 200, (req) => shifts.currentShift(ctx(req))),
);

router.get(
  `${BASE}/shifts/mine`,
  desk,
  validateQuery(billingMyShiftsQuerySchema, BILLING_DESK_LABELS),
  run("My shifts", 200, (req) => shifts.listMyShifts(shiftFilters(req), ctx(req))),
);

router.post(
  `${BASE}/shifts/open`,
  desk,
  validate(billingShiftOpenSchema, BILLING_DESK_LABELS),
  run("Open shift", 201, (req) => shifts.openShift(req.body, ctx(req))),
);

router.post(
  `${BASE}/shifts/close`,
  desk,
  validate(billingShiftCloseSchema, BILLING_DESK_LABELS),
  run("Close shift", 200, (req) => shifts.closeCurrentShift(req.body, ctx(req))),
);

router.post(
  `${BASE}/requests/new-item`,
  desk,
  validate(billingNewItemRequestSchema, BILLING_DESK_LABELS),
  run("New item request", 201, (req) => requests.createNewItemRequest(req.body, ctx(req))),
);

router.post(
  `${BASE}/requests/repeat`,
  desk,
  validate(billingRepeatRequestSchema, BILLING_DESK_LABELS),
  run("Repeat item request", 201, (req) => requests.createRepeatRequest(req.body, ctx(req))),
);

router.get(
  `${BASE}/requests/mine`,
  desk,
  validateQuery(billingRequestListQuerySchema, BILLING_DESK_LABELS),
  run("My requests", 200, (req) => requests.listMyRequests(requestFilters(req), ctx(req))),
);

router.post(
  `${BASE}/master/test-rule`,
  master,
  validate(billingRuleTestSchema, BILLING_PRICING_LABELS),
  run("Billing rule test", 200, (req) =>
    priceBill({
      ...pricing(req),
      role: req.body.role ?? req.doctor.role,
      patient: { age: req.body.age ?? null, gender: req.body.gender ?? null },
      draftRule: req.body.draft_rule,
    }),
  ),
);

router.get(
  `${BASE}/master/requests`,
  master,
  validateQuery(billingRequestListQuerySchema, BILLING_DESK_LABELS),
  run("Request inbox", 200, (req) =>
    requests.listRequests({ ...requestFilters(req), newestFirst: true }),
  ),
);

router.post(
  `${BASE}/master/requests/:id/approve`,
  master,
  validate(billingRequestApproveSchema, BILLING_DESK_LABELS),
  run("Approve request", 200, (req) => requests.approveRequest(req.params.id, req.body, ctx(req))),
);

router.post(
  `${BASE}/master/requests/:id/reject`,
  master,
  validate(billingRequestRejectSchema, BILLING_DESK_LABELS),
  run("Reject request", 200, (req) => requests.rejectRequest(req.params.id, req.body, ctx(req))),
);

router.get(
  `${BASE}/master/shifts`,
  master,
  validateQuery(billingShiftListQuerySchema, BILLING_DESK_LABELS),
  run("All shifts", 200, (req) =>
    shifts.listShifts({ ...shiftFilters(req), userId: req.query.user_id }),
  ),
);

router.post(
  `${BASE}/master/shifts/:id/close`,
  master,
  validate(billingShiftCloseSchema, BILLING_DESK_LABELS),
  run("Close another desk's shift", 200, (req) =>
    shifts.closeShift(req.params.id, req.body, ctx(req)),
  ),
);

export default router;
