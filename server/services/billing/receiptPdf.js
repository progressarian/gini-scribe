import pool from "../../config/db.js";
import { escapeHtml } from "../../templates/prescriptionTemplate.js";
import {
  ageSexText,
  amountText,
  balanceOf,
  billHeaderIdentity,
  billView,
  closingHtml,
  documentHtml,
  field,
  headerHtml,
  infoGridHtml,
  itemsTableHtml,
  modeText,
  numericDateText,
  paymentAmount,
  paymentModeText,
  printsTax,
  renderBillPdf,
  signedAmountText,
  slug,
  stampText,
  titleHtml,
  totalRowHtml,
  totalsTableHtml,
  uhidOf,
} from "./billPdf.js";
import { BILL_DOCUMENT_TITLES } from "../../../shared/billingVocab.js";
import { listPayments } from "./payments.js";
import { httpError } from "./transaction.js";

export { modeText };

const receiverName = (row) => row?.short_name || row?.name || null;

export async function receiptViews(billId, input, db = pool) {
  const view = await billView(billId, db);
  const { bill } = view;
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
  const people = receivers.length
    ? await db.query(`SELECT id, name, short_name FROM doctors WHERE id = ANY($1::int[])`, [
        receivers,
      ])
    : { rows: [] };
  const byId = new Map(people.rows.map((row) => [row.id, row]));
  return wanted.map((payment) => ({
    payment: { ...payment, received_by_name: receiverName(byId.get(payment.received_by)) },
    bill,
    patient: view.patient,
    category: view.category,
    settings: view.settings,
    issued: view.issued,
    hospital: view.hospital,
    logo: view.logo,
  }));
}

const unique = (values) => [...new Set(values.filter(Boolean))];

function receiptDateText(payments) {
  if (payments.length === 1) return stampText(payments[0].received_at);
  return unique(payments.map((payment) => numericDateText(payment.received_at))).join(", ");
}

function paymentsHtml(payments) {
  const head = ["No.", "Receipt No", "Date / Time", "Mode", "Reference", "Amount"]
    .map(
      (heading, index) =>
        `<th class="${index === 0 ? "bp-sno" : index === 5 ? "bp-num" : ""}">${escapeHtml(heading)}</th>`,
    )
    .join("");
  const rows = payments
    .map(
      (payment, index) =>
        `<tr><td class="bp-sno">${index + 1}</td><td class="bp-code">${escapeHtml(payment.receipt_no || "Not issued yet")}</td><td>${escapeHtml(stampText(payment.received_at))}</td><td>${escapeHtml(paymentModeText(payment))}</td><td>${escapeHtml(payment.reference ?? "")}</td><td class="bp-num">${signedAmountText(paymentAmount(payment))}</td></tr>`,
    )
    .join("");
  const total = totalRowHtml(
    5,
    payments.reduce((sum, payment) => sum + paymentAmount(payment), 0),
  );
  return `<table class="bp-grid bp-payments"><thead><tr>${head}</tr></thead><tbody>${rows}${total}</tbody></table>`;
}

function billSummaryHtml(bill) {
  if (!bill?.totals) return "";
  return totalsTableHtml([
    ["Bill Payable Amount(₹)", amountText(bill.totals.payable)],
    ["Paid To Date(₹)", amountText(bill.totals.paid)],
    ["Net Payable Amount(₹)", signedAmountText(balanceOf(bill))],
  ]);
}

function receiptBodyHtml(views) {
  const first = views[0];
  const { bill, patient } = first;
  const payments = views.map((view) => view.payment);
  const total = payments.reduce((sum, payment) => sum + paymentAmount(payment), 0);
  const numbers = unique(payments.map((payment) => payment.receipt_no));
  const last = payments[payments.length - 1];
  const left = [
    field("Patient Name", patient?.name ?? null, true),
    field("Age/Gender", ageSexText(bill, patient)),
    field("UHID", uhidOf(patient)),
  ];
  const right = [
    field(numbers.length > 1 ? "Receipt Nos" : "Receipt No", numbers.join(", ") || null, true),
    field("Date", receiptDateText(payments)),
    field("Bill No", bill?.bill_no || "Draft bill"),
  ];
  const gst = printsTax(first);
  const tail = `<div class="bp-closing">
    <div class="bp-subtitle${bill?.lines ? " bp-subtitle-after" : ""}">PAYMENT DETAILS</div>
    ${paymentsHtml(payments)}
    ${closingHtml(first, {
      totals: billSummaryHtml(bill),
      words: total,
      operator: { name: last.received_by_name ?? null, at: last.received_at },
    })}
  </div>`;
  const body = bill?.lines
    ? `<div class="bp-subtitle">PARTICULARS</div>${itemsTableHtml(first, gst, tail)}`
    : tail;
  return `<div class="bp-page">
  ${headerHtml(first, billHeaderIdentity(first, gst))}
  ${titleHtml(BILL_DOCUMENT_TITLES.receipt)}
  ${infoGridHtml(left, right)}
  ${body}
</div>`;
}

export function buildReceiptHtml(view) {
  if (!view?.payment) throw httpError(500, "There is no payment to print a receipt for");
  return receiptBodyHtml([view]);
}

export function buildReceiptsHtml(views) {
  if (!Array.isArray(views) || !views.length || views.some((view) => !view?.payment)) {
    throw httpError(500, "There is no payment to print a receipt for");
  }
  const first = views[0];
  const title =
    views.length === 1 ? `Receipt ${first.payment.receipt_no || ""}`.trim() : "Receipts";
  return documentHtml({ title, body: receiptBodyHtml(views) });
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
    pdf: await renderBillPdf(html),
    filename: buildReceiptFileName(views),
    receipts: views.map((view) => ({
      payment_id: view.payment.id,
      receipt_no: view.payment.receipt_no,
      amount: view.payment.amount,
    })),
  };
}
