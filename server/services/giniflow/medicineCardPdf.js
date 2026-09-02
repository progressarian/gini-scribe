import pool from "../../config/db.js";
import { buildCard } from "./medicineCard.js";
import { renderHtmlToPdf } from "../prescriptionHtmlPdf.js";

// The medicine card, printed.
//
// Server-side rather than window.print(): the browser prints the consultation
// screen — nav, rails, the prescription editor and all — and what the patient
// needs to take home is the schedule alone, on A4, legible at arm's length.
//
// It renders from the same `buildCard` the screen does, so the printed card and
// the on-screen one cannot disagree about when to take a medicine. That is the
// whole reason `buildCard` is one function (medicineCard.js).

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

// The same palette the screen uses, inlined — a print job has no stylesheet.
const CSS = `
  *{box-sizing:border-box}
  body{font-family:'Helvetica Neue',Arial,sans-serif;color:#0f172a;margin:0;font-size:12px}
  h1{font-size:19px;margin:0 0 2px}
  .who{font-size:12px;color:#64748b;margin-bottom:2px}
  .when{font-size:10px;color:#94a3b8;margin-bottom:14px}
  .card{border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
  .row{display:flex;border-bottom:1px solid #e2e8f0;page-break-inside:avoid}
  .row:last-child{border-bottom:none}
  .time{width:150px;padding:9px 12px;background:#f4f6f9;border-right:1px solid #e2e8f0;flex-shrink:0}
  .tl{font-size:11px;font-weight:700}
  .ts{font-size:10px;color:#64748b;margin-top:1px}
  .meds{flex:1;padding:8px 12px}
  .med{font-size:12px;padding:2px 0}
  .med b{font-weight:700}
  .note{color:#64748b;font-size:11px}
  .tag{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:4px}
  .ext{background:#eff6ff;color:#2563eb}
  .new{background:#f0fdf4;color:#16a34a}
  .chg{background:#fffbeb;color:#d97706}
  .legend{margin-top:10px;font-size:10px;color:#64748b;line-height:1.5}
  .empty{padding:18px;text-align:center;color:#64748b}
`;

const medLine = (m) => {
  const bits = [m.dose, m.frequency].filter(Boolean).join(" · ");
  const tag = m.external
    ? `<span class="tag ext">From ${esc(m.prescriber || "another doctor")}</span>`
    : m.changeType === "new"
      ? `<span class="tag new">NEW</span>`
      : m.changeType === "changed"
        ? `<span class="tag chg">CHANGED${m.previousDose ? ` from ${esc(m.previousDose)}` : ""}</span>`
        : "";
  return `<div class="med"><b>${esc(m.name)}</b>${bits ? ` <span class="note">· ${esc(bits)}</span>` : ""}${tag}</div>`;
};

export function buildMedicineCardHtml({ patient, card, printedAt }) {
  const rows = (card.groups || [])
    .map(
      (g) => `<div class="row">
        <div class="time"><div class="tl">${esc(g.label)}</div>${
          g.timeLabel ? `<div class="ts">${esc(g.timeLabel)}</div>` : ""
        }</div>
        <div class="meds">${g.medicines.map(medLine).join("")}</div>
      </div>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
    <h1>Medicine card</h1>
    <div class="who">${esc(patient.name)} · ${esc(patient.age ?? "")}${esc(
      (patient.sex || "")[0] || "",
    )} · ${esc(patient.file_no || "")}</div>
    <div class="when">Printed ${esc(printedAt)} · Gini Advanced Care Hospital</div>
    <div class="card">${rows || `<div class="empty">No active medicines on record.</div>`}</div>
    ${
      card.counts?.external
        ? `<div class="legend">Medicines marked <b>From …</b> were prescribed by another doctor. They are listed so your schedule is complete — the Gini pharmacy does not dispense them.</div>`
        : ""
    }
  </body></html>`;
}

export async function generateMedicineCardPdf(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.age, p.sex, p.file_no
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });

  const card = await buildCard(rows[0].id, db);
  const printedAt = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const html = buildMedicineCardHtml({ patient: rows[0], card, printedAt });
  return {
    pdf: await renderHtmlToPdf(html),
    fileName: `medicine-card-${(rows[0].file_no || rows[0].id).toString().replace(/\W+/g, "_")}.pdf`,
  };
}
