// ── Lab Report PDF Generator ────────────────────────────────────────────────
// Generates a lab report PDF matching the HealthRay format using PDFKit.
// Each report/test group gets its own page with header, patient info, results, and signatures.

import PDFDocument from "pdfkit";

// ── Layout constants ────────────────────────────────────────────────────────
const M_LEFT = 36;
const M_RIGHT = 560;
const WIDTH = M_RIGHT - M_LEFT;
const COL_TEST = M_LEFT;
const COL_RESULT = 260;
const COL_UNIT = 380;
const COL_RANGE = 470;

// ── Build patient info from case detail ─────────────────────────────────────
function getPatientInfo(caseDetail) {
  const p = caseDetail.patient || {};
  const name =
    p.patient_name ||
    p.name ||
    [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ") ||
    "Unknown";

  let ageSex = "";
  if (p.age != null) ageSex += `${p.age} Years`;
  else if (p.birth_date || p.dob) {
    const dob = new Date(p.birth_date || p.dob);
    if (!isNaN(dob))
      ageSex += `${Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000))} Years`;
  }
  const gender = p.gender || p.sex || "";
  if (gender) ageSex += ageSex ? ` / ${gender}` : gender;

  const uhid = p.healthray_uid || p.uhid || p.file_no || p.patient_uhid || "";
  const referrer = caseDetail.doctor_name || caseDetail.referred_by || p.referred_by || "";

  return { name: name.toUpperCase(), ageSex, uhid, referrer: referrer.toUpperCase() };
}

// ── Format timestamps ───────────────────────────────────────────────────────
function fmtDateTime(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 16);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = d.getHours() >= 12 ? "PM" : "AM";
  const h12 = d.getHours() % 12 || 12;
  return `${dd}/${mm}/${yyyy} ${h12}:${min} ${ampm}`;
}

// ── Extract structured results grouped by category and report ────────────────
function extractReportSections(caseDetail) {
  const sections = [];

  for (const cat of caseDetail.case_reports || []) {
    const categoryName = cat.category_name || "General";

    // Structure 1: tests[].parameters[]
    for (const test of cat.tests || []) {
      const rows = [];
      for (const param of test.parameters || []) {
        const r = param.result || {};
        const ref = param.test_ref_value || {};
        const val = r.test_result;
        if (val == null || val === "") continue;

        const numVal = parseFloat(val);
        const refMin = ref.min_value != null ? parseFloat(ref.min_value) : null;
        const refMax = ref.max_value != null ? parseFloat(ref.max_value) : null;

        let refRange = ref.ref_range || "";
        if (!refRange) {
          if (refMin != null && refMax != null) refRange = `${refMin} - ${refMax}`;
          else if (refMin != null) refRange = `> ${refMin}`;
          else if (refMax != null) refRange = `< ${refMax}`;
        }

        let flag = "";
        if (!isNaN(numVal)) {
          if (refMin != null && numVal < refMin) flag = "L";
          else if (refMax != null && numVal > refMax) flag = "H";
        }

        rows.push({
          name: param.name || "",
          result: String(val),
          unit: param.unit || "",
          refRange,
          flag,
        });
      }
      if (rows.length) {
        sections.push({
          category: categoryName,
          groupName: test.name || test.test_name || "",
          rows,
        });
      }
    }

    // Structure 2 & 3: reports[].report_tests[].test
    for (const report of cat.reports || []) {
      const rows = [];
      const reportName = report.name || report.report_name || "";

      for (const rt of report.report_tests || []) {
        const test = rt.test || {};
        const params = test.parameters && test.parameters.length > 0 ? test.parameters : [test];

        for (const param of params) {
          const r = param.result || {};
          const ref = param.test_ref_value || {};
          const val = r.test_result;
          if (val == null || val === "") continue;

          const numVal = parseFloat(val);
          const refMin = ref.min_value != null ? parseFloat(ref.min_value) : null;
          const refMax = ref.max_value != null ? parseFloat(ref.max_value) : null;

          let refRange = ref.ref_range || "";
          if (!refRange) {
            if (refMin != null && refMax != null) refRange = `${refMin} - ${refMax}`;
            else if (refMin != null) refRange = `> ${refMin}`;
            else if (refMax != null) refRange = `< ${refMax}`;
          }

          let flag = "";
          if (!isNaN(numVal)) {
            if (refMin != null && numVal < refMin) flag = "L";
            else if (refMax != null && numVal > refMax) flag = "H";
          }

          rows.push({
            name: param.name || "",
            result: String(val),
            unit: param.unit || "",
            refRange,
            flag,
          });
        }
      }
      if (rows.length) {
        sections.push({ category: categoryName, groupName: reportName, rows });
      }
    }
  }

  return sections;
}

