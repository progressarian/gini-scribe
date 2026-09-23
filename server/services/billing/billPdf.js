import pool from "../../config/db.js";
import {
  escapeHtml,
  LETTERHEAD_CSS,
  letterheadHtml,
} from "../../templates/prescriptionTemplate.js";
import { getPrescriptionFooter } from "../prescriptionFooter.js";
import { getPrescriptionLogo } from "../prescriptionLogo.js";
import { renderHtmlToPdf } from "../prescriptionHtmlPdf.js";
import { getSettings } from "./billingSettings.js";
import { readBill } from "./bills.js";
import { httpError } from "./transaction.js";

const RUPEES = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const money = (amount) => `₹${RUPEES.format(Math.round(Number(amount) || 0) / 100)}`;

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

export const slug = (text, fallback) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;

const FONTS =
  "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Mono:wght@400;500&family=Outfit:wght@300;400;500;600;700&display=swap";

const DOCUMENT_CSS = `
.bp-page{padding:0 0 18px}
.bp-banner{padding:10px 22px;font-weight:700;letter-spacing:.06em;font-size:13px}
.bp-banner .bp-banner-note{display:block;font-weight:400;letter-spacing:0;font-size:10px;margin-top:3px}
.bp-draft{background:var(--aml);color:var(--am);border-bottom:1px solid var(--amb)}
.bp-cancelled{background:var(--rel);color:var(--re);border-bottom:1px solid var(--reb)}
.bp-meta{display:flex;flex-wrap:wrap;gap:6px 26px;padding:14px 22px;border-bottom:1px solid var(--bd)}
.bp-field{min-width:120px}
.bp-label{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3)}
.bp-value{font-size:12px;color:var(--ink);margin-top:2px}
.bp-section{padding:14px 22px}
.bp-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--ink2);margin-bottom:8px}
table.bp-lines{width:100%;border-collapse:collapse;font-size:11px;table-layout:auto}
table.bp-gst{font-size:9px}
table.bp-gst th,table.bp-gst td{padding:5px 4px}
table.bp-lines th{background:var(--bg);color:var(--ink2);text-align:left;padding:6px 7px;border-bottom:1px solid var(--bd2);font-weight:600;white-space:nowrap}
table.bp-lines td{padding:6px 7px;border-bottom:1px solid var(--bd);vertical-align:top}
table.bp-lines .bp-num{text-align:right;font-family:var(--fm);white-space:nowrap}
table.bp-lines th.bp-num{text-align:right}
.bp-totals{width:52%;margin-left:auto;border-collapse:collapse;font-size:11px}
.bp-totals td{padding:4px 8px}
.bp-totals td.bp-num{text-align:right;font-family:var(--fm)}
.bp-totals tr.bp-strong td{font-weight:700;font-size:12px;border-top:1px solid var(--bd2);border-bottom:1px solid var(--bd2)}
.bp-note{font-size:10px;color:var(--ink3);padding:0 22px 10px}
.bp-footer{border-top:1px solid var(--bd);padding:12px 22px;font-size:10px;color:var(--ink2);white-space:pre-line}
.bp-empty{font-size:11px;color:var(--ink3)}
`;

