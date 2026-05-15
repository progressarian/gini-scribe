// Builds an HTML document that exactly matches gini-examples.html "Printed
// Prescription" layout. Used by the Puppeteer PDF generator. Keep CSS in
// sync with gini-examples.html (lines 9-115) when the design changes.

import {
  MED_CATEGORIES,
  groupMedicationsByCategory,
  getCategoryLabel,
  getCategoryIcon,
  detectMedCategory,
} from "../config/medicationCategories.js";

// Strip "healthray:<id>" markers (and any trailing dash separator) from notes
// so the printed Rx doesn't leak the upstream healthray reference. Mirrors
// the displayNote() helper used by VisitDiagnoses.jsx.
const cleanNote = (notes) => {
  if (!notes) return "";
  const trimmed = String(notes).trim();
  if (/^healthray:[\w-]+$/i.test(trimmed)) return "";
  if (/^healthray:[\w-]+\s*[—–-]+\s*$/i.test(trimmed)) return "";
  const m = trimmed.match(/^healthray:[\w-]+\s*[—–-]+\s*(.+)$/i);
  if (m) return m[1].trim();
  return trimmed.replace(/healthray:[\w-]+\s*[—–-]*\s*/gi, "").trim();
};

// Universal healthray-id scrubber — strips `healthray:<id>` (with or without
// a trailing dash separator) from any string before it reaches the page, so
// no upstream reference ID can leak into the printed Rx regardless of which
// field it slipped into (label, notes, detail, indication, dosage text, etc).
const stripHealthrayId = (s) => {
  if (s == null) return s;
  return String(s)
    .replace(/healthray:[\w-]+\s*[—–-]+\s*/gi, "")
    .replace(/healthray:[\w-]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s—–-]+|[\s—–-]+$/g, "");
};

