// Builds an HTML document that exactly matches docs/archive/gini-examples.html
// "Printed Prescription" layout. Used by the Puppeteer PDF generator. Keep CSS
// in sync with that file (lines 9-115) when the design changes.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MED_CATEGORIES, detectMedCategory } from "../config/medicationCategories.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";
import { pickNextVisit } from "../../shared/followUp.js";
import { DEFAULT_HOSPITAL, normalizeHospital } from "../services/prescriptionFooter.js";

const HOSPITAL_NAME = DEFAULT_HOSPITAL.name;
const HOSPITAL_ADDRESS = DEFAULT_HOSPITAL.address;
const HOSPITAL_PHONE = DEFAULT_HOSPITAL.phone;

// The letterhead logo is read off disk once and inlined as a data URI: Puppeteer
// renders the PDF with no network access to this server, so a src="/logo.png"
// prints an empty box. Drop the artwork in templates/assets/ as logo.<ext> —
// with no file there the header simply prints without it.
//
// That file is the white-knockout wordmark, not the app icon: the header band is
// navy, and the icon's deep-blue lettering on its white tile reads as a sticker
// pasted over the letterhead. public/brand/logo.png keeps the original colours
// for light backgrounds.
const LOGO_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

// The shipped artwork, and the fallback whenever no logo has been uploaded from
// Settings (services/prescriptionLogo.js) — so the letterhead is never blank.
export const DEFAULT_LOGO_DATA_URI = (() => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "assets");
  try {
    const file = readdirSync(dir)
      .filter((f) => f.toLowerCase().startsWith("logo") && LOGO_MIME[extname(f).toLowerCase()])
      .sort()[0];
    if (!file) return "";
    const mime = LOGO_MIME[extname(file).toLowerCase()];
    return `data:${mime};base64,${readFileSync(join(dir, file)).toString("base64")}`;
  } catch {
    return "";
  }
})();

// The closing strip — the services note the clinic used to rubber-stamp on the
// printed Rx, set as part of the document instead. Navy to bookend the header,
// so the page reads as designed rather than as a stamp added afterwards.
// The wording is a setting, not a literal — admin edits it at
// /admin/prescription-footer (services/prescriptionFooter.js). Rendering falls
// back to that module's DEFAULT_FOOTER, so a prescription still prints its
// strip if the lookup failed upstream. Any line left blank drops out entirely,
// and with every line blank the strip itself does.
function promoHtml(footer, logo = DEFAULT_LOGO_DATA_URI) {
  const lines = (footer?.serviceLines || []).map((l) => String(l).trim()).filter(Boolean);
  const appLine = String(footer?.appLine || "").trim();
  const storeLine = String(footer?.storeLine || "").trim();
  if (!lines.length && !appLine && !storeLine) return "";

  const mark = logo && (appLine || storeLine) ? `<img src="${logo}" alt="">` : "";
  const svc = lines.map((l) => `<div>${escape(l)}</div>`).join("");
  const app =
    appLine || storeLine
      ? `<div class="rx-promo-app">
      ${mark}
      <div class="rx-promo-txt">
        ${appLine ? `<div class="rx-promo-ttl">${escape(appLine)}</div>` : ""}
        ${storeLine ? `<div class="rx-promo-sub">${escape(storeLine)}</div>` : ""}
      </div>
    </div>`
      : "";
  return `<div class="rx-promo">
    <div class="rx-promo-svc">${svc}</div>
    ${app}
  </div>`;
}

// One letterhead, two documents. The prescription and the referral letter print
// the same header off this helper so a patient handed both cannot read them as
// coming from two different hospitals.
function letterheadHtml(docNameHtml, docCredHtml, logoDataUri = DEFAULT_LOGO_DATA_URI, hospital) {
  const hosp = normalizeHospital(hospital);
  const logo = logoDataUri ? `<div class="rx-logo"><img src="${logoDataUri}" alt=""></div>` : "";
  return `<div class="rx-header">
    <div class="rx-header-top">
      <div class="rx-hosp">
        <div class="rx-hosp-name">${escape(hosp.name)}</div>
      </div>
      ${logo}
      <div class="rx-doc">
        <div class="rx-doc-name">${docNameHtml}</div>
        <div class="rx-doc-cred">${docCredHtml}</div>
      </div>
    </div>
    <div class="rx-hosp-tag">${escape(hosp.address)} &middot; ${escape(hosp.phone)}</div>
  </div>`;
}

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

// Returns null for values that should not be rendered: JS null, undefined, empty string,
// or the literal string "null" that some DB columns contain when never set.
const val = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" || s === "null" ? null : s;
};