// ── Draw page header (hospital + patient info + dates) ──────────────────────
function drawPageHeader(doc, patient, caseDetail, branchInfo) {
  const hospitalName = branchInfo?.name || branchInfo?.lab_name || "GINI ADVANCED CARE HOSPITAL";
  const address =
    branchInfo?.address ||
    "Gini Health India Private Limited ,2nd Floor, Shivalik Hospital, Sector 69, S.A.S, Nagar;";
  const phone =
    branchInfo?.mobile_number || branchInfo?.phone || "0172-4120100, +91 91155-16172 (Whatsapp)";

  let y = 36;

  // Hospital name
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#1a1a1a");
  doc.text(hospitalName, M_LEFT + 10, y, { width: WIDTH - 10 });
  y += 22;

  // Address + phone
  doc.font("Helvetica").fontSize(8).fillColor("#444");
  doc.text(address, M_LEFT + 10, y, { width: WIDTH - 10 });
  y += 10;
  doc.text(phone, M_LEFT + 10, y, { width: WIDTH - 10 });
  y += 16;

  // Orange/dark yellow line under header
  doc.strokeColor("#d4a017").lineWidth(2).moveTo(M_LEFT, y).lineTo(M_RIGHT, y).stroke();
  y += 16;

  // Patient info (left) + Dates (right)
  const leftX = M_LEFT;
  const rightLabelX = 380;
  const rightValX = 460;

  // Row 1
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000");
  doc.text("Name:", leftX, y);
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text(patient.name, leftX + 52, y, { width: 250 });
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#333");
  doc.text("Registered On:", rightLabelX, y);
  doc.font("Helvetica").fontSize(8);
  doc.text(fmtDateTime(caseDetail.registered_at || caseDetail.created_at), rightValX, y);
  y += 13;

  // Row 2
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000");
  doc.text("Age/Sex:", leftX, y);
  doc.font("Helvetica").fontSize(9);
  doc.text(patient.ageSex, leftX + 52, y, { width: 250 });
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#333");
  doc.text("Collected On:", rightLabelX, y);
  doc.font("Helvetica").fontSize(8);
  doc.text(fmtDateTime(caseDetail.collected_on), rightValX, y);
  y += 13;

  // Row 3
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000");
  doc.text("Referrer:", leftX, y);
  doc.font("Helvetica").fontSize(9);
  doc.text(patient.referrer, leftX + 52, y, { width: 250 });
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#333");
  doc.text("Received On:", rightLabelX, y);
  doc.font("Helvetica").fontSize(8);
  doc.text(fmtDateTime(caseDetail.received_on || caseDetail.collected_on), rightValX, y);
  y += 13;

  // Row 4
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#000");
  doc.text("UHID:", leftX, y);
  doc.font("Helvetica").fontSize(9);
  doc.text(patient.uhid, leftX + 52, y, { width: 250 });
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#333");
  doc.text("Reported On:", rightLabelX, y);
  doc.font("Helvetica").fontSize(8);
  doc.text(fmtDateTime(caseDetail.reported_on || caseDetail.collected_on), rightValX, y);
  y += 20;

  return y;
}