export function documentHtml({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<link href="${FONTS}" rel="stylesheet">
<style>${LETTERHEAD_CSS}${DOCUMENT_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export const field = (label, value) =>
  `<div class="bp-field"><div class="bp-label">${escapeHtml(label)}</div><div class="bp-value">${
    value === null || value === undefined || value === "" ? "&mdash;" : escapeHtml(value)
  }</div></div>`;

export const footerHtml = (text) =>
  String(text ?? "").trim() ? `<div class="bp-footer">${escapeHtml(text)}</div>` : "";

const CATEGORY_SQL = `
  SELECT s.code, s.label, s.payer_name, s.print_category_on_bill,
         p.code AS parent_code, p.label AS parent_label,
         p.print_category_on_bill AS parent_print
    FROM patient_schemes s
    LEFT JOIN patient_schemes p ON p.code = s.parent_code
   WHERE s.code = $1`;

export const PATIENT_SQL = `SELECT id, name, file_no, health_id, age, sex FROM patients WHERE id = $1`;

export async function letterhead() {
  const [footer, logo] = await Promise.all([getPrescriptionFooter(), getPrescriptionLogo()]);
  return { hospital: footer?.hospital ?? null, logo: logo?.dataUri ?? "" };
}

export async function billView(billId, db = pool) {
  const bill = await readBill(billId, db);
  const [settings, patients, categories, taxes, marks] = await Promise.all([
    getSettings(db),
    db.query(PATIENT_SQL, [bill.patient_id]),
    bill.category ? db.query(CATEGORY_SQL, [bill.category]) : Promise.resolve({ rows: [] }),
    db.query(`SELECT id, sac_hsn, tax_rate_pct FROM bill_lines WHERE bill_id = $1`, [bill.id]),
    letterhead(),
  ]);
  const byLine = new Map(taxes.rows.map((row) => [row.id, row]));
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
    note: "A working copy for checking only. It carries no bill number, it is not a bill, and it is not proof of payment.",
  },
  cancelled: {
    className: "bp-cancelled",
    title: "CANCELLED BILL",
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
  return `<div class="bp-banner ${banner.className}">${escapeHtml(banner.title)}
    <span class="bp-banner-note">${escapeHtml(note)}</span>
  </div>`;
}

function metaHtml(view) {
  const { bill, patient, category, settings } = view;
  const fields = [
    field("Bill number", bill.bill_no || "Not issued yet"),
    field("Bill date", dateText(bill.bill_date)),
    field("Patient", patient?.name ?? null),
    field("UHID", patient?.file_no || patient?.health_id || null),
    field(
      "Age / Sex",
      [bill.patient_age ?? patient?.age, patient?.sex].filter(Boolean).join(" / "),
    ),
  ];
  if (printsCategory(category)) {
    fields.push(field("Category", categoryText(category)));
    if (bill.payer_name) fields.push(field("Payer", bill.payer_name));
    if (bill.scheme_ref) fields.push(field("Card number", bill.scheme_ref));
    if (bill.referral_no) fields.push(field("Referral number", bill.referral_no));
  }
  if (settings?.gst_enabled) {
    if (settings.legal_name) fields.push(field("Billed by", settings.legal_name));
    if (settings.gstin) fields.push(field("GSTIN", settings.gstin));
  }
  return `<div class="bp-meta">${fields.join("")}</div>`;
}

function linesHtml(bill, gst) {
  if (!bill.lines.length) {
    return `<div class="bp-section"><div class="bp-empty">No items on this bill yet.</div></div>`;
  }
  const headings = ["#", "Bill code", "Item"]
    .concat(gst ? ["SAC/HSN"] : [])
    .concat(["Qty", "Actual", "Discount"])
    .concat(gst ? ["Taxable", "GST %", "CGST", "SGST"] : [])
    .concat(["Patient pays"]);
  const text = new Set(["Bill code", "Item", "SAC/HSN"]);
  const head = headings
    .map(
      (heading) => `<th${text.has(heading) ? "" : ' class="bp-num"'}>${escapeHtml(heading)}</th>`,
    )
    .join("");
  const rows = bill.lines
    .map((line, index) => {
      const cells = [
        `<td class="bp-num">${index + 1}</td>`,
        `<td>${escapeHtml(line.bill_code ?? line.item_code ?? "")}</td>`,
        `<td>${escapeHtml(line.bill_name ?? "")}</td>`,
      ];
      if (gst) cells.push(`<td>${escapeHtml(line.sac_hsn ?? "")}</td>`);
      cells.push(`<td class="bp-num">${line.quantity}</td>`);
      cells.push(`<td class="bp-num">${money(line.actual)}</td>`);
      cells.push(`<td class="bp-num">${money(line.discount)}</td>`);
      if (gst) {
        cells.push(`<td class="bp-num">${money(line.taxable)}</td>`);
        cells.push(`<td class="bp-num">${percentText(line.tax_rate_pct)}</td>`);
        cells.push(`<td class="bp-num">${money(line.cgst)}</td>`);
        cells.push(`<td class="bp-num">${money(line.sgst)}</td>`);
      }
      cells.push(`<td class="bp-num">${money(line.patient_payable)}</td>`);
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  return `<div class="bp-section">
    <div class="bp-title">Items</div>
    <table class="bp-lines${gst ? " bp-gst" : ""}"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

export const balanceOf = (bill) => bill.totals.payable - bill.totals.paid;

function totalsHtml(bill, gst) {
  const rows = [
    ["Actual amount", money(bill.totals.actual), false],
    ["Discount", money(bill.totals.discount), false],
  ];
  if (gst) rows.push(["Tax (CGST + SGST)", money(bill.totals.tax), false]);
  rows.push(
    ["Round-off", signedMoney(bill.totals.round_off), false],
    ["Patient payable", money(bill.totals.payable), true],
    ["Claimed from payer", money(bill.totals.claim), false],
    ["Paid", money(bill.totals.paid), false],
    ["Balance", signedMoney(balanceOf(bill)), true],
  );
  const body = rows
    .map(
      ([label, value, strong]) =>
        `<tr${strong ? ' class="bp-strong"' : ""}><td>${escapeHtml(label)}</td><td class="bp-num">${value}</td></tr>`,
    )
    .join("");
  return `<div class="bp-section"><table class="bp-totals"><tbody>${body}</tbody></table></div>`;
}

export function buildBillHtml(view) {
  if (!view?.bill) throw httpError(500, "There is no bill to print");
  const { bill, settings } = view;
  const gst = Boolean(settings?.gst_enabled);
  const heading = bill.status === "draft" ? "Draft bill" : "Bill";
  const body = `<div class="rx-page bp-page">
  ${letterheadHtml(escapeHtml(heading), escapeHtml(bill.bill_no || "No bill number yet"), view.logo || "", view.hospital)}
  ${bannerHtml(bill)}
  ${metaHtml(view)}
  ${linesHtml(bill, gst)}
  ${totalsHtml(bill, gst)}
  ${footerHtml(settings?.bill_footer)}
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
    pdf: await renderHtmlToPdf(html),
    filename: buildBillFileName(view.bill, view.patient),
    bill: view.bill,
  };
}
