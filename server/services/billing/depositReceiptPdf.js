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

const SLIP_TITLE = {
  transfer_out: "DEPOSIT TRANSFER SLIP",
  transfer_in: "DEPOSIT TRANSFER SLIP",
  to_ipd: "DEPOSIT TRANSFER TO IPD",
  refunded: "DEPOSIT REFUND RECEIPT",
};

export async function depositSlipView(entryId, db = pool) {
  const id = typeof entryId === "string" ? entryId.trim() : "";
  if (!UUID.test(id)) throw httpError(400, "Choose a valid deposit slip");
  const { rows } = await db.query(
    `SELECT e.id, e.kind, e.amount, e.balance_after, e.note, e.created_at, e.slip_no,
            e.relationship, e.ipd_number, e.consent_document_id,
            COALESCE(d.short_name, d.name) AS created_by_name,
            pt.id AS patient_id, pt.name, pt.age, pt.sex, pt.file_no, pt.health_id,
            op.name AS other_name, op.file_no AS other_file_no, op.health_id AS other_health_id,
            other.balance_after AS other_balance_after,
            p.mode, p.reference, r.reason AS request_reason
       FROM deposit_entries e
       JOIN patients pt ON pt.id = e.patient_id
       LEFT JOIN patients op ON op.id = e.other_patient_id
       LEFT JOIN deposit_entries other
         ON other.id = e.counter_entry_id OR other.counter_entry_id = e.id
       LEFT JOIN payments p ON p.id = e.payment_id
       LEFT JOIN billing_requests r ON r.id = e.request_id
       LEFT JOIN doctors d ON d.id = e.created_by
      WHERE e.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row || !SLIP_TITLE[row.kind]) throw httpError(404, "That deposit slip doesn't exist");
  const [settings, marks] = await Promise.all([getSettings(db), letterhead()]);
  return {
    entry: {
      id: row.id,
      kind: row.kind,
      amount: Math.abs(paise(row.amount)),
      balance_after: paise(row.balance_after),
      other_balance_after: row.other_balance_after === null ? null : paise(row.other_balance_after),
      note: row.note ?? row.request_reason ?? null,
      created_at: row.created_at,
      created_by_name: row.created_by_name,
      slip_no: row.slip_no,
      relationship: row.relationship,
      ipd_number: row.ipd_number,
      consent_document_id: row.consent_document_id,
      mode: row.mode,
      reference: row.reference,
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
    other: row.other_name
      ? { name: row.other_name, file_no: row.other_file_no, health_id: row.other_health_id }
      : null,
    settings,
    issued: null,
    hospital: marks.hospital,
    logo: marks.logo,
  };
}

const signatureLines = (labels) =>
  `<table class="bp-info"><tbody><tr>${labels
    .map(
      (label) =>
        `<td><div class="bp-sign-space"></div><div class="bp-label">${escapeHtml(label)}</div></td>`,
    )
    .join("")}</tr></tbody></table>`;

export function buildDepositSlipHtml(view) {
  const { entry, patient, other } = view;
  const gst = printsTax(view);
  const transfer = entry.kind === "transfer_out" || entry.kind === "transfer_in";
  const giver = entry.kind === "transfer_in" ? other : patient;
  const taker = entry.kind === "transfer_in" ? patient : other;
  const left = transfer
    ? [
        field("From (depositor)", giver?.name ?? null, true),
        field("UHID", uhidOf(giver)),
        field("To", taker?.name ?? null, true),
        field("UHID", uhidOf(taker)),
        field("Relationship", entry.relationship),
      ]
    : [
        field("Patient Name", patient?.name ?? null, true),
        field("Age/Gender", ageSexText(null, patient)),
        field("UHID", uhidOf(patient)),
      ];
  const right = [
    ...(entry.slip_no ? [field("Slip No", entry.slip_no, true)] : []),
    field("Date", stampText(entry.created_at)),
  ];
  if (entry.kind === "to_ipd") right.push(field("IP / Admission No", entry.ipd_number, true));
  if (entry.kind === "refunded") {
    right.push(field("Mode", modeText(entry.mode)));
    if (entry.reference) right.push(field("Reference", entry.reference));
  }
  if (entry.note) left.push(field("Reason", entry.note));
  const totals = transfer
    ? [
        ["Amount Moved(₹)", amountText(entry.amount)],
        [
          `${giver?.name ?? "Depositor"} — balance after(₹)`,
          amountText(
            entry.kind === "transfer_out" ? entry.balance_after : entry.other_balance_after,
          ),
        ],
        [
          `${taker?.name ?? "Receiver"} — balance after(₹)`,
          amountText(
            entry.kind === "transfer_in" ? entry.balance_after : entry.other_balance_after,
          ),
        ],
      ]
    : [
        [entry.kind === "to_ipd" ? "Moved to IPD(₹)" : "Paid Back(₹)", amountText(entry.amount)],
        ["Deposit Balance(₹)", amountText(entry.balance_after)],
      ];
  const notice =
    entry.kind === "to_ipd"
      ? "IPD desk: enter this amount as a deposit on the patient's HealthRay IPD account, quoting this slip number."
      : transfer
        ? "Moved with the depositor's signed consent, which is kept on file."
        : "The deposit has been paid back to the patient.";
  const signatures = transfer
    ? signatureLines(["Depositor", "Receiver", "Billing desk"])
    : entry.kind === "to_ipd"
      ? signatureLines(["Billing desk", "IPD desk"])
      : signatureLines(["Patient", "Billing desk"]);
  const body = `<div class="bp-page">
  ${headerHtml(view, billHeaderIdentity(view, gst))}
  ${titleHtml(SLIP_TITLE[entry.kind])}
  ${infoGridHtml(left, right)}
  <div class="bp-subtitle">${escapeHtml(notice)}</div>
  ${signatures}
  ${closingHtml(view, {
    totals: totalsTableHtml(totals),
    words: entry.amount,
    operator: { name: entry.created_by_name ?? null, at: entry.created_at },
  })}
</div>`;
  return documentHtml({ title: `${SLIP_TITLE[entry.kind]} ${entry.slip_no || ""}`.trim(), body });
}

export async function generateDepositSlipPdf(entryId, db = pool) {
  const view = await depositSlipView(entryId, db);
  return {
    pdf: await renderBillPdf(buildDepositSlipHtml(view)),
    filename: `DepositSlip_${slug(view.entry.slip_no || view.entry.id.slice(0, 8), "slip")}_${slug(view.patient?.name, "patient")}.pdf`,
  };
}