// ── Draw signatures at bottom of page ───────────────────────────────────────
function drawSignatures(doc, signatures) {
  const sigList = Array.isArray(signatures) ? signatures : [];
  if (!sigList.length) return;

  const y = 720;

  // Line above signatures
  doc.strokeColor("#d4a017").lineWidth(1.5).moveTo(M_LEFT, y).lineTo(M_RIGHT, y).stroke();

  const sigY = y + 60;
  const count = Math.min(sigList.length, 3);
  const sigWidth = WIDTH / count;

  for (let i = 0; i < count; i++) {
    const sig = sigList[i];
    const sx = M_LEFT + i * sigWidth;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#000");
    doc.text(sig.name || sig.user_name || "", sx, sigY, { width: sigWidth, align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor("#555");
    doc.text(sig.designation || sig.role || "Lab Technician", sx, sigY + 12, {
      width: sigWidth,
      align: "center",
    });
  }
}

// ── Main PDF generation ─────────────────────────────────────────────────────
export async function generateLabReportPdf(caseDetail, branchInfo, signatures) {
  const patient = getPatientInfo(caseDetail);
  const sections = extractReportSections(caseDetail);

  if (!sections.length) return null;

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 36, bottom: 36, left: 36, right: 36 },
  });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));

  const bufferPromise = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const isLastPage = si === sections.length - 1;

    // New page for each section (except first)
    if (si > 0) doc.addPage();

    // ── Header + Patient Info ───────────────────────────────────────
    let y = drawPageHeader(doc, patient, caseDetail, branchInfo);

    // ── Category title (centered, bold) ─────────────────────────────
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#000");
    doc.text(section.category, M_LEFT, y, { width: WIDTH, align: "center" });
    y += 22;

    // ── Table header row ────────────────────────────────────────────
    doc.strokeColor("#333").lineWidth(1).moveTo(M_LEFT, y).lineTo(M_RIGHT, y).stroke();
    y += 6;

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#000");
    doc.text("TEST", COL_TEST, y, { width: 210 });
    doc.text("RESULT", COL_RESULT, y, { width: 110 });
    doc.text("UNIT", COL_UNIT, y, { width: 80 });
    doc.text("REFERENCE RANGE", COL_RANGE, y, { width: 100 });
    y += 14;

    doc.strokeColor("#333").lineWidth(0.5).moveTo(M_LEFT, y).lineTo(M_RIGHT, y).stroke();
    y += 8;

    // ── Group/report name (centered, bold) ──────────────────────────
    if (section.groupName) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text(section.groupName, M_LEFT, y, { width: WIDTH, align: "center" });
      y += 16;
    }

    // ── Result rows ─────────────────────────────────────────────────
    for (const row of section.rows) {
      const isAbnormal = row.flag === "H" || row.flag === "L";
      const resultText = row.flag ? `${row.flag}  ${row.result}` : row.result;

      // Test name
      doc.font("Helvetica").fontSize(9).fillColor("#000");
      doc.text(row.name, COL_TEST, y, { width: 210 });

      // Result (bold + red if abnormal)
      doc
        .font(isAbnormal ? "Helvetica-Bold" : "Helvetica")
        .fontSize(9)
        .fillColor(isAbnormal ? "#000" : "#000");
      if (isAbnormal) {
        doc.font("Helvetica-Bold").text(resultText, COL_RESULT, y, { width: 110 });
      } else {
        doc.font("Helvetica").text(resultText, COL_RESULT, y, { width: 110 });
      }

      // Unit
      doc.font("Helvetica").fontSize(9).fillColor("#000");
      doc.text(row.unit, COL_UNIT, y, { width: 80 });

      // Reference range
      doc.font("Helvetica").fontSize(8).fillColor("#000");
      const rangeHeight = doc.heightOfString(row.refRange, { width: 95 });
      doc.text(row.refRange, COL_RANGE, y, { width: 95 });

      y += Math.max(16, rangeHeight + 6);
    }

    // ── End of report marker on last page ───────────────────────────
    if (isLastPage) {
      y += 12;
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000");
      doc.text("~ End Of Report ~", M_LEFT, y, { width: WIDTH, align: "center" });
    }

    // ── Bottom line (signatures removed) ──────────────────────────
  }

  doc.end();
  return bufferPromise;
}
