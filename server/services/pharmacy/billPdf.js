import pool from "../../config/db.js";
import { escapeHtml } from "../../templates/prescriptionTemplate.js";
import {
  ageSexText,
  amountText,
  closingHtml,
  dateText,
  documentHtml,
  field,
  headerHtml,
  infoGridHtml,
  letterhead,
  paymentModeText,
  percentText,
  renderBillPdf,
  signedAmountText,
  slug,
  titleHtml,
  totalsTableHtml,
} from "../billing/billPdf.js";
import { getSettings } from "../billing/billingSettings.js";
import { httpError } from "../billing/transaction.js";
import { getBill } from "./bills.js";
import { getPharmacySettings } from "./settings.js";
import { toPaise } from "../../../shared/pharmacyMoney.js";
import {
  REGISTER_SCHEDULES,
  SALE_TYPE_LABEL,
  SCHEDULE_LABEL,
  splitUnits,
} from "../../../shared/pharmacyVocab.js";
import { inclusivePackRate } from "../../../shared/pharmacyPricing.js";

const paise = (rupees) => toPaise(rupees);

const expiryText = (iso) => {
  const [year, month] = String(iso).split("-");
  return `${month}/${year.slice(2)}`;
};

const quantityText = (line) => {
  const { packs, loose } = splitUnits(line.qty_units, line.pack_size);
  if (line.pack_size <= 1) return `${line.qty_units}`;
  return [packs ? `${packs}×${line.pack_size}` : "", loose ? `${loose}` : ""]
    .filter(Boolean)
    .join(" + ");
};

