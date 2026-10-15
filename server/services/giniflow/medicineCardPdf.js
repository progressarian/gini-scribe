import pool from "../../config/db.js";
import { buildCard } from "./medicineCard.js";
import { renderHtmlToPdf } from "../prescriptionHtmlPdf.js";
import { getPrescriptionLogo } from "../prescriptionLogo.js";
import { getPrescriptionFooter } from "../prescriptionFooter.js";
import { LETTERHEAD_CSS, letterheadHtml } from "../../templates/prescriptionTemplate.js";
import { ownFu } from "../ghmDayWindow.js";
import { SLOT_ICONS } from "./medicineCardIcons.js";
import {
  MED_SLOTS,
  SLOT_ORDER,
  UNSLOTTED,
  WHEN_TO_TAKE_SLOT,
} from "../../../shared/giniflowMedTiming.js";

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const PRINT_SLOTS = {
  fasting: { label: "Empty Stomach", icon: "sunrise" },
  before_breakfast: { label: "Before Breakfast", icon: "sunrise" },
  with_breakfast: { label: "With Breakfast", icon: "coffee" },
  after_breakfast: { label: "After Breakfast", icon: "coffee" },
  before_lunch: { label: "Before Lunch", icon: "utensils" },
  with_lunch: { label: "With Lunch", icon: "utensils" },
  after_lunch: { label: "After Lunch", icon: "utensils" },
  evening: { label: "Evening", icon: "sun" },
  before_dinner: { label: "Before Dinner", icon: "moon" },
  with_dinner: { label: "With Dinner", icon: "sunset" },
  after_dinner: { label: "After Dinner", icon: "sunset" },
  bedtime: { label: "Bedtime", icon: "moon" },
  with_meals: { label: "With Meals", icon: "utensils" },
  any_time: { label: "Anytime", icon: "clock" },
  weekly: { label: "Weekly", icon: "calendar" },
  fortnightly: { label: "Once in 14 days", icon: "calendar" },
  sos: { label: "As Needed", icon: "bell" },
  [UNSLOTTED.key]: { label: "Timing not set", icon: "alarm" },
};

export function slotsFor(medicine) {
  const values = Array.isArray(medicine.whenToTake)
    ? medicine.whenToTake
    : medicine.whenToTake
      ? [medicine.whenToTake]
      : [];
  const slots = [
    ...new Set(
      values
        .map((v) =>
          WHEN_TO_TAKE_SLOT.get(
            String(v || "")
              .trim()
              .toLowerCase(),
          ),
        )
        .filter((k) => SLOT_ORDER.has(k)),
    ),
  ];
  if (slots.length) return slots;
  if (SLOT_ORDER.has(medicine.timingCategory)) return [medicine.timingCategory];
  return [UNSLOTTED.key];
}

