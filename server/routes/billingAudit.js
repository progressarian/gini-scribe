import { Router } from "express";
import { requireCapability } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import {
  BILLING_AUDIT_LABELS,
  billingAuditBillsQuerySchema,
  billingAuditItemsQuerySchema,
} from "../schemas/index.js";
import { billingRoute as run, sendFailure, sendXlsx } from "./billingHttp.js";
import {
  auditBillPdf,
  exportAuditBills,
  exportAuditItems,
  listAuditBills,
  listAuditItems,
  logAuditAccess,
} from "../services/billing/auditReport.js";

const router = Router();
const BASE = "/billing/audit";
const audit = requireCapability(CAP.BILLING_AUDIT);
const billsQuery = validateQuery(billingAuditBillsQuerySchema, BILLING_AUDIT_LABELS);
const itemsQuery = validateQuery(billingAuditItemsQuerySchema, BILLING_AUDIT_LABELS);
const who = (req) => req.doctor?.doctor_id;

const listed = (view, list) => async (req) => {
  const report = await list(req.query);
  logAuditAccess(who(req), "billing_audit_view", {
    view,
    page: report.page,
    rows: view === "items" ? report.totals.items : report.totals.bills,
    filters: report.filters,
  });
  return report;
};

const exported = (view, make, context) => async (req, res) => {
  try {
    const file = await make(req.query);
    logAuditAccess(who(req), "billing_audit_export", {
      view,
      rows: file.count,
      filters: file.filters,
    });
    res.set("X-Audit-Count", String(file.count));
    sendXlsx(res, file.buffer, file.fileName);
  } catch (e) {
    sendFailure(context, res, e);
  }
};

router.get(
  `${BASE}/bills`,
  audit,
  billsQuery,
  run("Billing audit", 200, listed("bills", listAuditBills)),
);

router.get(
  `${BASE}/bills/export`,
  audit,
  billsQuery,
  exported("bills", exportAuditBills, "Billing audit export"),
);

router.get(
  `${BASE}/items`,
  audit,
  itemsQuery,
  run("Billing audit items", 200, listed("items", listAuditItems)),
);

router.get(
  `${BASE}/items/export`,
  audit,
  itemsQuery,
  exported("items", exportAuditItems, "Billing audit items export"),
);

router.get(`${BASE}/bills/:billId/bill.pdf`, audit, async (req, res) => {
  try {
    const made = await auditBillPdf(req.params.billId);
    logAuditAccess(who(req), "billing_audit_bill_pdf", {
      bill_id: made.bill.id,
      bill_no: made.bill.bill_no ?? null,
    });
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${made.filename}"`,
      "Content-Length": String(made.pdf.length),
      "Cache-Control": "no-store",
    });
    res.send(made.pdf);
  } catch (e) {
    sendFailure("Billing audit bill PDF", res, e);
  }
});

export default router;
