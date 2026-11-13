import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const PAGE = { width: 595.28, height: 841.89 };
const M_LEFT = 36;
const M_RIGHT = PAGE.width - 36;
const WIDTH = M_RIGHT - M_LEFT;
const CONTENT_BOTTOM = 770;
const COLUMNS = {
  test: { x: M_LEFT + 6, width: 200 },
  result: { x: 250, width: 110 },
  unit: { x: 370, width: 90 },
  range: { x: 465, width: M_RIGHT - 465 },
};
const ACCENT = "#d4a017";
const INK = "#1a1a1a";
const MUTED = "#555555";

export const HOSPITAL = {
  name: "GINI ADVANCED CARE HOSPITAL",
  address:
    "Gini Health India Private Limited ,2nd Floor, Shivalik Hospital, Sector 69, S.A.S, Nagar;",
  phone: "0172-4120100, +91 91155-16172 (Whatsapp)",
  city: "Mohali, Panjab, India, 160062",
};

const LOGO = (() => {
  try {
    return readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../templates/assets/bill-logo.png"),
    );
  } catch {
    return null;
  }
})();

const IST_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function istDateTime(raw) {
  if (!raw) return "";
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw).slice(0, 16);
  const p = Object.fromEntries(IST_PARTS.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod).toUpperCase()}`;
}

function drawLetterhead(doc, hospital) {
  let textX = M_LEFT;
  if (LOGO) {
    doc.image(LOGO, M_LEFT, 30, { height: 46 });
    textX = M_LEFT + 74;
  }
  doc.font("Helvetica-Bold").fontSize(16).fillColor(INK);
  doc.text(hospital.name, textX, 32, { width: M_RIGHT - textX });
  doc.font("Helvetica").fontSize(8.5).fillColor("#333333");
  doc.text(hospital.address, textX, 52, { width: M_RIGHT - textX });
  doc.text(hospital.phone, textX, doc.y, { width: M_RIGHT - textX });
  if (hospital.city) doc.text(hospital.city, textX, doc.y, { width: M_RIGHT - textX });
  const y = Math.max(doc.y, 80) + 8;
  doc.strokeColor(ACCENT).lineWidth(1.5).moveTo(M_LEFT, y).lineTo(M_RIGHT, y).stroke();
  return y + 12;
}

function drawPatientBlock(doc, patient, dates, top) {
  const left = [
    ["Name:", patient.name, true],
    ["Age/Sex:", patient.ageSex],
    ["Referrer:", patient.referrer, true],
    ["UHID:", patient.uhid],
  ];
  const right = [
    ["Registered On:", dates.registered],
    ["Collected On:", dates.collected],
    ["Received On:", dates.received],
    ["Reported On:", dates.reported],
  ];
  let y = top;
  for (let i = 0; i < 4; i++) {
    const [label, value, strong] = left[i];
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK).text(label, M_LEFT, y);
    doc
      .font(strong ? "Helvetica-Bold" : "Helvetica")
      .text(value || "—", M_LEFT + 54, y, { width: 270, height: 11, ellipsis: true });
    doc.font("Helvetica-Bold").text(right[i][0], 382, y);
    doc.font("Helvetica").text(istDateTime(right[i][1]) || "—", 452, y, { width: 108 });
    y += 13;
  }
  return y + 6;
}

function drawTableHead(doc, category, top) {
  let y = top;
  doc.font("Helvetica-Bold").fontSize(12).fillColor(INK);
  doc.text(category, M_LEFT, y, { width: WIDTH, align: "center" });
  y += 20;
  doc.strokeColor("#333333").lineWidth(1).moveTo(M_LEFT, y).lineTo(M_RIGHT, y).stroke();
  y += 5;
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(INK);
  doc.text("TEST", COLUMNS.test.x, y, { width: COLUMNS.test.width });
  doc.text("RESULT", COLUMNS.result.x, y, { width: COLUMNS.result.width });
  doc.text("UNIT", COLUMNS.unit.x, y, { width: COLUMNS.unit.width });
  doc.text("REFERENCE RANGE", COLUMNS.range.x, y, { width: COLUMNS.range.width });
  y += 13;
  doc.strokeColor("#333333").lineWidth(0.5).moveTo(M_LEFT, y).lineTo(M_RIGHT, y).stroke();
  return y + 7;
}

function drawGroupName(doc, name, top) {
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK);
  doc.text(name, M_LEFT, top, { width: WIDTH, align: "center" });
  return top + 16;
}

function rowHeight(doc, row) {
  doc.font("Helvetica").fontSize(9);
  const name = doc.heightOfString(row.name || "", { width: COLUMNS.test.width });
  const result = doc.heightOfString(row.result || "", { width: COLUMNS.result.width - 14 });
  doc.fontSize(8.5);
  const range = doc.heightOfString(row.refRange || "", { width: COLUMNS.range.width });
  return Math.max(name, result, range) + 6;
}

function drawRow(doc, row, y) {
  const flagged = row.flag === "H" || row.flag === "L";
  doc.font("Helvetica").fontSize(9).fillColor(INK);
  doc.text(row.name || "", COLUMNS.test.x, y, { width: COLUMNS.test.width });
  if (flagged) {
    doc.font("Helvetica-Bold").text(row.flag, COLUMNS.result.x - 12, y, { width: 10 });
  }
  doc
    .font(flagged ? "Helvetica-Bold" : "Helvetica")
    .text(row.result || "", COLUMNS.result.x, y, { width: COLUMNS.result.width - 14 });
  doc.font("Helvetica").text(row.unit || "", COLUMNS.unit.x, y, { width: COLUMNS.unit.width });
  doc.fontSize(8.5).text(row.refRange || "", COLUMNS.range.x, y, { width: COLUMNS.range.width });
}

function drawWatermark(doc, text) {
  doc.save();
  doc.rotate(-40, { origin: [PAGE.width / 2, PAGE.height / 2] });
  doc.font("Helvetica-Bold").fontSize(54).fillColor("#000000").fillOpacity(0.07);
  doc.text(text, 0, PAGE.height / 2 - 30, { width: PAGE.width, align: "center", lineBreak: false });
  doc.restore();
  doc.fillOpacity(1);
}

function drawFooters(doc, footerNote) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = PAGE.height - 56;
    doc.strokeColor(ACCENT).lineWidth(1).moveTo(M_LEFT, y).lineTo(M_RIGHT, y).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
    if (footerNote) {
      doc.text(footerNote, M_LEFT, y + 6, { width: WIDTH - 80, lineBreak: false, ellipsis: true });
    }
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, M_RIGHT - 80, y + 6, {
      width: 80,
      align: "right",
      lineBreak: false,
    });
  }
}

export function renderLabReportPdf({
  patient,
  dates = {},
  sections,
  hospital = HOSPITAL,
  watermark = null,
  footerNote = null,
}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 0, bottom: 0, left: M_LEFT, right: PAGE.width - M_RIGHT },
    bufferPages: true,
    info: { Title: `${patient.name || "Patient"} - Lab report`, Author: hospital.name },
  });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const startPage = (category, groupName, continued) => {
    if (watermark) drawWatermark(doc, watermark);
    let y = drawLetterhead(doc, hospital);
    y = drawPatientBlock(doc, patient, dates, y);
    y = drawTableHead(doc, category, y);
    if (groupName) y = drawGroupName(doc, continued ? `${groupName} (contd.)` : groupName, y);
    return y;
  };

  sections.forEach((section, si) => {
    if (si > 0) doc.addPage();
    let y = startPage(section.category, section.groupName, false);
    for (const row of section.rows) {
      const h = rowHeight(doc, row);
      if (y + h > CONTENT_BOTTOM) {
        doc.addPage();
        y = startPage(section.category, section.groupName, true);
      }
      drawRow(doc, row, y);
      y += Math.max(16, h);
    }
    if (si === sections.length - 1) {
      if (y + 30 > CONTENT_BOTTOM) {
        doc.addPage();
        y = startPage(section.category, null, true);
      }
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK);
      doc.text("~ End Of Report ~", M_LEFT, y + 14, { width: WIDTH, align: "center" });
    }
  });

  drawFooters(doc, footerNote);
  doc.end();
  return done;
}