const escape = (s) => {
  if (s == null) return "";
  return stripHealthrayId(String(s))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const STATUS_BADGE = {
  controlled: { bg: "#edfcf0", color: "#15803d", label: "Controlled" },
  improving: { bg: "#fef6e6", color: "#d97a0a", label: "Improving" },
  uncontrolled: { bg: "#fdf0f0", color: "#d94f4f", label: "Uncontrolled" },
  review: { bg: "#fef6e6", color: "#d97a0a", label: "Review" },
  monitoring: { bg: "#eff6ff", color: "#2563eb", label: "Monitoring" },
  stable: { bg: "#edfcf0", color: "#15803d", label: "Stable" },
  resolved: { bg: "#edfcf0", color: "#15803d", label: "Resolved" },
  active: { bg: "#fef6e6", color: "#d97a0a", label: "Active" },
};
const statusBadge = (status) => {
  const key = String(status || "").toLowerCase();
  return STATUS_BADGE[key] || { bg: "#f0f4f7", color: "#3d4f63", label: status || "" };
};

const valueColor = (val, goal, lowerBetter = true) => {
  if (val == null || goal == null) return "#1a2332";
  const v = Number(val);
  if (Number.isNaN(v)) return "#1a2332";
  const onTarget = lowerBetter ? v <= goal : v >= goal;
  const wayOff = lowerBetter ? v > goal * 1.3 : v < goal * 0.7;
  return onTarget ? "#15803d" : wayOff ? "#d94f4f" : "#d97a0a";
};

// Compact month-day label for the x-axis (e.g. "12 Mar"). Falls back to an
// empty string when the date is missing/unparseable so the chart row still
// aligns with the bars above.
const fmtSparkDate = (d) => {
  if (!d) return "";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "";
  return t.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};

// Build a 4-bar sparkline rendered chronologically (oldest → newest, left → right).
// labHistory comes newest-first from the visit endpoint, so reverse before slicing.
// Returns { bars, goalPct } so the renderer can draw a target line at the
// same vertical scale the bars use.
const buildSparkline = (history, goal, lowerBetter = true) => {
  if (!history || history.length === 0) return { bars: [], goalPct: null };
  const chronological = [...history].reverse();
  const entries = chronological
    .slice(-4)
    .map((h) => ({ value: Number(h.result ?? h.value), date: h.date || h.test_date }))
    .filter((e) => !Number.isNaN(e.value));
  if (entries.length === 0) return { bars: [], goalPct: null };
  // Scale bars on the spread between min/max (with a small floor) so visit-to-
  // visit changes are visually distinguishable, instead of all bars looking
  // nearly identical when values cluster (typical for weight/waist).
  const vals = entries.map((e) => e.value);
  const min = Math.min(...vals, goal != null ? goal : Infinity);
  const max = Math.max(...vals, goal != null ? goal : -Infinity);
  const span = Math.max(max - min, max * 0.15, 1);
  const heightPct = (v) => Math.max(20, Math.round(((v - min) / span) * 80) + 20);
  const bars = entries.map((e) => {
    let bg = "#d97a0a";
    if (goal != null) {
      const onTarget = lowerBetter ? e.value <= goal : e.value >= goal;
      const wayOff = lowerBetter ? e.value > goal * 1.3 : e.value < goal * 0.7;
      bg = onTarget ? "#15803d" : wayOff ? "#d94f4f" : "#d97a0a";
    }
    return {
      height: heightPct(e.value),
      bg,
      value: e.value,
      date: e.date,
      dateLabel: fmtSparkDate(e.date),
    };
  });
  const goalPct = goal != null ? Math.max(0, Math.min(100, heightPct(goal))) : null;
  return { bars, goalPct };
};

// First (oldest) reading from labHistory. labHistory is newest-first, so the
// last element is the oldest. Returns null when there's only one reading.
const firstReading = (history) => {
  if (!history || history.length < 2) return null;
  return history[history.length - 1];
};

// Find lab history by canonical name (case-insensitive, alias-tolerant)
const ALIASES = {
  hba1c: ["hba1c", "a1c", "glycated haemoglobin", "glycated hemoglobin"],
  fbs: ["fbs", "fasting blood sugar", "fasting glucose", "fpg"],
  ldl: ["ldl", "ldl cholesterol", "ldl-c"],
  triglycerides: ["triglycerides", "tg"],
  creatinine: ["creatinine", "serum creatinine"],
  uacr: ["uacr", "albumin/creatinine", "urine albumin"],
};
const findHist = (labHistory, key) => {
  if (!labHistory) return [];
  const aliases = ALIASES[key] || [key];
  for (const k of Object.keys(labHistory)) {
    const lk = k.toLowerCase();
    if (aliases.some((a) => lk.includes(a))) {
      const hist = labHistory[k];
      return Array.isArray(hist) ? hist : [];
    }
  }
  return [];
};
const findLatest = (labResults, key) => {
  if (!labResults) return null;
  const aliases = ALIASES[key] || [key];
  const arr = Array.isArray(labResults) ? labResults : Object.values(labResults).flat();
  for (const r of arr) {
    const nm = String(r.test_name || r.canonical_name || r.name || "").toLowerCase();
    if (aliases.some((a) => nm.includes(a))) return r;
  }
  return null;
};

const fmtDateLong = (d) => {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

const splitMeds = (activeMeds = []) => {
  // Belt-and-braces: drop any stopped meds even if the client forgot to filter
  const live = activeMeds.filter((m) => m.is_active !== false);
  const ownMeds = live.filter((m) => m.med_group !== "external" && !m.external_doctor);
  const externalMeds = live.filter((m) => m.med_group === "external" || !!m.external_doctor);
  return { ownMeds, externalMeds };
};

// Build a parent → children[] map so support / conditional medications render
// nested under their parent instead of as independent numbered rows.
const buildChildrenMap = (meds) => {
  const map = {};
  for (const m of meds) {
    if (m.parent_medication_id) {
      (map[m.parent_medication_id] ||= []).push(m);
    }
  }
  return map;
};

const splitTests = (tests = []) => {
  const referrals = tests.filter(
    (t) => typeof t === "object" && (t.referred_to || t.specialty || t.type === "referral"),
  );
  const labTests = tests.filter(
    (t) => typeof t === "string" || (!t.referred_to && !t.specialty && t.type !== "referral"),
  );
  return { referrals, labTests };
};

const doctorShortName = (name) => {
  if (!name) return "Doctor";
  const n = String(name)
    .replace(/^Dr\.?\s*/i, "")
    .trim();
  const parts = n.split(/\s+/);
  return `Dr. ${parts[parts.length - 1]}`;
};

const CSS = `
:root{
  --bg:#f0f4f7;--white:#fff;--ink:#1a2332;--ink2:#3d4f63;--ink3:#6b7d90;
  --bd:#dde3ea;--bd2:#c4cdd8;
  --tl:#009e8c;--tll:#e6f6f4;--tlb:rgba(0,158,140,.22);
  --nv:#0e2240;
  --re:#d94f4f;--rel:#fdf0f0;--reb:rgba(217,79,79,.18);
  --am:#d97a0a;--aml:#fef6e6;--amb:rgba(217,122,10,.18);
  --gn:#15803d;--gnl:#edfcf0;--gnb:rgba(21,128,61,.18);
  --sk:#2563eb;--skl:#eff6ff;
  --sh:0 1px 3px rgba(0,0,0,.08);
  --r:10px;--fb:'Outfit',sans-serif;--fd:'Instrument Serif',serif;--fm:'DM Mono',monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--fb);color:var(--ink);background:var(--white);font-size:13px}

.rx-page{background:var(--white);border:1px solid var(--bd);border-radius:var(--r);margin-bottom:16px;overflow:hidden}
.rx-header{background:var(--nv);padding:16px 22px;display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.rx-hosp-name{font-family:var(--fd);font-size:22px;color:#fff;font-style:italic}
.rx-hosp-tag{font-size:10px;color:rgba(255,255,255,.5);margin-top:2px}
.rx-doc{text-align:right}
.rx-doc-name{font-size:13px;font-weight:700;color:#fff}
.rx-doc-cred{font-size:10px;color:rgba(255,255,255,.5);line-height:1.6;margin-top:2px}
.rx-patient-bar{background:var(--bg);padding:10px 22px;display:flex;gap:20px;align-items:center;border-bottom:1px solid var(--bd);flex-wrap:wrap}
.rx-pt-name{font-size:14px;font-weight:700;color:var(--nv)}
.rx-pt-meta{font-size:11px;color:var(--ink3)}
.rx-pt-pills{display:flex;gap:5px;margin-left:auto;flex-wrap:wrap}
.rx-pill{font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px}
.rx-body{padding:18px 22px}

.rx-summary-block{background:var(--tll);border:1px solid var(--tlb);border-radius:7px;padding:10px 14px;margin-bottom:16px;font-size:12px;line-height:1.55;color:var(--ink)}
.rx-summary-block .sum-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--tl);margin:0 0 4px}
.rx-summary-block p{margin:0}
.rx-summary-block p+p{margin-top:6px}

.rx-section-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--ink3);margin-bottom:8px;margin-top:16px;padding-bottom:4px;border-bottom:1px solid var(--bd)}
.rx-med-cat{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;color:var(--ink2);text-transform:uppercase;letter-spacing:.08em;background:#f5f7fa;padding:4px 8px;border-left:3px solid var(--tl);margin:10px 0 2px}
.rx-med-cat-count{font-size:9px;font-weight:600;color:var(--ink3);text-transform:none;letter-spacing:0}
.rx-dx{display:flex;gap:10px;align-items:flex-start;margin-bottom:7px}
.rx-dx-num{font-family:var(--fm);font-size:11px;color:var(--ink3);flex-shrink:0;min-width:18px;padding-top:1px}
.rx-dx-body{flex:1}
.rx-dx-name{font-size:13px;font-weight:600;color:var(--ink)}
.rx-dx-detail{font-size:11px;color:var(--ink3);margin-top:1px}
.rx-dx-badge{font-size:9px;font-weight:700;padding:1px 7px;border-radius:4px;margin-left:7px}
.rx-dx-bio{font-size:11px;color:var(--ink2);font-weight:500}
.rx-dx-bio b{color:var(--ink);font-weight:700}
.rx-dx-bio .arrow-up{color:#dc2626;font-weight:700}
.rx-dx-bio .arrow-down{color:#16a34a;font-weight:700}
.rx-dx-bio .arrow-flat{color:#6b7280;font-weight:700}
.rx-dx-bio .meta{color:var(--ink3)}

.rx-goals{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:4px}
.rx-goal{background:var(--bg);border-radius:6px;padding:8px 10px;border-left:3px solid var(--tl)}
.rx-goal-label{font-size:10px;font-weight:700;color:var(--tl);margin-bottom:3px}
.rx-goal-val{font-family:var(--fm);font-size:12px;font-weight:500}
.rx-goal-current{font-size:10px;color:var(--ink3);margin-top:2px}

.rx-bio-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:4px}
.rx-bio{background:var(--bg);border-radius:8px;padding:10px 12px;border:1px solid var(--bd)}
.rx-bio-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px}
.rx-bio-name{font-size:10px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.04em}
.rx-bio-goal{font-size:9px;color:var(--ink3);font-weight:600}
.rx-bio-val{font-family:var(--fm);font-size:18px;font-weight:600;line-height:1.1}
.rx-bio-trend{font-size:10px;margin-top:2px;font-weight:600}
.rx-bio-trend .arrow{font-weight:700;margin-right:2px}
.rx-bio-chart{margin-top:8px;padding-top:14px;border-top:1px dashed var(--bd2)}
.rx-bio-sparkline{display:flex;gap:6px;align-items:flex-end;height:38px;position:relative}
.sp-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;position:relative;z-index:1}
.sp-val{font-family:var(--fm);font-size:8.5px;font-weight:600;color:var(--ink2);position:absolute;top:-12px;white-space:nowrap}
.sp-bar{width:100%;max-width:14px;border-radius:2px 2px 0 0;min-height:3px}
.sp-col.latest .sp-val{color:var(--ink);font-weight:700}
.sp-col.latest .sp-bar{box-shadow:0 0 0 1.5px var(--nv)}
.sp-goal{position:absolute;left:0;right:0;height:0;border-top:1px dashed #1a233266;z-index:0;pointer-events:none}
.sp-goal-tag{position:absolute;right:-2px;top:-7px;font-family:var(--fm);font-size:7.5px;font-weight:700;color:var(--ink2);background:var(--bg);padding:0 3px;border-radius:2px;letter-spacing:.02em}
.sp-trend-svg{position:absolute;left:0;right:0;top:0;bottom:0;width:100%;height:100%;z-index:0;pointer-events:none;overflow:visible}
.sp-dates{display:flex;gap:6px;margin-top:3px}
.sp-date{flex:1;text-align:center;font-family:var(--fm);font-size:7.5px;font-weight:500;color:var(--ink3);white-space:nowrap;letter-spacing:0}
.sp-dates .sp-date.latest{color:var(--ink);font-weight:700}

.rx-med{display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--bg)}
.rx-med:last-child{border:none}
.rx-med-num{font-family:var(--fm);font-size:11px;color:var(--ink3);flex-shrink:0;min-width:20px;padding-top:2px}
.rx-med-body{flex:1}
.rx-med-name{font-size:13px;font-weight:700;color:var(--ink)}
.rx-med-brand{font-size:11px;color:var(--ink3)}
.rx-med-right{text-align:right;flex-shrink:0}
.rx-med-dose{font-family:var(--fm);font-size:12px;font-weight:500}
.rx-med-timing{font-size:11px;color:var(--ink3)}
.rx-ext-badge{font-size:9px;background:var(--skl);color:var(--sk);font-weight:700;padding:1px 6px;border-radius:4px;margin-left:6px}
.rx-med-sub{padding-left:38px;background:#fafbfc;border-bottom:none;border-left:3px solid var(--tl);margin-left:14px}
.rx-med-sub .rx-med-name{font-size:12px;font-weight:600}
.rx-med-sub .rx-med-arrow{color:var(--ink3);margin-right:6px;font-size:13px}
.rx-sub-badge{font-size:9px;background:#eef2ff;color:#4338ca;font-weight:700;padding:1px 6px;border-radius:4px;margin-left:6px}
.rx-cat-badge{font-size:9px;background:#f1f5f9;color:#475569;font-weight:700;padding:1px 6px;border-radius:4px;margin-left:10px;border:1px solid #e2e8f0}
.rx-med-group-header{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#f8fafc;border-bottom:1px solid var(--bd)}
.rx-med-group-label{font-size:10px;font-weight:700;color:var(--ink2);text-transform:uppercase;letter-spacing:.05em}
.rx-med-group-count{font-size:10px;color:var(--ink3)}
.rx-sub-cond{font-size:10px;color:var(--ink3);margin-top:1px;font-style:italic}

.rx-ref-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.rx-ref{background:var(--skl);border-radius:6px;padding:9px 11px;border-left:3px solid var(--sk)}
.rx-ref-title{font-size:10px;font-weight:700;color:var(--sk);margin-bottom:4px}
.rx-ref-body{font-size:12px;color:var(--ink);line-height:1.5}
.rx-test{background:var(--aml);border-radius:6px;padding:9px 11px;border-left:3px solid var(--am)}
.rx-test-title{font-size:10px;font-weight:700;color:var(--am);margin-bottom:4px}
.rx-test-item{font-size:12px;color:var(--ink);padding:2px 0;display:flex;gap:6px}

.rx-footer{background:var(--bg);border-top:1px solid var(--bd);padding:10px 22px;display:flex;justify-content:space-between;align-items:center}
.rx-sig{font-size:11px;color:var(--ink3)}
.rx-next{font-size:11px;font-weight:700;color:var(--nv)}

@page{size:A4;margin:0}
`;

function buildPrescriptionHtml(data = {}) {
  const {
    patient = {},
    doctor = {},
    summary = {},
    visitSummaryText: visitSummaryTextOverride,
    activeDx = [],
    activeMeds = [],
    latestVitals = {},
    prevVitals = {},
    vitalsHistory = [],
    labResults = [],
    labHistory = {},
    consultations = [],
    goals = [],
    appt_plan = null,
  } = data;

  const today = new Date().toISOString().split("T")[0];
  const latestCon = consultations?.[0]?.con_data || {};
  // Mirror VisitPlan.jsx: only use the consultation follow_up when it actually
  // carries a date — otherwise fall through to the appointment-level follow_up
  // (sourced from biomarkers.followup) so the printed Rx matches the UI chip.
  const followUp =
    (latestCon.follow_up?.date ? latestCon.follow_up : null) ||
    appt_plan?.follow_up ||
    latestCon.follow_up ||
    {};
  const tests = latestCon.investigations_to_order || latestCon.tests_ordered || [];
  // FOLLOW UP WITH — free-text patient instructions for the next visit
  // (fasting / tests to bring / preparations). Captured from prescription
  // extraction or set inline on /visit. Printed as a dedicated section so the
  // patient leaves the clinic with these instructions on paper.
  const followUpWith =
    typeof latestCon.follow_up_with === "string" && latestCon.follow_up_with.trim()
      ? latestCon.follow_up_with.trim()
      : "";
  // Prefer the explicit visit summary the client passes in (current doctor's
  // summary or visit-level synopsis) over anything found on the consultation
  // record. Falls back to summary.summary so old callers still work.
  const visitSummaryText =
    visitSummaryTextOverride ||
    latestCon.summary ||
    latestCon.visit_summary ||
    summary.summary ||
    "";

  // ── Lab values (latest)
  const hba1c = findLatest(labResults, "hba1c");
  const fbs = findLatest(labResults, "fbs");
  const ldl = findLatest(labResults, "ldl");
  const tg = findLatest(labResults, "triglycerides");
  const creatinine = findLatest(labResults, "creatinine");
  const uacr = findLatest(labResults, "uacr");
  const tsh = findLatest(labResults, "tsh");
  const egfr = findLatest(labResults, "egfr");
  const alt = findLatest(labResults, "alt");

  // ── Condition flags from active diagnoses ─────────────────────────
  // Same keyword match used by VisitBiomarkers — keeps the prescription
  // and the visit page in agreement on which conditions the patient has.
  const dxText = (activeDx || [])
    .filter((d) => d && d.is_active !== false)
    .map((d) => `${d.diagnosis_id || ""} ${d.label || ""}`.toLowerCase())
    .join(" | ");
  const has = (words) => words.some((w) => dxText.includes(w));
  const dx = {
    diabetes: has(["diabetes", "dm1", "dm2", "t1dm", "t2dm", "prediabetes", "hyperglycemia"]),
    htn: has(["hypertension", "htn", "hypertensive"]),
    cad: has(["cad", "coronary", "ihd", "cvd", "cva", "atherosclero"]),
    ckd: has(["ckd", "kidney", "renal", "nephropathy", "albuminuria"]),
    lipid: has(["dyslipid", "hyperlipid", "cholesterol", "lipid"]),
    thyroid: has(["thyroid", "hypothyroid", "hyperthyroid", "hashimoto", "graves", "goiter"]),
    obesity: has(["obesity", "obese", "overweight", "adiposity", "metabolic syndrome"]),
    liver: has(["nafld", "masld", "fatty liver", "hepatitis", "cirrhosis"]),
  };

  const { ownMeds, externalMeds } = splitMeds(activeMeds);
  const { referrals, labTests } = splitTests(tests);

  // ── Build vitals history for a single field (newest → oldest), trimmed to
  // rows that actually carry a value. Mirrors the lab-history shape so the
  // sparkline / first-reading helpers can be reused.
  const vitalsHistFor = (field) => {
    if (!Array.isArray(vitalsHistory) || vitalsHistory.length === 0) return [];
    return vitalsHistory
      .filter((v) => v && v[field] != null && v[field] !== "")
      .map((v) => ({ result: Number(v[field]), date: v.recorded_at }))
      .filter((v) => !Number.isNaN(v.result));
  };

  const weightHist = vitalsHistFor("weight");
  const waistHist = vitalsHistFor("waist");

  // ── Biomarker cards
  // Each candidate card is tagged with the conditions it tracks. Cards whose
  // conditions match the patient's active diagnoses get a relevance boost so
  // they bubble to the top of the printed grid — e.g. a thyroid patient's Rx
  // shows TSH, a CKD patient's Rx shows eGFR + UACR, even when those values
  // would otherwise have been crowded out by the default lipid/glucose set.
  const candidates = [
    hba1c && {
      label: "HbA1c (%)",
      val: hba1c.result,
      sparks: buildSparkline(findHist(labHistory, "hba1c"), 7.0, true),
      goal: 7.0,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "hba1c")),
      tracks: ["diabetes"],
      defaultOrder: 1,
    },
    fbs && {
      label: "FBS (mg/dL)",
      val: fbs.result,
      sparks: buildSparkline(findHist(labHistory, "fbs"), 100, true),
      goal: 100,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "fbs")),
      tracks: ["diabetes"],
      defaultOrder: 2,
    },
    latestVitals?.bp_sys && {
      label: "BP (mmHg)",
      val: `${latestVitals.bp_sys}/${latestVitals.bp_dia}`,
      raw: latestVitals.bp_sys,
      sparks: prevVitals?.bp_sys
        ? buildSparkline(
            [{ result: prevVitals.bp_sys }, { result: latestVitals.bp_sys }],
            130,
            true,
          )
        : { bars: [], goalPct: null },
      goal: 130,
      lowerBetter: true,
      tracks: ["htn", "cad", "ckd"],
      defaultOrder: 3,
    },
    ldl && {
      label: "LDL (mg/dL)",
      val: ldl.result,
      sparks: buildSparkline(findHist(labHistory, "ldl"), 100, true),
      goal: 100,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "ldl")),
      tracks: ["lipid", "cad"],
      defaultOrder: 4,
    },
    tg && {
      label: "TG (mg/dL)",
      val: tg.result,
      sparks: buildSparkline(findHist(labHistory, "triglycerides"), 150, true),
      goal: 150,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "triglycerides")),
      tracks: ["lipid", "cad"],
      defaultOrder: 5,
    },
    egfr && {
      label: "eGFR (mL/min)",
      val: egfr.result,
      sparks: buildSparkline(findHist(labHistory, "egfr"), 90, false),
      goal: 90,
      lowerBetter: false,
      first: firstReading(findHist(labHistory, "egfr")),
      tracks: ["ckd"],
      defaultOrder: 6,
    },
    creatinine && {
      label: "Creatinine",
      val: creatinine.result,
      sparks: buildSparkline(findHist(labHistory, "creatinine"), null, true),
      lowerBetter: true,
      tracks: ["ckd"],
      defaultOrder: 7,
    },
    uacr && {
      label: "UACR (mg/g)",
      val: uacr.result,
      sparks: buildSparkline(findHist(labHistory, "uacr"), 30, true),
      goal: 30,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "uacr")),
      tracks: ["ckd", "diabetes"],
      defaultOrder: 8,
    },
    tsh && {
      label: "TSH (µIU/mL)",
      val: tsh.result,
      sparks: buildSparkline(findHist(labHistory, "tsh"), 4.5, true),
      goal: 4.5,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "tsh")),
      tracks: ["thyroid"],
      defaultOrder: 9,
    },
    alt && {
      label: "ALT (U/L)",
      val: alt.result,
      sparks: buildSparkline(findHist(labHistory, "alt"), 40, true),
      goal: 40,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "alt")),
      tracks: ["liver", "obesity"],
      defaultOrder: 10,
    },
    latestVitals?.weight && {
      label: "Weight (kg)",
      val: latestVitals.weight,
      sparks: buildSparkline(weightHist, null, true),
      lowerBetter: true,
      first: firstReading(weightHist),
      tracks: ["obesity", "diabetes"],
      defaultOrder: 11,
    },
    latestVitals?.waist && {
      label: "Waist (cm)",
      val: latestVitals.waist,
      sparks: buildSparkline(waistHist, 90, true),
      goal: 90,
      lowerBetter: true,
      first: firstReading(waistHist),
      tracks: ["obesity"],
      defaultOrder: 12,
    },
    latestVitals?.bmi && {
      label: "BMI",
      val: latestVitals.bmi,
      sparks: buildSparkline(vitalsHistFor("bmi"), 25, true),
      goal: 25,
      lowerBetter: true,
      first: firstReading(vitalsHistFor("bmi")),
      tracks: ["obesity", "diabetes"],
      defaultOrder: 13,
    },
  ].filter(Boolean);

  // Rank: condition-relevant cards first, ties broken by clinical order.
  // A card is "relevant" when any of its `tracks` matches an active dx.
  const relevance = (c) => ((c.tracks || []).some((t) => dx[t]) ? 1 : 0);
  const biomarkerCards = candidates
    .map((c, i) => ({ ...c, _r: relevance(c), _i: i }))
    .sort((a, b) => b._r - a._r || a.defaultOrder - b.defaultOrder)
    .slice(0, 6);

  // ── Patient meta line
  const patientMeta = [
    patient.age ? `${patient.age} yrs` : null,
    patient.sex,
    patient.file_no || patient.id,
    fmtDateLong(today),
    summary.totalVisits ? `Visit ${summary.totalVisits}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const monthsLabel =
    summary.monthsWithGini != null
      ? summary.monthsWithGini >= 12
        ? `${Math.floor(summary.monthsWithGini / 12)}+ years on programme`
        : `${summary.monthsWithGini} months on programme`
      : null;

  // ── Doctor cred lines (qualification only; reg_no goes in footer)
  const credLines = [];
  if (doctor.qualification) credLines.push(escape(doctor.qualification));
  if (doctor.designation) credLines.push(escape(doctor.designation));
  const docCredHtml = credLines.join("<br>");

  // ── Biomarker tag for a diagnosis. Renders a rich line like
  //   "HbA1c 7.4% (↓ from 9.8% · target ≤ 7%)"
  // showing current value, the change arrow vs. the oldest reading, the
  // baseline value, and the clinical target (when one is defined).
  const findBioHistory = (names, limit = 6) => {
    if (!labResults?.length) return [];
    const out = [];
    for (const l of labResults) {
      if (l.result == null) continue;
      const cn = String(l.canonical_name || "").toLowerCase();
      const tn = String(l.test_name || "").toLowerCase();
      if (names.some((n) => cn === n.toLowerCase() || tn === n.toLowerCase())) {
        const v = parseFloat(l.result);
        if (!Number.isNaN(v)) out.push({ value: v, date: l.test_date });
      }
      if (out.length >= limit) break;
    }
    return out;
  };
  // Format a numeric value with up to 1 decimal place, dropping trailing zeros.
  const fmtNum = (v) => {
    if (v == null || Number.isNaN(Number(v))) return String(v ?? "");
    const n = Number(v);
    if (Number.isInteger(n)) return String(n);
    return Number(n.toFixed(1)).toString();
  };
  // Build the rich tag HTML for one biomarker.
  //   label  e.g. "HbA1c"
  //   unit   e.g. "%", " mg/dL", "" (include leading space if needed)
  //   curr   current value (number)
  //   first  baseline value (oldest known) — null if no history
  //   target string like "≤ 7%" — null to omit
  //   lowerIsBetter — direction for arrow color
  const renderBio = (label, unit, curr, first, target, lowerIsBetter = true) => {
    const cur = Number(curr);
    let arrowHtml = "";
    let metaParts = [];
    if (first != null && !Number.isNaN(Number(first))) {
      const f = Number(first);
      const diff = cur - f;
      const pct = Math.abs(diff / (f || 1)) * 100;
      if (pct < 3) {
        arrowHtml = `<span class="arrow-flat">→</span>`;
      } else {
        const improving = lowerIsBetter ? diff < 0 : diff > 0;
        const arrow = improving ? "↓" : "↑";
        arrowHtml = `<span class="${improving ? "arrow-down" : "arrow-up"}">${arrow}</span>`;
      }
      metaParts.push(`${arrowHtml} from ${escape(fmtNum(f))}${escape(unit)}`);
    }
    if (target) metaParts.push(`target ${escape(target)}`);
    const meta = metaParts.length ? ` <span class="meta">(${metaParts.join(" · ")})</span>` : "";
    return `<span class="rx-dx-bio"><b>${escape(label)} ${escape(fmtNum(cur))}${escape(unit)}</b>${meta}</span>`;
  };

  const bioTagFor = (dx) => {
    const id = String(dx.diagnosis_id || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const lbl = String(dx.label || "").toLowerCase();
    const text = `${id} ${lbl}`;
    const tags = [];
    const oldestOf = (h) => (h.length >= 2 ? h[h.length - 1].value : null);

    if (text.includes("dm2") || text.includes("dm1") || text.includes("diabetes")) {
      const h = findBioHistory(["HbA1c", "Glycated Hemoglobin", "A1c", "HBA1C"]);
      const f = findBioHistory(["FBS", "Fasting Glucose", "Fasting Blood Sugar", "FPG"]);
      if (h.length > 0) {
        tags.push(renderBio("HbA1c", "%", h[0].value, oldestOf(h), "≤ 7%", true));
      }
      if (f.length > 0) {
        tags.push(renderBio("FBS", " mg/dL", f[0].value, oldestOf(f), "≤ 130 mg/dL", true));
      }
      if (tags.length) return tags;
    }
    if (text.includes("nephropathy")) {
      const h = findBioHistory(["UACR", "Urine ACR", "Microalbumin"]);
      if (h.length > 0) {
        return [renderBio("UACR", " mg/g", h[0].value, oldestOf(h), "< 30 mg/g", true)];
      }
    }
    if (text.includes("htn") || text.includes("hypertension")) {
      const sys = latestVitals?.bp_sys || latestVitals?.bpSys;
      const dia = latestVitals?.bp_dia || latestVitals?.bpDia;
      if (sys) {
        return [
          `<span class="rx-dx-bio"><b>BP ${escape(sys)}/${escape(dia || "?")} mmHg</b> <span class="meta">(target ≤ 130/80)</span></span>`,
        ];
      }
    }
    if (text.includes("lipid") || text.includes("dyslipid") || text.includes("cholesterol")) {
      const h = findBioHistory(["LDL", "LDL Cholesterol", "LDL-C", "LDL CHOLESTEROL-DIRECT"]);
      if (h.length > 0) {
        return [renderBio("LDL", " mg/dL", h[0].value, oldestOf(h), "≤ 100 mg/dL", true)];
      }
    }
    if (text.includes("thyroid") || text.includes("hypo")) {
      const h = findBioHistory(["TSH", "Thyroid Stimulating Hormone"]);
      if (h.length > 0) {
        return [renderBio("TSH", " mIU/L", h[0].value, oldestOf(h), "0.5–4.5 mIU/L", true)];
      }
    }
    if (text.includes("obesity") || text.includes("adiposity") || text.includes("bmi")) {
      const bmi = latestVitals?.bmi;
      const wt = latestVitals?.weight;
      if (bmi) {
        tags.push(
          `<span class="rx-dx-bio"><b>BMI ${escape(fmtNum(bmi))}</b> <span class="meta">(target &lt; 25)</span></span>`,
        );
      }
      if (wt) tags.push(`<span class="rx-dx-bio"><b>${escape(fmtNum(wt))} kg</b></span>`);
      if (tags.length) return tags;
    }
    if (text.includes("nafld") || text.includes("masld") || text.includes("fatty liver")) {
      const alt = findBioHistory(["ALT", "SGPT"]);
      if (alt.length > 0) {
        return [renderBio("ALT", " U/L", alt[0].value, oldestOf(alt), "≤ 40 U/L", true)];
      }
    }
    if (text.includes("ckd") || text.includes("kidney")) {
      const eg = findBioHistory(["eGFR", "Estimated GFR"]);
      const cr = findBioHistory(["Creatinine", "Serum Creatinine"]);
      if (eg.length > 0) {
        tags.push(renderBio("eGFR", " mL/min", eg[0].value, oldestOf(eg), "≥ 60 mL/min", false));
      }
      if (cr.length > 0) {
        tags.push(renderBio("Cr", " mg/dL", cr[0].value, oldestOf(cr), null, true));
      }
      if (tags.length) return tags;
    }
    return null;
  };

  // ── Diagnoses HTML
  //   Title row : "<Name> (Since YYYY · Age of onset: N yrs)  [STATUS]"
  //   Sub line  : "<Bio> (↓ from <baseline> · target <target>) · <Bio2> (...)"
  // Mirrors the visit-page presentation: meta details inline with the name,
  // biomarker readings with arrows + targets on a single sub-line below.
  const dxHtml = activeDx
    .map((d, i) => {
      const badge = statusBadge(d.status);
      const metaParts = [];
      if (d.since_year) metaParts.push(`Since ${escape(d.since_year)}`);
      if (d.age_of_onset) metaParts.push(`Age of onset: ${escape(d.age_of_onset)} yrs`);
      const cleanedNotes = cleanNote(d.notes);
      if (cleanedNotes) metaParts.push(escape(cleanedNotes));
      const cleanedDetail = cleanNote(d.detail);
      if (cleanedDetail) metaParts.push(escape(cleanedDetail));
      const metaHtml = metaParts.length
        ? `<span style="font-weight:400;color:var(--ink3);margin-left:6px">(${metaParts.join(" · ")})</span>`
        : "";
      const bios = bioTagFor(d) || [];
      const bioLine = bios.join(' <span style="color:var(--bd2);margin:0 4px">·</span> ');
      return `
        <div class="rx-dx">
          <div class="rx-dx-num">${i + 1}.</div>
          <div class="rx-dx-body">
            <div class="rx-dx-name">${escape(d.label || d.diagnosis_id || "")}${metaHtml}${
              d.status
                ? `<span class="rx-dx-badge" style="background:${badge.bg};color:${badge.color}">${escape(badge.label)}</span>`
                : ""
            }</div>
            ${bioLine ? `<div class="rx-dx-detail">${bioLine}</div>` : ""}
          </div>
        </div>`;
    })
    .join("");

  // ── Goals HTML
  const goalsHtml = goals
    .map((g) => {
      const targetNum = parseFloat(g.target_value);
      const currentNum = parseFloat(g.current_value);
      const color = !Number.isNaN(targetNum) ? valueColor(currentNum, targetNum, true) : "#d97a0a";
      return `
        <div class="rx-goal">
          <div class="rx-goal-label">${escape(g.marker || "")}</div>
          <div class="rx-goal-val" style="color:${color}">${escape(g.target_value || "")}</div>
          ${
            g.current_value != null
              ? `<div class="rx-goal-current">Today: ${escape(g.current_value)}</div>`
              : ""
          }
        </div>`;
    })
    .join("");

  // ── Biomarker grid HTML
  // Card layout: header row with marker name + goal pill, then the current
  // value (color-coded vs target), a one-line trend vs first visit, and a
  // mini chart with each visit's value labeled directly above its bar so
  // the doctor can read trends at a glance instead of decoding bar heights.
  const fmtBioNum = (v) => {
    if (v == null || Number.isNaN(Number(v))) return String(v ?? "");
    const n = Number(v);
    if (Number.isInteger(n)) return String(n);
    return Number(n.toFixed(1)).toString();
  };
  const bioHtml = biomarkerCards
    .map((b) => {
      const numVal = b.raw != null ? b.raw : parseFloat(b.val);
      const color = valueColor(numVal, b.goal, b.lowerBetter);
      let trendText = "";
      let trendColor = "#6b7d90";
      if (b.first?.result != null) {
        const f = Number(b.first.result);
        const c = Number(numVal);
        if (!Number.isNaN(f) && !Number.isNaN(c) && f !== c) {
          const improving = b.lowerBetter ? c < f : c > f;
          const arrow = c < f ? "↓" : "↑";
          trendText = `<span class="arrow">${arrow}</span>from ${fmtBioNum(f)} at first visit`;
          trendColor = improving ? "#15803d" : "#d94f4f";
        }
      } else if (b.goal != null && !Number.isNaN(Number(numVal))) {
        const onTarget = b.lowerBetter ? numVal <= b.goal : numVal >= b.goal;
        trendText = onTarget ? "● at target" : "● needs work";
        trendColor = onTarget ? "#15803d" : "#d94f4f";
      }
      // sparks is now { bars, goalPct } — bars[] keep value/date/colour and
      // goalPct positions the dashed target line on the same y-scale used
      // for bar heights, so "above/below goal" is visible at a glance.
      const sparkObj = b.sparks || {};
      const bars = Array.isArray(sparkObj) ? sparkObj : sparkObj.bars || [];
      const goalPct = Array.isArray(sparkObj) ? null : sparkObj.goalPct;
      const sparksHtml = bars
        .map((s, i) => {
          const isLatest = i === bars.length - 1;
          return `<div class="sp-col${isLatest ? " latest" : ""}">
            <div class="sp-val">${escape(fmtBioNum(s.value))}</div>
            <div class="sp-bar" style="height:${s.height}%;background:${s.bg}"></div>
          </div>`;
        })
        .join("");
      // Trend connector: thin line linking the tops of consecutive bars.
      // Drawn in SVG with viewBox 0–100 / 0–100 so the polyline scales to
      // whatever pixel size the chart ends up at. y is inverted (SVG 0 = top,
      // bar height 0 = bottom) so we use 100 - height%.
      let trendSvg = "";
      if (bars.length >= 2) {
        const stepX = 100 / bars.length;
        const points = bars.map((s, i) => `${(i + 0.5) * stepX},${100 - s.height}`).join(" ");
        trendSvg = `<svg class="sp-trend-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline points="${points}" fill="none" stroke="#1a2332" stroke-opacity="0.45" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        </svg>`;
      }
      // Goal line (dashed). Shown only when we have a numeric goal AND any
      // bars to anchor it against.
      const goalLineHtml =
        goalPct != null && bars.length > 0
          ? `<div class="sp-goal" style="bottom:${goalPct}%"><span class="sp-goal-tag">${b.lowerBetter ? "≤" : "≥"} ${escape(fmtBioNum(b.goal))}</span></div>`
          : "";
      // Per-bar date row, kept in a separate flex strip below the chart so
      // dates stay aligned with their bar even when columns flex.
      const datesHtml =
        bars.length > 0
          ? `<div class="sp-dates">${bars
              .map(
                (s, i) =>
                  `<div class="sp-date${i === bars.length - 1 ? " latest" : ""}">${escape(s.dateLabel || "")}</div>`,
              )
              .join("")}</div>`
          : "";
      const goalLabel =
        b.goal != null
          ? `<span class="rx-bio-goal">Goal ${b.lowerBetter ? "≤" : "≥"} ${escape(fmtBioNum(b.goal))}</span>`
          : "";
      return `
        <div class="rx-bio">
          <div class="rx-bio-head">
            <span class="rx-bio-name">${escape(b.label)}</span>
            ${goalLabel}
          </div>
          <div class="rx-bio-val" style="color:${color}">${escape(b.val)}</div>
          ${trendText ? `<div class="rx-bio-trend" style="color:${trendColor}">${trendText}</div>` : ""}
          ${
            sparksHtml
              ? `<div class="rx-bio-chart">
                  <div class="rx-bio-sparkline">
                    ${trendSvg}
                    ${goalLineHtml}
                    ${sparksHtml}
                  </div>
                  ${datesHtml}
                </div>`
              : ""
          }
        </div>`;
    })
    .join("");

  // ── Render a child support medicine row (no number, indented, badge + condition)
  const renderChildMed = (child, parentName) => {
    const childPrimary = child.composition || child.name;
    return `
        <div class="rx-med rx-med-sub">
          <div class="rx-med-num"></div>
          <div class="rx-med-body">
            <div class="rx-med-name"><span class="rx-med-arrow">↳</span>${escape(childPrimary || "")}<span class="rx-sub-badge">SUPPORT</span></div>
            <div class="rx-sub-cond">${escape(child.support_condition || `for ${parentName}`)}</div>
          </div>
          <div class="rx-med-right">
            <div class="rx-med-dose">${escape(child.dose || child.dosage || child.frequency || "—")}</div>
            <div class="rx-med-timing">${escape(child.timing || "")}</div>
            ${child.instructions ? `<div class="rx-med-timing">${escape(child.instructions)}</div>` : ""}
          </div>
        </div>`;
  };

  // ── Own medicines (grouped by clinical category)
  const ownChildrenByParent = buildChildrenMap(ownMeds);
  const ownIds = new Set(ownMeds.map((m) => m.id).filter((x) => x != null));
  // Top-level: rows without a parent + children whose parent is not in this
  // group (orphans must still print, not vanish).
  const ownParents = ownMeds.filter(
    (m) => !m.parent_medication_id || !ownIds.has(m.parent_medication_id),
  );

  // Renders one numbered medicine row; counter is passed in so numbering stays
  // continuous across category sections.
  const renderOwnMedRow = (m, num) => {
    const primary = m.composition || m.name;
    const secondary = m.composition && m.name && m.name !== m.composition ? m.name : null;
    const isNew = !!m.is_new;
    const rowStyle = isNew
      ? `style="background:var(--gnl);padding:8px 10px;border-radius:6px;margin-bottom:2px;border-bottom:none"`
      : "";
    const tag = isNew
      ? `<span style="font-weight:400;font-size:11px;color:var(--gn)">🆕 New this visit</span>`
      : secondary
        ? `<span style="font-weight:400;font-size:11px;color:var(--ink3)">(${escape(secondary)})</span>`
        : "";
    const indication = Array.isArray(m.for_diagnosis)
      ? m.for_diagnosis.join(", ")
      : m.for_diagnosis || m.indication || m.purpose || "";
    const childrenHtml = (ownChildrenByParent[m.id] || [])
      .map((c) => renderChildMed(c, primary || ""))
      .join("");
    return `
        <div class="rx-med" ${rowStyle}>
          <div class="rx-med-num">${num}.</div>
          <div class="rx-med-body">
            <div class="rx-med-name">${escape(primary || "")} ${tag}</div>
            ${indication ? `<div class="rx-med-brand">${escape(indication)}</div>` : ""}
          </div>
          <div class="rx-med-right">
            <div class="rx-med-dose">${escape(m.dose || m.dosage || m.frequency || "—")}</div>
            <div class="rx-med-timing">${escape(m.timing || "")}</div>
            ${m.instructions ? `<div class="rx-med-timing">${escape(m.instructions)}</div>` : ""}
          </div>
        </div>${childrenHtml}`;
  };

  // Meds sorted by category rank, rendered under one section header per
  // non-empty category — mirrors the in-app medications view so the printed
  // Rx visually groups the same way the doctor saw it on screen.
  const ownByCategory = groupMedicationsByCategory(ownParents);
  let medCounter = 0;
  const ownMedsHtml = MED_CATEGORIES.filter(
    (c) => c.id !== "external" && (ownByCategory[c.id] || []).length > 0,
  )
    .map((cat, idx) => {
      const meds = ownByCategory[cat.id];
      const header = `
        <div class="rx-med-group-header" style="margin-top:${idx === 0 ? 0 : 8}px">
          <span class="rx-med-group-label">${cat.icon} ${escape(cat.label)}</span>
          <span class="rx-med-group-count">(${meds.length})</span>
        </div>`;
      const rows = meds
        .map((m) => {
          medCounter += 1;
          return renderOwnMedRow(m, medCounter);
        })
        .join("");
      return header + rows;
    })
    .join("");

  // ── External medicines
  const extChildrenByParent = buildChildrenMap(externalMeds);
  const extIds = new Set(externalMeds.map((m) => m.id).filter((x) => x != null));
  const extParents = externalMeds.filter(
    (m) => !m.parent_medication_id || !extIds.has(m.parent_medication_id),
  );
  const extMedsHtml = extParents
    .map((m) => {
      const primary = m.composition || m.name;
      const by = m.external_doctor
        ? `Prescribed by ${escape(m.external_doctor)}`
        : "Prescribed by external doctor";
      const childrenHtml = (extChildrenByParent[m.id] || [])
        .map((c) => renderChildMed(c, primary || ""))
        .join("");
      return `
        <div class="rx-med" style="background:var(--skl);padding:8px 10px;border-radius:6px;border-bottom:none">
          <div class="rx-med-num">—</div>
          <div class="rx-med-body">
            <div class="rx-med-name">${escape(primary || "")} <span class="rx-ext-badge">External</span></div>
            <div class="rx-med-brand">${by} · Do not modify</div>
          </div>
          <div class="rx-med-right">
            <div class="rx-med-dose">${escape(m.dose || m.dosage || m.frequency || "—")}</div>
            <div class="rx-med-timing">${escape(m.timing || "")}</div>
            ${m.instructions ? `<div class="rx-med-timing">${escape(m.instructions)}</div>` : ""}
          </div>
        </div>${childrenHtml}`;
    })
    .join("");

  // ── Referrals
  const referralsHtml =
    referrals.length > 0
      ? `<div class="rx-ref-grid">${referrals
          .map((r) => {
            const title = `${r.icon || "🩺"} ${escape(r.specialty || r.name || "Referral")}`;
            const body = [
              r.referred_to ? `Referred to ${escape(r.referred_to)}` : "",
              r.reason || r.note ? escape(r.reason || r.note) : "",
            ]
              .filter(Boolean)
              .join("<br>");
            return `
              <div class="rx-ref">
                <div class="rx-ref-title">${title}</div>
                <div class="rx-ref-body">${body}</div>
              </div>`;
          })
          .join("")}</div>`
      : "";

  // ── Lab tests grid
  const labTestsHtml =
    labTests.length > 0
      ? `<div class="rx-test" style="margin-top:${referrals.length > 0 ? 8 : 0}px">
          <div class="rx-test-title">🔬 Bring these reports to next visit${
            followUp.duration ? ` (${escape(followUp.duration)})` : ""
          }</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-top:4px">
            ${labTests
              .map((t) => {
                const name = typeof t === "string" ? t : t.name || t.test || "";
                return `<div class="rx-test-item"><span>·</span><span>${escape(name)}</span></div>`;
              })
              .join("")}
          </div>
        </div>`
      : "";

  // ── FOLLOW UP WITH — dedicated printed section, preserves line breaks
  const followUpWithHtml = followUpWith
    ? `<div class="rx-test" style="margin-top:8px;background:#fff7ed;border:1px solid #fed7aa">
          <div class="rx-test-title" style="color:#7c2d12">📋 Follow up with</div>
          <div style="margin-top:4px;font-size:12px;color:#7c2d12;white-space:pre-line;line-height:1.5">${escape(
            followUpWith,
          )}</div>
        </div>`
    : "";

  // ── Pills
  const phasePill = summary.carePhase
    ? `<span class="rx-pill" style="background:var(--aml);color:var(--am)">${escape(summary.carePhase)}</span>`
    : "";
  const monthsPill = monthsLabel
    ? `<span class="rx-pill" style="background:var(--tll);color:var(--tl)">${escape(monthsLabel)}</span>`
    : "";

  // ── Footer next-visit text
  const nextVisitText = followUp.date
    ? `📅 Next visit: ${fmtDateLong(followUp.date)}${labTests.length > 0 ? " · Come with all reports above" : ""}`
    : "📅 Next visit: To be scheduled";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Prescription</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Mono:wght@400;500&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="rx-page">
  <div class="rx-header">
    <div>
      <div class="rx-hosp-name">Gini Advanced Care Hospital</div>
      <div class="rx-hosp-tag">NABH Accredited · SCO 14-15, Sector 68, SAS Nagar, Mohali 160068 · +91 81463 20100</div>
    </div>
    <div class="rx-doc">
      <div class="rx-doc-name">${escape(doctor.name || "Doctor")}</div>
      <div class="rx-doc-cred">${docCredHtml}</div>
    </div>
  </div>

  <div class="rx-patient-bar">
    <div>
      <div class="rx-pt-name">${escape(patient.name || "")}</div>
      <div class="rx-pt-meta">${escape(patientMeta)}</div>
    </div>
    <div class="rx-pt-pills">${phasePill}${monthsPill}</div>
  </div>

  <div class="rx-body">
    ${
      visitSummaryText
        ? (() => {
            const paragraphs = String(visitSummaryText)
              .replace(/\r\n/g, "\n")
              .split(/\n{2,}/)
              .map((p) => p.replace(/^\s+|\s+$/g, ""))
              .filter(Boolean)
              .map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`)
              .join("");
            return `<div class="rx-summary-block">
             <div class="sum-title">Visit summary</div>
             ${paragraphs}
           </div>`;
          })()
        : ""
    }

    ${activeDx.length > 0 ? `<div class="rx-section-title">Diagnoses</div>${dxHtml}` : ""}

    ${
      goals.length > 0
        ? `<div class="rx-section-title">Goals for next visit</div>
           <div class="rx-goals">${goalsHtml}</div>`
        : ""
    }

    ${
      biomarkerCards.length > 0
        ? `<div class="rx-section-title">Biomarker trends — last 4 visits</div>
           <div class="rx-bio-grid">${bioHtml}</div>`
        : ""
    }

    ${
      ownMeds.length > 0
        ? `<div class="rx-section-title">Medicines — prescribed by ${escape(doctorShortName(doctor.name))}</div>${ownMedsHtml}`
        : ""
    }

    ${
      externalMeds.length > 0
        ? `<div class="rx-section-title" style="margin-top:14px">External medicines — prescribed by other doctors</div>${extMedsHtml}`
        : ""
    }

    ${
      referrals.length > 0 || labTests.length > 0
        ? `<div class="rx-section-title">Referrals &amp; tests for next visit</div>
           ${referralsHtml}
           ${labTestsHtml}`
        : ""
    }
    ${followUpWithHtml}
  </div>

  <div class="rx-footer">
    <div class="rx-sig">
      <div style="font-weight:700">${escape(doctor.name || "Doctor")}</div>
      <div style="font-size:10px;color:var(--ink3)">${
        doctor.reg_no ? `Reg. No. ${escape(doctor.reg_no)} · ` : ""
      }Date: ${fmtDateLong(today)}</div>
    </div>
    <div class="rx-next">${nextVisitText}</div>
  </div>
</div>
</body>
</html>`;
}

export { buildPrescriptionHtml };
