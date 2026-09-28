import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../../config/db.js";
import { escapeHtml } from "../../templates/prescriptionTemplate.js";
import { getPrescriptionFooter, normalizeHospital } from "../prescriptionFooter.js";
import { getPrescriptionLogo } from "../prescriptionLogo.js";
import { renderHtmlToPdf } from "../prescriptionHtmlPdf.js";
import { BILL_DEPARTMENT, BILL_DOCUMENT_TITLES } from "../../../shared/billingVocab.js";
import { rupeesInWords } from "./amountInWords.js";
import { getSettings } from "./billingSettings.js";
import { readBill } from "./bills.js";
import { httpError } from "./transaction.js";

const RUPEES = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const amountText = (amount) => RUPEES.format(Math.round(Number(amount) || 0) / 100);

export const signedAmountText = (amount) => {
  const value = Math.round(Number(amount) || 0);
  return value < 0 ? `-${amountText(-value)}` : amountText(value);
};

export const money = (amount) => `₹${amountText(amount)}`;

export const signedMoney = (amount) => {
  const value = Math.round(Number(amount) || 0);
  return value < 0 ? `-${money(-value)}` : money(value);
};

export const percentText = (rate) => {
  if (rate === null || rate === undefined || rate === "") return "&mdash;";
  const value = Number(rate);
  return Number.isFinite(value) ? `${Number(value.toFixed(2))}%` : "&mdash;";
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const MOMENT_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

const NUMERIC_DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

const asDate = (value) => {
  if (!value) return null;
  const date =
    typeof value === "string" && DAY.test(value)
      ? new Date(`${value}T00:00:00+05:30`)
      : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const dateText = (value) => {
  const date = asDate(value);
  return date ? DAY_FORMAT.format(date) : "";
};

export const momentText = (value) => {
  const date = asDate(value);
  return date ? MOMENT_FORMAT.format(date).replace(",", "") : "";
};

export const numericDateText = (value) => {
  const date = asDate(value);
  return date ? NUMERIC_DAY_FORMAT.format(date) : "";
};

export const timeText = (value) => {
  const date = asDate(value);
  return date ? TIME_FORMAT.format(date).toUpperCase() : "";
};

export const stampText = (value) =>
  [numericDateText(value), timeText(value)].filter(Boolean).join(" ");

export const SLUG_MAX = 40;

export const slug = (text, fallback) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, SLUG_MAX)
    .replace(/^_+|_+$/g, "") || fallback;

const BILL_LOGO_DATA_URI = (() => {
  try {
    const file = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../templates/assets/bill-logo.png",
    );
    return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  } catch {
    return "";
  }
})();

export const BILL_PAGE_FOOTER = `
  <div style="width:100%;padding:0 12mm;font-family:Arial,Helvetica,sans-serif;font-size:9px;font-weight:700;color:#000;">
    <div style="text-align:right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
  </div>`;

export const renderBillPdf = (html) => renderHtmlToPdf(html, { footerTemplate: BILL_PAGE_FOOTER });