export function groupForPrint(card) {
  const seen = new Set();
  const medicines = (card.groups || [])
    .flatMap((g) => g.medicines)
    .filter((m) => {
      const id = m.medicationId ?? `${m.name}|${m.dose}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const bySlot = new Map();
  for (const medicine of medicines) {
    for (const slot of slotsFor(medicine)) {
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push(medicine);
    }
  }
  return [...MED_SLOTS, UNSLOTTED]
    .filter((slot) => bySlot.has(slot.key))
    .map((slot) => ({
      key: slot.key,
      label: PRINT_SLOTS[slot.key].label,
      icon: PRINT_SLOTS[slot.key].icon,
      medicines: bySlot.get(slot.key),
    }));
}

const icon = (name) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SLOT_ICONS[name] || SLOT_ICONS.clock}</svg>`;

const CSS = `
  .mc{font-family:'Helvetica Neue',Arial,sans-serif;color:#1e1b4b;font-size:12px}
  .mc-title{display:flex;justify-content:space-between;align-items:baseline;margin:14px 0 2px}
  .mc-title h1{font-size:20px;margin:0;color:#1e1b4b}
  .mc-date{font-size:11px;color:#6b7280}
  .mc-who{font-size:13px;color:#374151;margin-bottom:14px}
  .mc-who b{color:#1e1b4b}
  .mc-slot{margin:0 0 12px;break-inside:auto}
  .mc-head{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:14px;background:#f5f3ff;border:1px solid #ddd6fe;break-after:avoid;page-break-after:avoid}
  .mc-ico{width:32px;height:32px;border-radius:10px;background:#ede9fe;color:#6d28d9;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .mc-label{flex:1;font-size:14px;font-weight:800;color:#1e1b4b}
  .mc-count{min-width:22px;height:22px;border-radius:11px;background:#7c5cff;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 7px}
  .mc-med{margin:6px 0 0 20px;padding:9px 12px;border:1px solid #e5e7eb;border-radius:14px;background:#fff;break-inside:avoid;page-break-inside:avoid}
  .mc-name{font-size:13.5px;font-weight:700;color:#1e1b4b;overflow-wrap:anywhere}
  .mc-dose{font-size:12px;color:#374151;margin-top:2px}
  .mc-sub{font-size:11px;color:#6b7280;margin-top:2px;overflow-wrap:anywhere}
  .mc-inst{font-size:11.5px;color:#374151;margin-top:4px}
  .mc-tag{display:inline-block;font-size:9.5px;font-weight:700;padding:1px 7px;border-radius:12px;margin-left:6px;vertical-align:middle}
  .mc-new{background:#dcfce7;color:#166534}
  .mc-chg{background:#fef3c7;color:#92400e}
  .mc-ext{background:#dbeafe;color:#1e40af}
  .mc-empty{padding:24px;text-align:center;color:#6b7280;border:1px dashed #d1d5db;border-radius:14px}
  .mc-next{margin-top:16px;padding:10px 14px;border-radius:14px;background:#faf9ff;border:1px solid #ddd6fe;font-size:13px;break-inside:avoid}
  .mc-next b{color:#6d28d9}
  .mc-legend{margin-top:10px;font-size:10.5px;color:#6b7280;line-height:1.5}
`;

const medHtml = (m) => {
  const dose = [m.dose, m.form, m.route, m.frequency].filter(Boolean).join(" · ") || "—";
  const tag = m.external
    ? `<span class="mc-tag mc-ext">Not from Gini${m.prescriber ? ` · ${esc(m.prescriber)}` : ""}</span>`
    : m.changeType === "new"
      ? `<span class="mc-tag mc-new">New</span>`
      : m.changeType === "changed"
        ? `<span class="mc-tag mc-chg">Dose changed${m.previousDose ? ` from ${esc(m.previousDose)}` : ""}</span>`
        : "";
  const forWhat = (m.forDiagnosis || []).filter(Boolean).join(", ");
  const sub = [m.composition, forWhat ? `for ${forWhat}` : null].filter(Boolean).join(" · ");
  return `<div class="mc-med">
    <div class="mc-name">${esc(m.name || "—")}${tag}</div>
    <div class="mc-dose">${esc(dose)}</div>
    ${sub ? `<div class="mc-sub">${esc(sub)}</div>` : ""}
    ${m.instruction ? `<div class="mc-inst">ⓘ ${esc(m.instruction)}</div>` : ""}
  </div>`;
};

const nextVisitText = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export function buildMedicineCardHtml({
  patient,
  card,
  printedAt,
  doctorName = null,
  nextVisit = null,
  logo = null,
  hospital = null,
}) {
  const groups = groupForPrint(card);
  const slots = groups
    .map(
      (g) => `<section class="mc-slot">
        <div class="mc-head">
          <span class="mc-ico">${icon(g.icon)}</span>
          <span class="mc-label">${esc(g.label)}</span>
          <span class="mc-count">${g.medicines.length}</span>
        </div>
        ${g.medicines.map(medHtml).join("")}
      </section>`,
    )
    .join("");
  const who = [
    `<b>${esc(patient.name)}</b>`,
    esc(patient.file_no || ""),
    `${esc(patient.age ?? "")}${esc((patient.sex || "")[0] || "")}`,
  ]
    .filter((v) => v && v !== "<b></b>")
    .join(" · ");
  const head = letterheadHtml(esc(doctorName || "Gini Advanced Care Hospital"), "", logo, hospital);

  return `<!doctype html><html><head><meta charset="utf-8"><style>${LETTERHEAD_CSS}${CSS}</style></head><body>
    ${head}
    <main class="mc">
      <div class="mc-title"><h1>Medicine card</h1><span class="mc-date">Printed ${esc(printedAt)}</span></div>
      <div class="mc-who">${who}</div>
      ${slots || `<div class="mc-empty">No active medicines on record.</div>`}
      ${
        nextVisit
          ? `<div class="mc-next">Next visit: <b>${esc(nextVisitText(nextVisit))}</b></div>`
          : ""
      }
      ${
        card.counts?.external
          ? `<div class="mc-legend">Medicines marked <b>Not from Gini</b> were prescribed by another doctor. They are listed so your schedule is complete — the Gini pharmacy does not dispense them.</div>`
          : ""
      }
    </main>
  </body></html>`;
}

export async function generateMedicineCardPdf(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.age, p.sex, p.file_no, a.doctor_name,
            CASE WHEN ${ownFu("a")} > v.visit_date THEN ${ownFu("a")}::text END AS next_visit
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN appointments a ON a.id = v.appointment_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const patient = rows[0];
  const [card, logo, footer] = await Promise.all([
    buildCard(patient.id, db),
    getPrescriptionLogo(),
    getPrescriptionFooter(),
  ]);
  const printedAt = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const html = buildMedicineCardHtml({
    patient,
    card,
    printedAt,
    doctorName: patient.doctor_name,
    nextVisit: patient.next_visit,
    logo: logo?.dataUri,
    hospital: footer?.hospital,
  });
  return {
    pdf: await renderHtmlToPdf(html),
    fileName: `medicine-card-${(patient.file_no || patient.id).toString().replace(/\W+/g, "_")}.pdf`,
  };
}