const escape = (s) => {
  if (s == null) return "";
  if (String(s).trim() === "null") return "";
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

const MED_GROUP_RANK = MED_CATEGORIES.reduce((acc, c) => {
  acc[c.id] = c.rank;
  return acc;
}, {});

// Order the printed medicine list by the clinical sequence the consultants
// review in — diabetes first, supplements last — so the printed Rx reads in the
// same order as the diagnosis list above it. Child/support meds keep their
// parent's position; they are pulled out by rank later, not sorted here.
const sortMedsClinically = (meds) =>
  meds
    .map((m, i) => ({ m, i, rank: MED_GROUP_RANK[detectMedCategory(m)] ?? 45 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.m);

const splitMeds = (activeMeds = []) => {
  // Belt-and-braces: drop any stopped meds even if the client forgot to filter
  const live = activeMeds.filter((m) => m.is_active !== false);
  // "external" is provenance, not a drug class: only external_doctor or an
  // explicit med_group puts a medicine under another doctor's heading. It used
  // to be inferred from urology drug names, which printed the treating doctor's
  // own Urimax as somebody else's prescription.
  const ownMeds = sortMedsClinically(live.filter((m) => detectMedCategory(m) !== "external"));
  const externalMeds = live.filter((m) => detectMedCategory(m) === "external");
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
.rx-header{background:var(--nv);padding:16px 22px}
.rx-header-top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.rx-hosp{flex:1 1 0;min-width:0}
.rx-hosp-name{font-family:var(--fd);font-size:22px;color:#fff;font-style:italic}
/* The address sits on its own full-width line under the row rather than under
   the hospital name: in a three-column header it only gets a third of the page
   and orphans the phone number onto a second line. */
.rx-hosp-tag{font-size:10px;color:rgba(255,255,255,.5);margin-top:10px;padding-top:9px;border-top:1px solid rgba(255,255,255,.12)}
.rx-logo{flex:0 0 auto;display:flex;align-items:center;justify-content:center}
.rx-logo img{height:46px;width:auto;display:block}
.rx-doc{flex:1 1 0;text-align:right}
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
.rx-summary-tests{margin-top:8px;padding-top:8px;border-top:1px solid var(--tlb)}
.rx-summary-tests-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--tl);margin-bottom:5px}
.rx-summary-tests-list{display:flex;flex-wrap:wrap;gap:4px}
.rx-summary-test-chip{font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--tlb);color:var(--ink2)}

.rx-section-title{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--ink3);margin-bottom:8px;margin-top:16px;padding-bottom:4px;border-bottom:1px solid var(--bd);break-inside:avoid;break-after:avoid}
.rx-med-cat{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;color:var(--ink2);text-transform:uppercase;letter-spacing:.08em;background:#f5f7fa;padding:4px 8px;border-left:3px solid var(--tl);margin:10px 0 2px}
.rx-med-cat-count{font-size:9px;font-weight:600;color:var(--ink3);text-transform:none;letter-spacing:0}
.rx-dx{display:flex;gap:10px;align-items:flex-start;margin-bottom:7px;break-inside:avoid}
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


.rx-med{display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--bg);break-inside:avoid}
.rx-med:last-child{border:none}
.rx-med-num{font-family:var(--fm);font-size:11px;color:var(--ink3);flex-shrink:0;min-width:20px;padding-top:2px}
.rx-med-body{flex:1;min-width:0;word-break:break-word;overflow-wrap:break-word}
.rx-med-name{font-size:13px;font-weight:700;color:var(--ink)}
.rx-med-brand{font-size:11px;color:var(--ink3)}
.rx-med-instr{font-size:11px;color:var(--ink2);margin-top:2px;word-break:break-word;overflow-wrap:break-word}
.rx-med-right{text-align:right;flex-shrink:0;max-width:40%;min-width:0;word-break:break-word;overflow-wrap:break-word}
.rx-med-dose{font-family:var(--fm);font-size:12px;font-weight:500;word-break:break-word;overflow-wrap:break-word}
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

.rx-promo{background:var(--nv);padding:11px 22px;display:flex;justify-content:space-between;align-items:center;gap:18px}
.rx-promo-svc{font-size:10px;color:rgba(255,255,255,.72);line-height:1.75}
.rx-promo-svc div{padding-left:11px;position:relative}
.rx-promo-svc div::before{content:"";position:absolute;left:0;top:6px;width:4px;height:4px;border-radius:50%;background:var(--am)}
.rx-promo-app{display:flex;align-items:center;gap:10px;flex:0 0 auto}
.rx-promo-app img{height:30px;width:auto;display:block}
.rx-promo-txt{text-align:right}
.rx-promo-ttl{font-size:11px;font-weight:700;color:#fff}
.rx-promo-sub{font-size:9px;color:rgba(255,255,255,.55);margin-top:1px}

@page{size:A4;margin:14mm 18mm}
`;

function buildPrescriptionHtml(data = {}) {
  const {
    patient = {},
    doctor = {},
    summary = {},
    visitSummaryText: visitSummaryTextOverride,
    activeDx: activeDxInput = [],
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

  // Every caller (client print, /visit route, sync auto-save) gets the same
  // clinical sequence: diabetes, obesity, CAD, CVA, PVD, hypercholesterolemia,
  // nephropathy, neuropathy, retinopathy, hypertension, MASLD, thyroid, rest.
  const activeDx = sortDiagnoses(activeDxInput) || [];

  const today = new Date().toISOString().split("T")[0];
  const latestCon = consultations?.[0]?.con_data || {};
  const followUp = pickNextVisit([latestCon.follow_up, appt_plan?.follow_up]) || {};
  const _notEmpty = (arr) => (Array.isArray(arr) && arr.length > 0 ? arr : null);
  // The doctor adds tests in two different places — "Order Labs" on /assess
  // (investigations_to_order) and "Tests for Next Appointment" on the /visit
  // plan (follow_up.tests_to_bring) — and older rows spell the same thing two
  // more ways. Taking the first non-empty one meant whichever screen was used
  // second printed nothing, so every consultation-side list is merged instead,
  // deduped on the test name. The appointment stays a FALLBACK rather than
  // another merge source: HealthRay names the same test differently ("FBG" vs
  // "Fasting Blood Glucose"), which no name match would collapse, so merging it
  // would print the same test twice.
  const testName = (t) => (typeof t === "string" ? t : t?.name || t?.test || "");
  const mergeTests = (...lists) => {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const t of list) {
        const key = testName(t).trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
    return out;
  };
  const tests =
    _notEmpty(
      mergeTests(
        latestCon.investigations_to_order,
        latestCon.investigations_ordered,
        latestCon.tests_ordered,
        latestCon.follow_up?.tests_to_bring,
      ),
    ) ||
    _notEmpty(appt_plan?.investigations_to_order) ||
    [];
  // FOLLOW UP WITH — free-text patient instructions for the next visit
  // (fasting / tests to bring / preparations). Captured from prescription
  // extraction or set inline on /visit. Printed as a dedicated section so the
  // patient leaves the clinic with these instructions on paper.
  const followUpWith =
    [latestCon.follow_up_with, appt_plan?.follow_up_with]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .find(Boolean) || "";
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

  const { ownMeds, externalMeds } = splitMeds(activeMeds);
  const { referrals, labTests } = splitTests(tests);

  // ── Patient name and meta line
  // Age and sex ride with the name in chart shorthand — "Pawan Kumar (61M)"
  // reads as one fact to a doctor going through a stack. The line beneath
  // identifies the document instead: UHID, then the date it was issued.
  // Either half of the parenthetical can be missing, and with both absent the
  // brackets go too.
  const sexInitial = String(patient.sex || "")
    .trim()
    .charAt(0)
    .toUpperCase();
  const patientQualifier = `${patient.age ?? ""}${sexInitial}`;
  const patientTitle = [patient.name || "", patientQualifier ? `(${patientQualifier})` : ""]
    .filter(Boolean)
    .join(" ");

  const patientMeta = [
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
    if (text.includes("thyroid") || text.includes("hashimoto") || text.includes("graves")) {
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

  // ── Own medicines (flat list — no category headers)
  const ownChildrenByParent = buildChildrenMap(ownMeds);
  const ownIds = new Set(ownMeds.map((m) => m.id).filter((x) => x != null));
  const ownParents = ownMeds.filter(
    (m) => !m.parent_medication_id || !ownIds.has(m.parent_medication_id),
  );

  const renderChildMed = (child, parentName) => {
    const childPrimary = child.composition || child.name;
    return `
        <div class="rx-med rx-med-sub">
          <div class="rx-med-num"></div>
          <div class="rx-med-body">
            <div class="rx-med-name"><span class="rx-med-arrow">↳</span>${escape(childPrimary || "")}<span class="rx-sub-badge">SUPPORT</span></div>
            <div class="rx-sub-cond">${escape(child.support_condition || `for ${parentName}`)}</div>
            ${val(child.instructions) ? `<div class="rx-med-instr">${escape(child.instructions)}</div>` : ""}
          </div>
          <div class="rx-med-right">
            <div class="rx-med-dose">${escape(val(child.dose) || val(child.dosage) || val(child.frequency) || "—")}</div>
            <div class="rx-med-timing">${escape(val(child.timing) || "")}</div>
          </div>
        </div>`;
  };

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
    const formLabel = val(m.form) || null;
    return `
        <div class="rx-med" ${rowStyle}>
          <div class="rx-med-num">${num}.</div>
          <div class="rx-med-body">
            <div class="rx-med-name">${escape(primary || "")} ${tag}${formLabel ? ` <span style="font-size:10px;font-weight:600;color:var(--ink3);text-transform:uppercase;letter-spacing:.04em">${escape(formLabel)}</span>` : ""}</div>
            ${indication ? `<div class="rx-med-brand">${escape(indication)}</div>` : ""}
            ${val(m.instructions) ? `<div class="rx-med-instr">${escape(m.instructions)}</div>` : ""}
          </div>
          <div class="rx-med-right">
            <div class="rx-med-dose">${escape(val(m.dose) || val(m.dosage) || val(m.frequency) || "—")}</div>
            <div class="rx-med-timing">${escape(val(m.timing) || "")}</div>
          </div>
        </div>${childrenHtml}`;
  };

  let medCounter = 0;
  const ownMedsHtml = ownParents
    .map((m) => {
      medCounter += 1;
      return renderOwnMedRow(m, medCounter);
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
            <div class="rx-med-dose">${escape(val(m.dose) || val(m.dosage) || val(m.frequency) || "—")}</div>
            <div class="rx-med-timing">${escape(val(m.timing) || "")}</div>
            ${val(m.instructions) ? `<div class="rx-med-timing">${escape(m.instructions)}</div>` : ""}
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
  // pickNextVisit falls back to the most recent PAST follow-up when nothing
  // upcoming is on file, which printed a next visit dated before the visit
  // itself on the patient's own copy. A date that has already passed is not a
  // next visit — say it is unscheduled instead of naming a wrong day.
  const nextVisitDate = followUp.date && followUp.date >= today ? followUp.date : "";
  const nextVisitText = nextVisitDate
    ? `📅 Next visit: ${fmtDateLong(nextVisitDate)}${labTests.length > 0 ? " · Come with all reports above" : ""}`
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
  ${letterheadHtml(escape(doctor.name || "Doctor"), docCredHtml, data.rx_logo || DEFAULT_LOGO_DATA_URI, data.rx_footer?.hospital)}

  <div class="rx-patient-bar">
    <div>
      <div class="rx-pt-name">${escape(patientTitle)}</div>
      <div class="rx-pt-meta">${escape(patientMeta)}</div>
    </div>
    <div class="rx-pt-pills">${phasePill}${monthsPill}</div>
  </div>

  <div class="rx-body">
    ${
      visitSummaryText || tests.length > 0
        ? (() => {
            const paragraphs = visitSummaryText
              ? String(visitSummaryText)
                  .replace(/\r\n/g, "\n")
                  .split(/\n{2,}/)
                  .map((p) => p.replace(/^\s+|\s+$/g, ""))
                  .filter(Boolean)
                  .map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`)
                  .join("")
              : "";
            const testsHtml =
              tests.length > 0
                ? `<div class="rx-summary-tests">
               <div class="rx-summary-tests-title">Investigations ordered</div>
               <div class="rx-summary-tests-list">${tests.map((t) => `<span class="rx-summary-test-chip">${escape(typeof t === "string" ? t : t.name || t.test || String(t))}</span>`).join("")}</div>
             </div>`
                : "";
            return `<div class="rx-summary-block">
             <div class="sum-title">Visit summary</div>
             ${paragraphs}${testsHtml}
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

  ${promoHtml(data.rx_footer, data.rx_logo || DEFAULT_LOGO_DATA_URI)}
</div>
</body>
</html>`;
}

// The letterhead is shared, not copied: the referral letter (19 §7.1) prints the
// same `.rx-header` markup off the same CSS, so a letter and the prescription in
// the same envelope cannot look like they came from two hospitals.
export {
  buildPrescriptionHtml,
  escape as escapeHtml,
  CSS as LETTERHEAD_CSS,
  letterheadHtml,
  HOSPITAL_NAME,
  HOSPITAL_ADDRESS,
  HOSPITAL_PHONE,
};
