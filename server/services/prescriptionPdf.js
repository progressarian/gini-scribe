// Prescription PDF builder used by the "Paste Clinical Notes" flow.
// Generates a sectioned A4 prescription mirroring how HealthRay prescriptions
// are laid out — header, patient meta, then one section per data block:
// symptoms → diagnoses → meds → previous meds → labs → vitals → investigations
// → lifestyle → follow-up → advice. Always stamps a "Created by Scribe" footer.

// pdfkit is CJS-only — load lazily via dynamic import so module load doesn't
// break in ESM-quirky setups (tests, type-checking, etc.).
async function loadPdfKit() {
  const mod = await import("pdfkit");
  return mod.default || mod;
}

const TEAL = "#009e8c";
const TEXT = "#1a2332";
const MUTED = "#6b7d90";
const BORDER = "#dde3ea";

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function nonEmpty(v) {
  return v != null && String(v).trim() !== "";
}

function joinMeta(parts) {
  return parts.filter(nonEmpty).join(" · ");
}

function sectionTitle(doc, text) {
  doc.moveDown(0.4);
  doc
    .fillColor(TEAL)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(text.toUpperCase(), { characterSpacing: 0.5 });
  const y = doc.y + 1;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .strokeColor(TEAL)
    .lineWidth(0.7)
    .stroke();
  doc.moveDown(0.4);
  doc.fillColor(TEXT).font("Helvetica").fontSize(10);
}

function bullet(doc, text) {
  doc.fillColor(TEXT).font("Helvetica").fontSize(10).text(`•  ${text}`, {
    indent: 8,
    paragraphGap: 2,
  });
}

function kv(doc, label, value) {
  if (!nonEmpty(value)) return;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text(label, { continued: true });
  doc.font("Helvetica").fillColor(TEXT).text(`  ${value}`);
}

function row(doc, cells, widths, opts = {}) {
  const { left } = doc.page.margins;
  const top = doc.y;
  const cellHeight = opts.cellHeight || 14;
  let x = left;
  cells.forEach((c, i) => {
    doc
      .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(opts.fontSize || 9)
      .fillColor(opts.color || TEXT)
      .text(c == null ? "" : String(c), x + 4, top + 3, {
        width: widths[i] - 8,
        height: cellHeight,
        ellipsis: true,
      });
    x += widths[i];
  });
  // Bottom border
  doc
    .moveTo(left, top + cellHeight + 2)
    .lineTo(left + widths.reduce((a, b) => a + b, 0), top + cellHeight + 2)
    .strokeColor(BORDER)
    .lineWidth(0.5)
    .stroke();
  doc.y = top + cellHeight + 4;
}

function ensureSpace(doc, needed = 80) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

