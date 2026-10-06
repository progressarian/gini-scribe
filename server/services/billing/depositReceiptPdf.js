import pool from "../../config/db.js";
import { escapeHtml } from "../../templates/prescriptionTemplate.js";
import { paise } from "../../../shared/labPayment.js";
import {
  ageSexText,
  amountText,
  billHeaderIdentity,
  closingHtml,
  documentHtml,
  field,
  headerHtml,
  infoGridHtml,
  letterhead,
  modeText,
  printsTax,
  renderBillPdf,
  slug,
  stampText,
  titleHtml,
  totalsTableHtml,
  uhidOf,
} from "./billPdf.js";
import { getSettings } from "./billingSettings.js";
import { httpError } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function depositReceiptView(paymentId, db = pool) {
  const id = typeof paymentId === "string" ? paymentId.trim() : "";
  if (!UUID.test(id)) throw httpError(400, "Choose a valid deposit receipt");
  const { rows } = await db.query(
    `SELECT p.id, p.mode, p.amount, p.reference, p.receipt_no, p.received_at,
            e.balance_after, e.note,
            COALESCE(d.short_name, d.name) AS received_by_name,
            pt.id AS patient_id, pt.name, pt.age, pt.sex, pt.file_no, pt.health_id
       FROM payments p
       JOIN deposit_entries e ON e.payment_id = p.id AND e.kind = 'received'
       JOIN patients pt ON pt.id = p.deposit_patient_id
       LEFT JOIN doctors d ON d.id = p.received_by
      WHERE p.id = $1 AND p.bill_id IS NULL AND p.direction = 'in'`,
    [id],
  );
  if (!rows.length) throw httpError(404, "That deposit receipt doesn't exist");
  const row = rows[0];
  const [settings, marks] = await Promise.all([getSettings(db), letterhead()]);
  return {
    payment: {
      id: row.id,
      mode: row.mode,
      amount: paise(row.amount),
      reference: row.reference,
      receipt_no: row.receipt_no,
      received_at: row.received_at,
      received_by_name: row.received_by_name,
      balance_after: paise(row.balance_after),
      note: row.note,
    },
    bill: null,
    patient: {
      id: row.patient_id,
      name: row.name,
      age: row.age,
      sex: row.sex,
      file_no: row.file_no,
      health_id: row.health_id,
    },
    settings,
    issued: null,
    hospital: marks.hospital,
    logo: marks.logo,
  };
}

export function buildDepositReceiptHtml(view) {
  const { payment, patient } = view;
  const gst = printsTax(view);
  const left = [
    field("Patient Name", patient?.name ?? null, true),
    field("Age/Gender", ageSexText(null, patient)),
    field("UHID", uhidOf(patient)),
  ];
  const right = [
    field("Receipt No", payment.receipt_no, true),
    field("Date", stampText(payment.received_at)),
    field("Mode", modeText(payment.mode)),
  ];
  if (payment.reference) right.push(field("Reference", payment.reference));
  if (payment.note) left.push(field("Note", payment.note));
  const body = `<div class="bp-page">
  ${headerHtml(view, billHeaderIdentity(view, gst))}
  ${titleHtml("ADVANCE DEPOSIT RECEIPT")}
  ${infoGridHtml(left, right)}
  <div class="bp-subtitle">${escapeHtml("Advance deposit — not a bill. It is used on this patient's bills, or refunded on request.")}</div>
  ${closingHtml(view, {
    totals: totalsTableHtml([
      ["Deposit Received(₹)", amountText(payment.amount)],
      ["Deposit Balance(₹)", amountText(payment.balance_after)],
    ]),
    words: payment.amount,
    operator: { name: payment.received_by_name ?? null, at: payment.received_at },
  })}
</div>`;
  return documentHtml({ title: `Deposit receipt ${payment.receipt_no || ""}`.trim(), body });
}

export async function generateDepositReceiptPdf(paymentId, db = pool) {
  const view = await depositReceiptView(paymentId, db);
  return {
    pdf: await renderBillPdf(buildDepositReceiptHtml(view)),
    filename: `Deposit_${slug(view.payment.receipt_no, "receipt")}_${slug(view.patient?.name, "patient")}.pdf`,
  };
}