const DOCUMENT_CSS = `
:root{--bp-ink:#111;--bp-rule:#222;--bp-bar:#ddd;--bp-band:#f4f1f1}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{font-family:Roboto,Arial,Helvetica,"Liberation Sans",sans-serif;font-size:11px;line-height:1.4;color:var(--bp-ink);-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bp-page{position:relative;width:100%;padding:0 1px}
.bp-head{display:flex;align-items:center;gap:5mm;margin-bottom:7mm}
.bp-logo img{display:block;height:21mm;width:auto;max-width:34mm}
.bp-org{flex:1;min-width:0}
.bp-org-name{font-size:18px;font-weight:700;text-transform:uppercase;letter-spacing:.01em}
.bp-org-line{margin-top:3px;font-size:10.5px;font-weight:700}
.bp-org-ids{margin-top:5px;font-size:10.5px;font-weight:700}
.bp-subtitle{padding:3px 6px;border:1px solid var(--bp-rule);border-bottom:0;background:var(--bp-band);font-size:10.5px;font-weight:700;letter-spacing:.04em}
.bp-subtitle-after{border-top:0}
.bp-doc-title{padding:8px 0;border:1px solid var(--bp-rule);background:var(--bp-bar);text-align:center;font-size:12.5px;font-weight:700;letter-spacing:.02em}
.bp-banner{padding:5px 10px;border:1px solid var(--bp-rule);border-top:0;text-align:center;font-weight:700;font-size:11.5px;letter-spacing:.04em}
.bp-draft{border-bottom-style:dashed}
.bp-banner .bp-banner-note{display:block;margin-top:2px;font-weight:400;font-size:9.5px;letter-spacing:0}
.bp-watermark{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:96px;font-weight:700;letter-spacing:.1em;color:rgba(0,0,0,.06);transform:rotate(-28deg);pointer-events:none}
table{border-collapse:collapse}
.bp-info{width:100%;border:1px solid var(--bp-rule);border-top:0;border-bottom:0}
.bp-info>tbody>tr>td{width:50%;padding:4px 6px;vertical-align:top}
.bp-info>tbody>tr>td+td{border-left:1px solid var(--bp-rule)}
.bp-field{display:flex;padding:0.5px 0}
.bp-label{flex:0 0 31mm;font-weight:700;text-transform:uppercase}
.bp-label::after{content:":"}
.bp-value{flex:1;min-width:0;overflow-wrap:anywhere}
.bp-bold .bp-value{font-weight:700}
table.bp-grid{width:100%;font-size:10.5px}
table.bp-grid thead{display:table-header-group}
table.bp-grid tr{break-inside:avoid}
table.bp-grid>thead>tr>th,table.bp-grid>tbody>tr>td{padding:3px 6px;border:1px solid var(--bp-rule);vertical-align:top;text-align:left}
table.bp-grid>thead>tr>th{font-weight:700;white-space:nowrap;text-transform:uppercase}
table.bp-grid>tbody>tr>td{overflow-wrap:anywhere}
table.bp-grid .bp-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
table.bp-grid .bp-sno{width:1%;text-align:center;white-space:nowrap}
table.bp-grid .bp-unit{text-align:center;white-space:nowrap}
table.bp-grid .bp-sac,table.bp-grid .bp-code{white-space:nowrap}
table.bp-grid .bp-num,table.bp-grid .bp-unit,table.bp-grid .bp-sac,table.bp-grid .bp-code{width:1%}
table.bp-grid .bp-item{min-width:8em;width:auto}
table.bp-grid tr.bp-total{break-before:avoid}
table.bp-grid>tbody>tr.bp-total>td{font-weight:700;padding-top:4px;padding-bottom:4px}
table.bp-grid>tbody>tr.bp-total>td.bp-total-label{padding-left:10px}
table.bp-gst{font-size:9px}
table.bp-gst>thead>tr>th,table.bp-gst>tbody>tr>td{padding:3px 3px}
.bp-closing{break-inside:avoid}
table.bp-grid>tbody>tr.bp-closing{break-before:avoid}
table.bp-grid>tbody>tr.bp-closing>td{padding:0;border:0;font-size:11px;background:none}
.bp-empty{padding:8px;border:1px solid var(--bp-rule);text-align:center}
.bp-totals-wrap{display:flex;justify-content:flex-end;margin-top:2px}
table.bp-totals{width:50%;font-size:11px}
table.bp-totals td{padding:4px 10px;border:0}
table.bp-totals tr:nth-child(odd) td{background:var(--bp-band)}
table.bp-totals td.bp-total-name{font-weight:700;text-transform:uppercase}
table.bp-totals td.bp-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.bp-words{margin-top:9mm;text-transform:uppercase}
.bp-words-mark{font-weight:700}
.bp-sign{margin-top:5mm;text-align:right}
.bp-upper{text-transform:uppercase}
.bp-sign-space{height:12mm}
.bp-footer{margin-top:5mm;font-size:9.5px;white-space:pre-line}
.bp-operator{margin-top:3mm}
.bp-operator-label{font-weight:700}
`;