export async function buildPrescriptionPdf({ patient = {}, doctor = {}, parsed = {}, doc_date }) {
  const PDFDocumentCtor = await loadPdfKit();
  const doc = new PDFDocumentCtor({
    size: "A4",
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    bufferPages: true, // required for the per-page footer pass below
    info: {
      Title: `Prescription — ${patient.name || ""}`,
      Author: doctor.name || "Gini Scribe",
      Creator: "Gini Scribe",
    },
  });

  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // ─── HEADER ────────────────────────────────────────────────────────────
  doc
    .fillColor(TEAL)
    .font("Helvetica-Bold")
    .fontSize(20)
    .text("Gini Health", { continued: true })
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(10)
    .text("   Advanced Care Hospital");
  doc
    .fillColor(MUTED)
    .fontSize(9)
    .text(
      "Shivalik Hospital, 2nd Floor, Sector 69, Mohali, Punjab · 0172-4120100 · +91 8146320100",
    );
  doc.moveDown(0.6);

  // Doctor block (right-aligned)
  const docBlockY = doc.y;
  doc
    .fillColor(TEXT)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(doctor.name || "Doctor", doc.page.margins.left, docBlockY, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: "right",
    });
  if (doctor.qualification) {
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(MUTED)
      .text(doctor.qualification, { align: "right" });
  }
  if (doctor.reg_no) {
    doc.text(`Reg. No. ${doctor.reg_no}`, { align: "right" });
  }

  // Divider
  doc.moveDown(0.4);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(TEAL)
    .lineWidth(1.5)
    .stroke();
  doc.moveDown(0.6);

  // ─── PATIENT INFO ──────────────────────────────────────────────────────
  doc
    .fillColor(TEXT)
    .font("Helvetica-Bold")
    .fontSize(13)
    .text(patient.name || "Patient");
  const ptMeta = joinMeta([
    patient.age ? `${patient.age}${patient.sex ? patient.sex[0] : ""}` : null,
    patient.file_no ? `ID #${patient.file_no}` : patient.id ? `P-${patient.id}` : null,
    patient.blood_group,
    patient.phone,
  ]);
  if (ptMeta) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(ptMeta);
  }
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text(`Date: ${fmtDate(doc_date || new Date())}`);
  if (patient.allergies) {
    doc.fillColor("#b91c1c").text(`⚠ Allergies: ${patient.allergies}`);
  }

  // ─── SYMPTOMS / CHIEF COMPLAINTS ──────────────────────────────────────
  const symptoms = Array.isArray(parsed.symptoms) ? parsed.symptoms : [];
  if (symptoms.length) {
    ensureSpace(doc);
    sectionTitle(doc, "Chief Complaints & Symptoms");
    for (const s of symptoms) {
      const meta = joinMeta([
        s.severity,
        s.duration,
        s.since_date ? `since ${s.since_date}` : null,
        s.related_to,
      ]);
      bullet(doc, `${s.name}${meta ? ` — ${meta}` : ""}`);
    }
  }

  // ─── DIAGNOSES ─────────────────────────────────────────────────────────
  const dxAll = Array.isArray(parsed.diagnoses) ? parsed.diagnoses : [];
  const dxPresent = dxAll.filter((d) => d.status !== "Absent");
  const dxAbsent = dxAll.filter((d) => d.status === "Absent");
  if (dxPresent.length) {
    ensureSpace(doc);
    sectionTitle(doc, "Diagnoses");
    for (const d of dxPresent) {
      const meta = joinMeta([d.details, d.since ? `since ${d.since}` : null, d.status]);
      bullet(doc, `${d.name}${meta ? ` — ${meta}` : ""}`);
    }
  }
  if (dxAbsent.length) {
    ensureSpace(doc, 60);
    sectionTitle(doc, "Ruled Out / Absent");
    for (const d of dxAbsent) {
      const meta = joinMeta([d.details, d.since ? `since ${d.since}` : null]);
      bullet(doc, `${d.name}${meta ? ` — ${meta}` : ""}`);
    }
  }

  // ─── CURRENT MEDICATIONS ───────────────────────────────────────────────
  const meds = Array.isArray(parsed.medications) ? parsed.medications : [];
  if (meds.length) {
    ensureSpace(doc, 100);
    sectionTitle(doc, "Current Medications");
    const widths = [180, 70, 70, 110, 60];
    row(doc, ["Medicine", "Dose", "Frequency", "Timing", "Route"], widths, {
      bold: true,
      color: MUTED,
      fontSize: 8,
    });
    for (const m of meds) {
      ensureSpace(doc, 24);
      const wt = Array.isArray(m.when_to_take) ? m.when_to_take.join(", ") : m.when_to_take || "";
      row(
        doc,
        [
          m.name,
          m.dose,
          m.frequency,
          wt && m.timing && m.timing !== wt ? `${wt} (${m.timing})` : wt || m.timing,
          m.route || "Oral",
        ],
        widths,
      );
    }
  }

  // ─── PREVIOUS MEDICATIONS ──────────────────────────────────────────────
  const prevMeds = Array.isArray(parsed.previous_medications) ? parsed.previous_medications : [];
  if (prevMeds.length) {
    ensureSpace(doc, 80);
    sectionTitle(doc, "Previous Medications");
    for (const m of prevMeds) {
      const meta = joinMeta([m.dose, m.frequency, m.status, m.reason]);
      bullet(doc, `${m.name}${meta ? ` — ${meta}` : ""}`);
    }
  }

  // ─── LAB VALUES ────────────────────────────────────────────────────────
  const labs = Array.isArray(parsed.labs) ? parsed.labs : [];
  if (labs.length) {
    ensureSpace(doc, 100);
    sectionTitle(doc, "Lab Values");
    const widths = [200, 100, 80, 110];
    row(doc, ["Test", "Value", "Unit", "Date"], widths, {
      bold: true,
      color: MUTED,
      fontSize: 8,
    });
    for (const l of labs) {
      ensureSpace(doc, 22);
      row(doc, [l.test, l.value, l.unit || "", l.date ? fmtDate(l.date) : ""], widths);
    }
  }

  // ─── VITALS ────────────────────────────────────────────────────────────
  const vitals = Array.isArray(parsed.vitals) ? parsed.vitals : [];
  if (vitals.length) {
    ensureSpace(doc, 80);
    sectionTitle(doc, "Vitals");
    const widths = [80, 60, 60, 60, 60, 60, 70];
    row(doc, ["Date", "BP", "Wt", "Ht", "BMI", "Waist", "Body Fat"], widths, {
      bold: true,
      color: MUTED,
      fontSize: 8,
    });
    for (const v of vitals) {
      ensureSpace(doc, 22);
      const bp = v.bpSys && v.bpDia ? `${v.bpSys}/${v.bpDia}` : "";
      row(
        doc,
        [
          v.date ? fmtDate(v.date) : "",
          bp,
          v.weight ?? "",
          v.height ?? "",
          v.bmi ?? "",
          v.waist ?? "",
          v.bodyFat ?? "",
        ],
        widths,
      );
    }
  }

  // ─── INVESTIGATIONS ORDERED ───────────────────────────────────────────
  const inv = Array.isArray(parsed.investigations_to_order) ? parsed.investigations_to_order : [];
  if (inv.length) {
    ensureSpace(doc, 60);
    sectionTitle(doc, "Tests / Investigations Ordered");
    for (const t of inv) {
      bullet(doc, `${t.name}${t.urgency ? ` — ${t.urgency}` : ""}`);
    }
  }

  // ─── LIFESTYLE ────────────────────────────────────────────────────────
  const ls = parsed.lifestyle || {};
  const lsEntries = ["diet", "exercise", "smoking", "alcohol", "stress"]
    .filter((k) => nonEmpty(ls[k]))
    .map((k) => [k[0].toUpperCase() + k.slice(1), ls[k]]);
  if (lsEntries.length) {
    ensureSpace(doc, 60);
    sectionTitle(doc, "Lifestyle");
    for (const [k, v] of lsEntries) kv(doc, `${k}:`, v);
  }

  // ─── FOLLOW-UP ────────────────────────────────────────────────────────
  const fu = parsed.follow_up || {};
  if (nonEmpty(fu.date) || nonEmpty(fu.timing) || nonEmpty(fu.notes)) {
    ensureSpace(doc, 50);
    sectionTitle(doc, "Follow-up");
    if (nonEmpty(fu.date)) kv(doc, "Date:", fmtDate(fu.date));
    if (nonEmpty(fu.timing)) kv(doc, "Timing:", fu.timing);
    if (nonEmpty(fu.notes)) kv(doc, "Notes:", fu.notes);
  }

  // ─── ADVICE ───────────────────────────────────────────────────────────
  if (nonEmpty(parsed.advice)) {
    ensureSpace(doc, 60);
    sectionTitle(doc, "Advice");
    doc.fillColor(TEXT).font("Helvetica").fontSize(10).text(String(parsed.advice), {
      indent: 8,
      paragraphGap: 2,
    });
  }

  // ─── FOOTER ───────────────────────────────────────────────────────────
  // Stamp on every page — must be done before doc.end()
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footY = doc.page.height - doc.page.margins.bottom + 14;
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `Created by Scribe · ${fmtDate(new Date())} · Page ${i - range.start + 1} of ${range.count}`,
        doc.page.margins.left,
        footY,
        {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          align: "center",
        },
      );
  }

  doc.end();
  return done;
}