function linesTableHtml(bill, closing) {
  const folded = bill.gst_folded;
  const lineDiscount = (line) => paise(line.discount_amount ?? 0) + paise(line.bill_discount ?? 0);
  const discounted = bill.lines.some((line) => lineDiscount(line) > 0);
  const columns = [
    ["No.", "bp-sno"],
    ["Particulars", "bp-item"],
    ...(folded ? [] : [["HSN", "bp-sac"]]),
    ["Batch", "bp-code"],
    ["Exp", "bp-unit"],
    ["Qty", "bp-unit"],
    ["MRP", "bp-num"],
    ["Rate", "bp-num"],
    ...(discounted ? [["Disc", "bp-num"]] : []),
    ...(folded
      ? []
      : [
          ["Taxable", "bp-num"],
          ["GST %", "bp-num"],
          ["CGST", "bp-num"],
          ["SGST", "bp-num"],
        ]),
    ["Amount", "bp-num"],
  ];
  const head = columns
    .map(([heading, className]) => `<th class="${className}">${escapeHtml(heading)}</th>`)
    .join("");
  const rows = bill.lines
    .map((line, index) => {
      const schedule =
        line.schedule && line.schedule !== "none"
          ? ` <span class="bp-tag">(${escapeHtml(SCHEDULE_LABEL[line.schedule] ?? line.schedule)})</span>`
          : "";
      const cells = [
        `<td class="bp-sno">${index + 1}</td>`,
        `<td class="bp-item">${escapeHtml(line.medicine_name)}${schedule}</td>`,
        ...(folded ? [] : [`<td class="bp-sac">${escapeHtml(line.hsn_code ?? "")}</td>`]),
        `<td class="bp-code">${escapeHtml(line.batch_no)}</td>`,
        `<td class="bp-unit">${escapeHtml(expiryText(line.expiry_date))}</td>`,
        `<td class="bp-unit">${escapeHtml(quantityText(line))}</td>`,
        `<td class="bp-num">${amountText(paise(line.pack_mrp))}</td>`,
        `<td class="bp-num">${amountText(
          folded
            ? inclusivePackRate({
                packSaleRate: line.pack_sale_rate,
                packMrp: line.pack_mrp,
                gstRatePct: line.gst_rate_pct,
                saleRateIncludesGst: bill.sale_rate_includes_gst,
              })
            : paise(line.pack_sale_rate),
        )}</td>`,
      ];
      if (discounted) {
        const pct = Number(line.discount_pct ?? 0);
        cells.push(
          `<td class="bp-num">${amountText(lineDiscount(line))}${pct ? ` <span class="bp-tag">(${escapeHtml(String(pct))}%)</span>` : ""}</td>`,
        );
      }
      if (!folded) {
        cells.push(
          `<td class="bp-num">${amountText(paise(line.taxable))}</td>`,
          `<td class="bp-num">${percentText(line.tax_rate_pct)}</td>`,
          `<td class="bp-num">${amountText(paise(line.cgst))}</td>`,
          `<td class="bp-num">${amountText(paise(line.sgst))}</td>`,
        );
      }
      cells.push(`<td class="bp-num">${amountText(paise(line.total))}</td>`);
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  const lineSum = bill.lines.reduce((sum, line) => sum + paise(line.total), 0);
  const total = `<tr class="bp-total"><td class="bp-total-label" colspan="${columns.length - 1}">TOTAL(₹)</td><td class="bp-num">${amountText(lineSum)}</td></tr>`;
  const end = `<tr class="bp-closing"><td colspan="${columns.length}">${closing}</td></tr>`;
  return `<table class="bp-grid bp-lines bp-gst"><thead><tr>${head}</tr></thead><tbody>${rows}${total}${end}</tbody></table>`;
}

function creditTotalsHtml(bill) {
  const rows = [];
  if (bill.gst_folded) {
    rows.push(["Amount Credited (₹)", amountText(paise(bill.taxable_amount))]);
  } else {
    rows.push(["Taxable Value Credited (₹)", amountText(paise(bill.taxable_amount))]);
    rows.push(["CGST Reversed (₹)", amountText(paise(bill.cgst_amount))]);
    rows.push(["SGST Reversed (₹)", amountText(paise(bill.sgst_amount))]);
  }
  if (paise(bill.round_off) !== 0) {
    rows.push(["Round Off (₹)", signedAmountText(paise(bill.round_off))]);
  }
  rows.push(["Credit Note Amount (₹)", amountText(paise(bill.net_amount))]);
  for (const payment of bill.payments) {
    rows.push([`Refunded · ${paymentModeText(payment)} (₹)`, amountText(paise(payment.amount))]);
  }
  return totalsTableHtml(rows);
}

function totalsHtml(bill) {
  if (bill.bill_type === "credit_note") return creditTotalsHtml(bill);
  const rows = [];
  if (paise(bill.discount_amount ?? 0) > 0) {
    const onBill =
      bill.discount_kind === "percent"
        ? ` incl. ${Number(bill.discount_value)}% on the bill`
        : bill.discount_kind === "amount"
          ? ` incl. ₹${amountText(paise(bill.discount_value))} on the bill`
          : "";
    rows.push([`Discount${onBill} (₹)`, amountText(paise(bill.discount_amount))]);
  }
  if (bill.gst_folded) {
    rows.push(["Amount (₹)", amountText(paise(bill.taxable_amount))]);
  } else {
    rows.push(["Taxable Value (₹)", amountText(paise(bill.taxable_amount))]);
    rows.push(["CGST (₹)", amountText(paise(bill.cgst_amount))]);
    rows.push(["SGST (₹)", amountText(paise(bill.sgst_amount))]);
  }
  if (paise(bill.round_off) !== 0) {
    rows.push(["Round Off (₹)", signedAmountText(paise(bill.round_off))]);
  }
  rows.push(["Bill Amount (₹)", amountText(paise(bill.net_amount))]);
  for (const payment of bill.payments) {
    rows.push([
      `${paymentModeText(payment)}${payment.receipt_no ? ` · ${payment.receipt_no}` : ""} (₹)`,
      amountText(paise(payment.amount)),
    ]);
  }
  rows.push([
    "Balance Due (₹)",
    signedAmountText(paise(bill.net_amount) - paise(bill.paid_amount)),
  ]);
  return totalsTableHtml(rows);
}

function infoHtml(bill) {
  const left = [
    field("Patient Name", bill.patient_name, true),
    field("File No", bill.patient_file_no),
    field("Age / Sex", ageSexText({ patient_age: bill.patient_age }, { sex: bill.patient_sex })),
    field("Mobile", bill.patient_phone),
  ];
  const credit = bill.bill_type === "credit_note";
  const right = [
    field(credit ? "Credit Note No" : "Bill No", bill.bill_no, true),
    field(credit ? "Credit Note Date" : "Bill Date", dateText(bill.bill_date)),
    ...(credit ? [field("Against Bill", bill.original_bill_no)] : []),
    field("Sale Type", SALE_TYPE_LABEL[bill.sale_type]),
  ];
  if (bill.ipd_number) right.push(field("IPD No", bill.ipd_number));
  if (bill.prescriber_name) right.push(field("Prescribed By", bill.prescriber_name));
  return infoGridHtml(left, right);
}

function licenceHtml(bill) {
  if (!bill.issued_drug_license) return "";
  return `<div class="bp-subtitle">DRUG LICENCE NO: ${escapeHtml(bill.issued_drug_license)}</div>`;
}

function noticeHtml(bill) {
  const notes = [];
  if (bill.bill_type === "credit_note" && bill.notes) {
    notes.push(`Returned: ${bill.notes}`);
  }
  const controlled = bill.lines.filter((l) => REGISTER_SCHEDULES.includes(l.schedule));
  if (controlled.length) {
    const kinds = [...new Set(controlled.map((l) => SCHEDULE_LABEL[l.schedule]))].join(", ");
    notes.push(
      `${kinds} medicines sold on the prescription of ${bill.prescriber_name ?? "the prescribing doctor"}.`,
    );
  }
  return notes.length
    ? `<div class="bp-banner"><span class="bp-banner-note">${notes.map(escapeHtml).join("<br>")}</span></div>`
    : "";
}

export function buildPharmacyBillHtml(view) {
  const { bill } = view;
  const taxInvoice = Boolean(bill.issued_gstin) && !bill.gst_folded;
  const closing = closingHtml(view, {
    totals: totalsHtml(bill),
    words: paise(bill.net_amount),
    operator: { name: bill.finalised_by_name ?? null, at: bill.finalised_at ?? null },
  });
  const body = `<div class="bp-page">
  ${headerHtml(view, {
    legalName: bill.issued_legal_name,
    gstin: bill.gst_folded ? null : bill.issued_gstin,
  })}
  ${licenceHtml(bill)}
  ${titleHtml(bill.bill_type === "credit_note" ? "PHARMACY CREDIT NOTE" : taxInvoice ? "PHARMACY TAX INVOICE" : "PHARMACY BILL")}
  ${noticeHtml(bill)}
  ${infoHtml(bill)}
  ${linesTableHtml(bill, closing)}
</div>`;
  const kind = bill.bill_type === "credit_note" ? "Pharmacy credit note" : "Pharmacy bill";
  return documentHtml({ title: `${kind} ${bill.bill_no}`, body });
}

export async function generatePharmacyBillPdf(id, db = pool) {
  const bill = await getBill(id, db);
  if (bill.status !== "final") {
    throw httpError(409, "Only a finalised bill can be printed. Finalise it first");
  }
  const [marks, pharmacy, billing] = await Promise.all([
    letterhead(),
    getPharmacySettings(db),
    getSettings(db),
  ]);
  const html = buildPharmacyBillHtml({
    ...marks,
    hospital: {
      ...marks.hospital,
      address: pharmacy.address || marks.hospital?.address,
      phone: pharmacy.phone || marks.hospital?.phone,
    },
    bill,
    settings: { bill_footer: pharmacy.bill_footer ?? billing.bill_footer ?? null },
  });
  return {
    pdf: await renderBillPdf(html),
    filename: `PharmacyBill_${slug(bill.bill_no, "bill")}_${slug(bill.patient_name, "patient")}.pdf`,
  };
}