export function documentHtml({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>${DOCUMENT_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export const field = (label, value, strong = false) =>
  `<div class="bp-field${strong ? " bp-bold" : ""}"><div class="bp-label">${escapeHtml(label)}</div><div class="bp-value">${
    value === null || value === undefined || value === "" ? "&mdash;" : escapeHtml(value)
  }</div></div>`;

const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== "";

export const footerHtml = (text) =>
  String(text ?? "").trim() ? `<div class="bp-footer">${escapeHtml(text)}</div>` : "";

const PIN = /\b\d{6}\b/;

export function headerHtml(view, { legalName = null, gstin = null } = {}) {
  const hospital = normalizeHospital(view?.hospital);
  const logo = view?.logo
    ? `<div class="bp-logo"><img src="${escapeHtml(view.logo)}" alt=""></div>`
    : "";
  const identity = [legalName, hospital.address].filter(hasValue).join(", ");
  const pin = PIN.exec(hospital.address)?.[0] ?? null;
  const ids = [
    pin ? `PIN: ${escapeHtml(pin)}` : "",
    hasValue(hospital.phone) ? `CONTACT NO: ${escapeHtml(hospital.phone)}` : "",
    hasValue(gstin) ? `GST NO: ${escapeHtml(gstin)}` : "",
  ].filter(Boolean);
  return `<div class="bp-head">
    ${logo}
    <div class="bp-org">
      <div class="bp-org-name">${escapeHtml(hospital.name)}</div>
      <div class="bp-org-line">${escapeHtml(identity)}</div>
      ${ids.length ? `<div class="bp-org-ids">${ids.join(" | ")}</div>` : ""}
    </div>
  </div>`;
}

export const titleHtml = (text) => `<div class="bp-doc-title">${escapeHtml(text)}</div>`;

export const infoGridHtml = (left, right) =>
  `<table class="bp-info"><tbody><tr><td>${left.join("")}</td><td>${right.join("")}</td></tr></tbody></table>`;

export function closingHtml(view, { totals, words, operator }) {
  const hospital = normalizeHospital(view?.hospital);
  const operatorLine = operator?.name
    ? `<div class="bp-operator"><span class="bp-operator-label">OPERATOR NAME:</span> ${escapeHtml(operator.name)}${
        operator.at ? ` [ ${escapeHtml(stampText(operator.at))} ]` : ""
      }</div>`
    : "";
  return `<div class="bp-closing">
    <div class="bp-totals-wrap">${totals}</div>
    <div class="bp-words"><span class="bp-words-mark">(₹)</span> ${escapeHtml(rupeesInWords(words))}</div>
    <div class="bp-sign">
      <div>For, <span class="bp-upper">${escapeHtml(hospital.name)}</span></div>
      <div class="bp-sign-space"></div>
      <div>AUTHORIZED SIGNATORY</div>
    </div>
    ${footerHtml(view?.settings?.bill_footer)}
    ${operatorLine}
  </div>`;
}

export const ageSexText = (bill, patient) => {
  const age = bill?.patient_age ?? patient?.age;
  const ageText = hasValue(age)
    ? /^\d+$/.test(String(age).trim())
      ? `${age} Years`
      : String(age)
    : "";
  const sex = hasValue(patient?.sex) ? String(patient.sex).trim().charAt(0).toUpperCase() : "";
  return [ageText, sex].filter(Boolean).join(" / ");
};

export const uhidOf = (patient) => patient?.file_no || patient?.health_id || null;

const MODE_LABEL = { cash: "Cash", card: "Card", upi: "UPI" };

export const modeText = (mode) => MODE_LABEL[mode] ?? String(mode ?? "");

export const paymentModeText = (payment) =>
  payment?.direction === "out" ? `${modeText(payment.mode)} (refund)` : modeText(payment?.mode);

export const paymentAmount = (payment) =>
  payment?.direction === "out" ? -payment.amount : (payment?.amount ?? 0);

export const totalRowHtml = (span, amount) =>
  `<tr class="bp-total"><td class="bp-total-label" colspan="${span}">TOTAL(₹)</td><td class="bp-num">${signedAmountText(amount)}</td></tr>`;

const CATEGORY_SQL = `
  SELECT s.code, s.label, s.payer_name, s.print_category_on_bill,
         p.code AS parent_code, p.label AS parent_label,
         p.print_category_on_bill AS parent_print
    FROM patient_schemes s
    LEFT JOIN patient_schemes p ON p.code = s.parent_code
   WHERE s.code = $1`;

export const PATIENT_SQL = `SELECT id, name, file_no, health_id, age, sex, phone, address FROM patients WHERE id = $1`;

const VISIT_SQL = `
  SELECT (SELECT a.visit_type FROM giniflow_visits v
            JOIN appointments a ON a.id = v.appointment_id WHERE v.id = $2) AS visit_type,
         (SELECT d.name FROM doctors d
           WHERE d.id = COALESCE(
                   (SELECT l.doctor_id FROM bill_lines l
                     WHERE l.bill_id = $1 AND l.doctor_id IS NOT NULL
                     ORDER BY l.line_no LIMIT 1),
                   (SELECT v.assigned_doctor_id FROM giniflow_visits v WHERE v.id = $2),
                   (SELECT a.doctor_id FROM giniflow_visits v
                      JOIN appointments a ON a.id = v.appointment_id WHERE v.id = $2))) AS consultant,
         (SELECT o.bill_no FROM bills o WHERE o.id = $3) AS original_bill_no,
         (SELECT COALESCE(d.short_name, d.name) FROM bills b JOIN doctors d ON d.id = b.finalised_by
           WHERE b.id = $1) AS finalised_by_name,
         (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
            LEFT JOIN bills c ON c.id = p.bill_id
           WHERE p.direction = 'out' AND (p.bill_id = $1 OR c.original_bill_id = $1)) AS refunded`;

export async function letterhead() {
  const [footer, logo] = await Promise.all([getPrescriptionFooter(), getPrescriptionLogo()]);
  return {
    hospital: footer?.hospital ?? null,
    logo: (logo?.isDefault && BILL_LOGO_DATA_URI) || logo?.dataUri || "",
  };
}

const issuedOf = (row) =>
  row?.issued_gst === null || row?.issued_gst === undefined
    ? null
    : {
        issued_gst: row.issued_gst,
        issued_gstin: row.issued_gstin,
        issued_legal_name: row.issued_legal_name,
      };

export async function billView(billId, db = pool) {
  const bill = await readBill(billId, db);
  const [settings, patients, categories, taxes, marks, issued, visits] = await Promise.all([
    getSettings(db),
    db.query(PATIENT_SQL, [bill.patient_id]),
    bill.category ? db.query(CATEGORY_SQL, [bill.category]) : Promise.resolve({ rows: [] }),
    db.query(`SELECT id, sac_hsn, tax_rate_pct FROM bill_lines WHERE bill_id = $1`, [bill.id]),
    letterhead(),
    db.query(`SELECT to_jsonb(b) AS row FROM bills b WHERE b.id = $1`, [bill.id]),
    db.query(VISIT_SQL, [bill.id, bill.visit_id, bill.original_bill_id ?? null]),
  ]);
  const byLine = new Map(taxes.rows.map((row) => [row.id, row]));
  const visit = visits.rows[0] ?? {};
  return {
    bill: {
      ...bill,
      lines: bill.lines.map((line) => ({
        ...line,
        sac_hsn: byLine.get(line.id)?.sac_hsn ?? null,
        tax_rate_pct: byLine.get(line.id)?.tax_rate_pct ?? null,
      })),
    },
    patient: patients.rows[0] ?? null,
    category: categories.rows[0] ?? null,
    settings,
    issued: issuedOf(issued.rows[0]?.row),
    consultant: visit.consultant ?? null,
    visit_type: visit.visit_type ?? null,
    original_bill_no: visit.original_bill_no ?? null,
    finalised_by_name: visit.finalised_by_name ?? null,
    refunded: Math.round(Number(visit.refunded ?? 0) * 100),
    hospital: marks.hospital,
    logo: marks.logo,
  };
}

export const categoryText = (category) => {
  if (!category) return null;
  return category.parent_label ? `${category.parent_label} › ${category.label}` : category.label;
};

export const printsCategory = (category) =>
  Boolean(category && (category.print_category_on_bill || category.parent_print));

const BANNER = {
  draft: {
    className: "bp-draft",
    title: "DRAFT — NOT A BILL",
    mark: "DRAFT",
    note: "A working copy for checking only. It carries no bill number, it is not a bill, and it is not proof of payment.",
  },
  cancelled: {
    className: "bp-cancelled",
    title: "CANCELLED BILL",
    mark: "CANCELLED",
    note: "This bill was cancelled and is not payable.",
  },
};

function bannerHtml(bill) {
  const banner = BANNER[bill.status];
  if (!banner) return "";
  const extras = [];
  if (bill.status === "cancelled") {
    if (bill.cancelled_at) extras.push(`Cancelled on ${momentText(bill.cancelled_at)}`);
    if (bill.cancel_reason) extras.push(`Reason: ${bill.cancel_reason}`);
  }
  const note = [banner.note, ...extras].join(" ");
  return `<div class="bp-watermark">${escapeHtml(banner.mark)}</div>
  <div class="bp-banner ${banner.className}">${escapeHtml(banner.title)}
    <span class="bp-banner-note">${escapeHtml(note)}</span>
  </div>`;
}

export const printsTax = (view) =>
  Boolean(view?.issued ? view.issued.issued_gst : view?.settings?.gst_enabled) ||
  (view?.bill?.totals?.tax ?? 0) > 0;

const gstIdentity = (view) =>
  view?.issued
    ? { legal_name: view.issued.issued_legal_name, gstin: view.issued.issued_gstin }
    : { legal_name: view?.settings?.legal_name, gstin: view?.settings?.gstin };

export function billHeaderIdentity(view, gst) {
  const { legal_name, gstin } = gstIdentity(view);
  return { legalName: legal_name ?? null, gstin: gst ? (gstin ?? null) : null };
}

const isCreditNote = (bill) => bill?.bill_type === "credit_note";

function documentTitle(bill, gst) {
  if (isCreditNote(bill)) return BILL_DOCUMENT_TITLES.credit_note;
  return gst ? BILL_DOCUMENT_TITLES.tax_invoice : BILL_DOCUMENT_TITLES.invoice;
}

function infoHtml(view) {
  const { bill, patient, category } = view;
  const credit = isCreditNote(bill);
  const left = [
    field("Patient Name", patient?.name ?? null, true),
    field("Age/Gender", ageSexText(bill, patient)),
    field("UHID", uhidOf(patient)),
  ];
  if (hasValue(view.consultant)) left.push(field("Consult Name", view.consultant, true));
  if (hasValue(patient?.address)) left.push(field("Address", patient.address));
  const right = [
    field(credit ? "Credit Note No" : "Bill No", bill.bill_no || "Not issued yet", true),
    field(credit ? "Date" : "Bill Date", numericDateText(bill.bill_date), true),
    field("Department", BILL_DEPARTMENT),
  ];
  if (credit && view.original_bill_no) right.push(field("Against Bill", view.original_bill_no));
  if (hasValue(view.visit_type)) right.push(field("Visit Type", view.visit_type));
  if (printsCategory(category)) {
    right.push(field("Category", categoryText(category)));
    if (bill.payer_name) right.push(field("Payer", bill.payer_name));
    if (bill.scheme_ref) right.push(field("Card No", bill.scheme_ref));
    if (bill.referral_no) right.push(field("Referral No", bill.referral_no));
  }
  return infoGridHtml(left, right);
}

const lineNet = (line) => line.actual - line.discount + (line.cgst ?? 0) + (line.sgst ?? 0);

const sumOf = (lines, pick) => lines.reduce((total, line) => total + (pick(line) || 0), 0);

const unitText = (quantity) => {
  const value = Number(quantity);
  return Number.isFinite(value) ? value.toFixed(2) : String(quantity ?? "");
};

export function itemsTableHtml(view, gst, closing = "") {
  const { bill } = view;
  if (!bill.lines.length) {
    return `<div class="bp-empty">No items on this bill yet.</div>${closing}`;
  }
  const codes = printsCategory(view.category);
  const discounted = bill.lines.some((line) => line.discount > 0);
  const netColumn = discounted || gst;
  const columns = [["No.", "bp-sno"]]
    .concat(codes ? [["Code", "bp-code"]] : [])
    .concat([["Particulars", "bp-item"]])
    .concat(gst ? [["SAC/HSN", "bp-sac"]] : [])
    .concat([
      ["Unit", "bp-unit"],
      ["Rate", "bp-num"],
      ["Amount", "bp-num"],
    ])
    .concat(discounted ? [["Discount", "bp-num"]] : [])
    .concat(
      gst
        ? [
            ["Taxable", "bp-num"],
            ["GST %", "bp-num"],
            ["CGST", "bp-num"],
            ["SGST", "bp-num"],
          ]
        : [],
    )
    .concat(netColumn ? [["Net Amount", "bp-num"]] : []);
  const head = columns
    .map(([heading, className]) => `<th class="${className}">${escapeHtml(heading)}</th>`)
    .join("");
  const rows = bill.lines
    .map((line, index) => {
      const cells = [`<td class="bp-sno">${index + 1}</td>`];
      if (codes) {
        cells.push(
          `<td class="bp-code">${escapeHtml(line.bill_code ?? line.item_code ?? "")}</td>`,
        );
      }
      cells.push(`<td class="bp-item">${escapeHtml(line.bill_name ?? "")}</td>`);
      if (gst) cells.push(`<td class="bp-sac">${escapeHtml(line.sac_hsn ?? "")}</td>`);
      cells.push(`<td class="bp-unit">${escapeHtml(unitText(line.quantity))}</td>`);
      cells.push(`<td class="bp-num">${amountText(line.rate)}</td>`);
      cells.push(`<td class="bp-num">${amountText(line.actual)}</td>`);
      if (discounted) cells.push(`<td class="bp-num">${amountText(line.discount)}</td>`);
      if (gst) {
        cells.push(`<td class="bp-num">${amountText(line.taxable)}</td>`);
        cells.push(`<td class="bp-num">${percentText(line.tax_rate_pct)}</td>`);
        cells.push(`<td class="bp-num">${amountText(line.cgst)}</td>`);
        cells.push(`<td class="bp-num">${amountText(line.sgst)}</td>`);
      }
      if (netColumn) cells.push(`<td class="bp-num">${amountText(lineNet(line))}</td>`);
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  const total = totalRowHtml(
    columns.length - 1,
    sumOf(bill.lines, netColumn ? lineNet : (line) => line.actual),
  );
  const end = closing
    ? `<tr class="bp-closing"><td colspan="${columns.length}">${closing}</td></tr>`
    : "";
  return `<table class="bp-grid bp-lines${gst ? " bp-gst" : ""}"><thead><tr>${head}</tr></thead><tbody>${rows}${total}${end}</tbody></table>`;
}

export const balanceOf = (bill) => bill.totals.payable - bill.totals.paid;

export const totalsTableHtml = (rows) =>
  `<table class="bp-totals"><tbody>${rows
    .map(
      ([label, value]) =>
        `<tr><td class="bp-total-name">${escapeHtml(label)}</td><td class="bp-num">${value}</td></tr>`,
    )
    .join("")}</tbody></table>`;

function totalsHtml(view, gst) {
  const { bill } = view;
  const rows = [["Billed Amount (₹)", amountText(bill.totals.actual)]];
  if (bill.totals.discount > 0) rows.push(["Discount (₹)", amountText(bill.totals.discount)]);
  if (gst) rows.push(["Tax (₹)", amountText(bill.totals.tax)]);
  if (bill.totals.round_off !== 0) {
    rows.push(["Round Off (₹)", signedAmountText(bill.totals.round_off)]);
  }
  if (bill.totals.claim > 0) rows.push(["Claimed From Payer (₹)", amountText(bill.totals.claim)]);
  if (bill.totals.adjustment > 0) {
    rows.push(["Hospital Adjustment (₹)", amountText(bill.totals.adjustment)]);
  }
  rows.push(
    ["Total Payable Amount (₹)", amountText(bill.totals.payable)],
    ["Paid Amount(₹)", amountText(bill.totals.paid)],
    ["Net Payable Amount(₹)", signedAmountText(balanceOf(bill))],
  );
  if ((view.refunded ?? 0) > 0) rows.push(["Refunded Amount(₹)", amountText(view.refunded)]);
  return totalsTableHtml(rows);
}

export function buildBillHtml(view) {
  if (!view?.bill) throw httpError(500, "There is no bill to print");
  const { bill } = view;
  const gst = printsTax(view);
  const heading = isCreditNote(bill)
    ? "Credit note"
    : bill.status === "draft"
      ? "Draft bill"
      : "Bill";
  const operator =
    bill.status === "draft"
      ? null
      : { name: view.finalised_by_name ?? null, at: bill.finalised_at ?? null };
  const closing = closingHtml(view, {
    totals: totalsHtml(view, gst),
    words: bill.totals.payable,
    operator,
  });
  const body = `<div class="bp-page">
  ${headerHtml(view, billHeaderIdentity(view, gst))}
  ${titleHtml(documentTitle(bill, gst))}
  ${bannerHtml(bill)}
  ${infoHtml(view)}
  ${itemsTableHtml(view, gst, closing)}
</div>`;
  return documentHtml({ title: `${heading} ${bill.bill_no || ""}`.trim(), body });
}

export function buildBillFileName(bill, patient) {
  const number = bill?.bill_no || `draft-${String(bill?.id ?? "").slice(0, 8)}`;
  return `Bill_${slug(number, "bill")}_${slug(patient?.name, "patient")}.pdf`;
}

export async function generateBillPdf(billId, ctx, db = pool) {
  const view = await billView(billId, db);
  const html = buildBillHtml(view);
  return {
    pdf: await renderBillPdf(html),
    filename: buildBillFileName(view.bill, view.patient),
    bill: view.bill,
  };
}
