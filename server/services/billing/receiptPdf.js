import pool from "../../config/db.js";
import { escapeHtml, letterheadHtml } from "../../templates/prescriptionTemplate.js";
import { renderHtmlToPdf } from "../prescriptionHtmlPdf.js";
import {
  PATIENT_SQL,
  documentHtml,
  field,
  footerHtml,
  letterhead,
  momentText,
  money,
  slug,
} from "./billPdf.js";
import { getSettings } from "./billingSettings.js";
import { readBill } from "./bills.js";
import { listPayments } from "./payments.js";
import { httpError } from "./transaction.js";

const MODE_LABEL = { cash: "Cash", card: "Card", upi: "UPI" };

export const modeText = (mode) => MODE_LABEL[mode] ?? String(mode ?? "");

const receiverName = (row) => row?.short_name || row?.name || null;

export async function receiptViews(billId, input, db = pool) {
  const bill = await readBill(billId, db);
  const all = await listPayments(bill.id, db);
  const wanted = input?.payment_id
    ? all.filter((payment) => payment.id === input.payment_id)
    : input?.receipt_no
      ? all.filter((payment) => payment.receipt_no === input.receipt_no)
      : all;
  if (!wanted.length) {
    throw httpError(
      404,
      all.length ? "That payment isn't on this bill" : "No payment has been taken on this bill yet",
    );
  }
  const receivers = wanted.map((payment) => payment.received_by).filter(Boolean);
  const [settings, patients, people, marks] = await Promise.all([
    getSettings(db),
    db.query(PATIENT_SQL, [bill.patient_id]),
    receivers.length
      ? db.query(`SELECT id, name, short_name FROM doctors WHERE id = ANY($1::int[])`, [receivers])
      : Promise.resolve({ rows: [] }),
    letterhead(),
  ]);
  const byId = new Map(people.rows.map((row) => [row.id, row]));
  return wanted.map((payment) => ({
    payment: { ...payment, received_by_name: receiverName(byId.get(payment.received_by)) },
    bill,
    patient: patients.rows[0] ?? null,
    settings,
    hospital: marks.hospital,
    logo: marks.logo,
  }));
}

export function buildReceiptHtml(view) {
  if (!view?.payment) throw httpError(500, "There is no payment to print a receipt for");
  const { payment, bill, patient, settings } = view;
  const fields = [
    field("Receipt number", payment.receipt_no || "Not issued yet"),
    field("Receipt date", momentText(payment.received_at)),
    field("Bill number", bill?.bill_no || "Draft bill"),
    field("Patient", patient?.name ?? null),
    field("UHID", patient?.file_no || patient?.health_id || null),
    field("Amount received", money(payment.amount)),
    field("Mode", modeText(payment.mode)),
    field("Reference", payment.reference ?? null),
    field("Received by", payment.received_by_name ?? null),
  ];
  return `<div class="rx-page bp-page">
  ${letterheadHtml(escapeHtml("Receipt"), escapeHtml(payment.receipt_no || "No receipt number yet"), view.logo || "", view.hospital)}
  <div class="bp-meta">${fields.join("")}</div>
  <div class="bp-section">
    <table class="bp-totals"><tbody>
      <tr class="bp-strong"><td>Received with thanks</td><td class="bp-num">${money(payment.amount)}</td></tr>
    </tbody></table>
  </div>
  ${footerHtml(settings?.bill_footer)}
</div>`;
}

export function buildReceiptsHtml(views) {
  if (!Array.isArray(views) || !views.length) {
    throw httpError(500, "There is no payment to print a receipt for");
  }
  const body = views
    .map(
      (view, index) =>
        `${index ? '<div style="page-break-before:always"></div>' : ""}${buildReceiptHtml(view)}`,
    )
    .join("\n");
  const first = views[0];
  const title =
    views.length === 1 ? `Receipt ${first.payment.receipt_no || ""}`.trim() : "Receipts";
  return documentHtml({ title, body });
}

export function buildReceiptFileName(views) {
  const first = views[0];
  const number =
    views.length === 1
      ? first.payment.receipt_no || `payment-${String(first.payment.id ?? "").slice(0, 8)}`
      : first.bill?.bill_no || "bill";
  return `Receipt_${slug(number, "receipt")}_${slug(first.patient?.name, "patient")}.pdf`;
}

export async function generateReceiptPdf(billId, input, ctx, db = pool) {
  const views = await receiptViews(billId, input, db);
  const html = buildReceiptsHtml(views);
  return {
    pdf: await renderHtmlToPdf(html),
    filename: buildReceiptFileName(views),
    receipts: views.map((view) => ({
      payment_id: view.payment.id,
      receipt_no: view.payment.receipt_no,
      amount: view.payment.amount,
    })),
  };
}
