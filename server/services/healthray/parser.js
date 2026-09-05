// ── Clinical notes parsing — extract text, AI parse, JSON repair ────────────

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { createLogger } from "../logger.js";
const { error } = createLogger("HealthRay Sync");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

const TEXT_FIELDS = [
  "answer",
  "details",
  "description",
  "note",
  "notes",
  "value",
  "text",
  "diagnosis_details",
  "summary",
  "remark",
  "remarks",
  "comment",
  "comments",
];

function pullText(obj, bag) {
  if (!obj || typeof obj !== "object") return;
  for (const f of TEXT_FIELDS) {
    const v = obj[f];
    if (typeof v === "string" && v.trim().length > 0) bag.push(v.trim());
  }
}

// ── Printed-page furniture ───────────────────────────────────────────────────
// Some HealthRay notes are assembled from a printed prescription, so the clinic
// letterhead lands *inside* the note — often between a dated section header and
// its own values:
//
//   FOLLOW UP TODAY:9/11/25
//   GINI ADVANCED CARE HOSPITAL
//   Gini Health India Pvt.Ltd, Shivalik Hospital, 2nd Floor Sector 69, Mohali, Punjab,
//   India
//   01724120100
//   Dr. Anil Bhansali
//   DM - Endocrinology
//   Page | 1
//   FBG 128.4
//
// Six lines of letterhead sever the header from FBG 128.4, and the extractor
// then fails to attribute the value to that visit — it falls back to the
// enrolment OBSERVATION block instead. Stripping the furniture restores the
// adjacency the block-attribution rules depend on.
//
// Everything here is matched as an exact literal. A loose "line contains
// HOSPITAL" rule would delete real clinical history — "ADMITTED IN HOLY BASIL
// HOSPITAL", "COURSE IN HOSPITAL-(11/07/24)", "REFER TO DR SHIKHA VERMA
// (SHIVALIK HOSPITAL)" all legitimately appear in these notes.

// Letterhead fragments that can also appear glued to the end of a clinical line
// with no newline ("GOITREGINI ADVANCED CARE HOSPITAL") — removed in place so
// the clinical text before them survives.
const FURNITURE_PHRASES = [
  /GINI\s+ADVANCED\s+CARE\s+HOSPITAL/gi,
  /GINI\s+HEALTH\s+INDIA\s+PVT\.?\s*LTD,?\s*SHIVALIK\s+HOSPITAL,?\s*2ND\s+FLOOR\s+SECTOR\s+69,?\s*MOHALI,?\s*PUNJAB,?(\s*INDIA)?,?/gi,
];

// Lines that are ONLY furniture — dropped whole.
const FURNITURE_LINES = [
  /^india,?$/i,
  /^0?1724120100$/,
  /^page\s*\|\s*\d+$/i,
  /^dm\s*[-–]\s*endocrinology$/i,
  /^endocrinologist$/i,
  /^dr\.?\s+[a-z]+(?:\s+[a-z]+){0,2}$/i, // standalone signature line, e.g. "Dr. Anil Bhansali"
];

// Only notes that actually carry the letterhead are touched, so the doctor-name
// rule can never fire on a note where "Dr. X" means something else.
const HAS_LETTERHEAD =
  /GINI\s+ADVANCED\s+CARE\s+HOSPITAL|page\s*\|\s*\d|SHIVALIK\s+HOSPITAL,\s*2ND\s+FLOOR/i;

export function stripPageFurniture(rawText) {
  if (!rawText || !HAS_LETTERHEAD.test(rawText)) return rawText;
  let text = rawText;
  for (const re of FURNITURE_PHRASES) text = text.replace(re, "");
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines — they separate blocks
      return !FURNITURE_LINES.some((re) => re.test(t));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function extractClinicalText(clinicalData) {
  const sections = {};
  for (const menu of clinicalData) {
    const texts = [];
    for (const cat of menu.categories || []) {
      // Format 1: topics.selected (from medical_clinical_notes)
      const selectedTopics = cat.topics?.selected || [];
      // Format 2: topics as flat array (from get_previous_appt_data)
      const flatTopics = Array.isArray(cat.topics) ? cat.topics : [];
      const allTopics = selectedTopics.length > 0 ? selectedTopics : flatTopics;

      for (const topic of allTopics) {
        if (topic.name) texts.push(topic.name);

        for (const ans of topic.dynamic_answers || []) pullText(ans, texts);
        pullText(topic, texts);

        // Some visits expose structured diagnosis/item rows on the topic —
        // each row can carry its own name + long details text (this is how
        // "INTENSIVE DIABETES MANAGEMENT PROGRAM ( … TREATMENT: … )" lands
        // when there is no prescription section).
        for (const key of ["diagnoses", "items", "rows", "entries"]) {
          const arr = topic[key];
          if (!Array.isArray(arr)) continue;
          for (const row of arr) {
            if (row?.name) texts.push(row.name);
            pullText(row, texts);
          }
        }
      }
    }
    if (texts.length) sections[menu.name] = texts.join("\n");
  }
  return sections;
}

export function extractVitalsFromAnswers(clinicalData) {
  const out = {};
  const safeParse = (s) => {
    try {
      return typeof s === "string" ? JSON.parse(s) : s;
    } catch {
      return null;
    }
  };
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  const ingest = (a) => {
    if (!a) return;
    const col = (a.column_name || "").toLowerCase();
    const label = (a.label || "").toLowerCase().trim();
    const alias = (a.alias || "").toLowerCase();
    const raw = a.value;

    // Path 2 — leaner answer shape from get_previous_appt_data's
    // "Observation / Vitals" category: no form_type / column_name, just a short
    // label (H / W / BMI / PR / BP) and a self-describing value
    // (e.g. {"method":"cm","height":168}, {"measured":"kg","weight":68.6}).
    // medical_clinical_notes vitals carry form_type="vital_sign" + column_name
    // and are handled by Path 1 below; this branch covers the rows that don't.
    if (a.form_type !== "vital_sign" && !col) {
      const p = safeParse(raw);
      if (p && typeof p === "object" && !Array.isArray(p)) {
        const h = num(p.height),
          w = num(p.weight),
          sys = num(p.systolic),
          dia = num(p.diastolic),
          hr = num(p.hr ?? p.pulse);
        const standing = (p.method || alias || "").toLowerCase().includes("stand");
        if (h && out.height == null) out.height = h;
        if (w && out.weight == null) out.weight = w;
        if (hr && out.pulse == null) out.pulse = hr;
        if (sys != null || dia != null) {
          if (standing) {
            if (sys && out.bpStandingSys == null) out.bpStandingSys = sys;
            if (dia && out.bpStandingDia == null) out.bpStandingDia = dia;
          } else {
            if (sys && out.bpSys == null) out.bpSys = sys;
            if (dia && out.bpDia == null) out.bpDia = dia;
          }
        }
      } else {
        const n = num(raw);
        if (n != null) {
          if (label === "bmi" && out.bmi == null) out.bmi = n;
          else if ((label === "w" || label === "wt" || label === "weight") && out.weight == null)
            out.weight = n;
          else if ((label === "h" || label === "ht" || label === "height") && out.height == null)
            out.height = n;
          else if (label.includes("waist") && out.waist == null) out.waist = n;
        }
      }
      return;
    }
    if (a.form_type !== "vital_sign") return;

    if (col === "height") {
      const p = safeParse(raw);
      const h = num(p?.height ?? raw);
      if (h) out.height = h;
    } else if (col === "weight") {
      const p = safeParse(raw);
      const w = num(p?.weight ?? raw);
      if (w) out.weight = w;
    } else if (col === "body_mass_index") {
      const b = num(raw);
      if (b) out.bmi = b;
    } else if (col === "bp_systolic" || col === "bp_1" || a.element_type === "BloodPressure") {
      const p = safeParse(raw);
      const sys = num(p?.systolic);
      const dia = num(p?.diastolic);
      const method = (p?.method || alias || "").toLowerCase();
      if (method.includes("stand")) {
        if (sys) out.bpStandingSys = sys;
        if (dia) out.bpStandingDia = dia;
      } else {
        if (sys) out.bpSys = sys;
        if (dia) out.bpDia = dia;
      }
    } else if (col === "heart_rate") {
      const p = safeParse(raw);
      const hr = num(p?.hr ?? raw);
      if (hr) out.pulse = hr;
    } else if (label.includes("waist") || alias.includes("waist")) {
      const v = num(raw);
      if (v) out.waist = v;
    } else if (label.includes("body fat") || alias.includes("body fat")) {
      const v = num(raw);
      if (v) out.bodyFat = v;
    } else if (label.includes("muscle") || alias.includes("muscle")) {
      const v = num(raw);
      if (v) out.muscleMass = v;
    }
  };

  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node.answers)) {
      for (const a of node.answers) ingest(a);
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && (Array.isArray(v) || typeof v === "object")) walk(v);
    }
  };

  walk(clinicalData);
  return Object.keys(out).length ? out : null;
}

// ── Repair truncated/malformed JSON from AI ─────────────────────────────────
export function repairAndParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {}

  let s = raw;

  // Fix unescaped newlines/tabs inside string values
  s = s.replace(/"([^"]*?)"/g, (_match, content) => {
    const fixed = content.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return `"${fixed}"`;
  });
  s = s.replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(s);
  } catch {}

  // Close unclosed strings
  const quotes = (s.match(/"/g) || []).length;
  if (quotes % 2 !== 0) s += '"';
  s = s.replace(/,\s*([}\]])/g, "$1");

  // Close unclosed arrays and objects
  const opens = { "{": 0, "[": 0 };
  for (const ch of s) {
    if (ch === "{") opens["{"]++;
    if (ch === "}") opens["{"]--;
    if (ch === "[") opens["["]++;
    if (ch === "]") opens["["]--;
  }
  if (opens["["] > 0 || opens["{"] > 0) {
    s = s.replace(/,\s*(?:"[^"]*"?\s*:?\s*(?:"[^"]*"?|[^,}\]]*)?)?$/m, "");
  }
  for (let i = 0; i < opens["["]; i++) s += "]";
  for (let i = 0; i < opens["{"]; i++) s += "}";

  try {
    return JSON.parse(s);
  } catch {}

  // Last resort: extract each key separately
  try {
    const partial = {};
    const keys = [
      "diagnoses",
      "labs",
      "medications",
      "previous_medications",
      "vitals",
      "lifestyle",
      "investigations_to_order",
      "follow_up",
      "follow_up_with",
      "advice",
    ];
    for (const key of keys) {
      const re = new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\}|"[^"]*")`);
      const m = s.match(re);
      if (m)
        try {
          partial[key] = JSON.parse(m[1]);
        } catch {}
    }
    if (Object.keys(partial).length > 0) return partial;
  } catch {}

  error("Parser", "JSON repair failed — could not recover");
  return null;
}

const FOLLOW_UP_LABEL = String.raw`(?:FOLLOW\s*-?\s*UP|FOLLOWUP|F\/?U|REVIEW|REVISIT|RTC)`;

const RELATIVE_FOLLOW_UP_RE = new RegExp(
  String.raw`\b${FOLLOW_UP_LABEL}\s+(?:[A-Z.\s]{0,40}?\s)?(?:AFTER|IN|WITHIN)\s+(\d{1,2})\s*(DAY|WEEK|MONTH|YEAR)S?\b([^\n]*)`,
  "gi",
);

const DATE_IN_TAIL_RE = /\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4}/;

const PAST_LOG_HEAD_RE = /TODAY/i;

const ABSOLUTE_WORD_MONTH_RE = new RegExp(
  String.raw`\b${FOLLOW_UP_LABEL}\b[^\n]{0,60}?\b(\d{1,2})\s*(?:ST|ND|RD|TH)?\s*[-/ ]?\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*\s*,?\s*(\d{4}|\d{2})\b([^\n]*)`,
  "gi",
);

const ABSOLUTE_NUMERIC_RE = new RegExp(
  String.raw`\b${FOLLOW_UP_LABEL}\b[^\n]{0,60}?\b(\d{1,2})\s*[/-]\s*(\d{1,2})\s*[/-]\s*(\d{2,4})\b([^\n]*)`,
  "gi",
);

const MONTH_NUMBERS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const FOLLOW_UP_HORIZON_MONTHS = 12;

const cleanFollowUpNotes = (tail) =>
  (tail || "")
    .replace(/^[\s:-]*WITH\s+/i, "")
    .replace(/[.,;)\s]+$/, "")
    .trim() || null;

const fullYear = (raw) => (String(raw).length === 4 ? parseInt(raw, 10) : 2000 + parseInt(raw, 10));

const toIsoDate = (year, month, day) => {
  if (!year || !month || month > 12 || !day || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return dt.toISOString().slice(0, 10);
};

const shiftMonths = (isoDate, months) => {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
};

export function extractRelativeFollowUp(rawText) {
  if (!rawText) return null;
  let last = null;
  for (const m of rawText.matchAll(RELATIVE_FOLLOW_UP_RE)) {
    if (DATE_IN_TAIL_RE.test(m[3] || "")) continue;
    if (PAST_LOG_HEAD_RE.test(m[0].slice(0, 40))) continue;
    last = m;
  }
  if (!last) return null;
  const count = parseInt(last[1], 10);
  if (!count) return null;
  return {
    date: null,
    timing: `${count} ${last[2].toLowerCase()}${count === 1 ? "" : "s"}`,
    notes: cleanFollowUpNotes(last[3]),
  };
}

export function extractAbsoluteFollowUp(rawText, apptDate) {
  if (!rawText || !/^\d{4}-\d{2}-\d{2}$/.test(apptDate || "")) return null;
  const horizon = shiftMonths(apptDate, FOLLOW_UP_HORIZON_MONTHS);
  let last = null;
  for (const line of rawText.split("\n")) {
    if (PAST_LOG_HEAD_RE.test(line)) continue;
    const hits = [
      ...[...line.matchAll(ABSOLUTE_WORD_MONTH_RE)].map((m) => ({
        date: toIsoDate(fullYear(m[3]), MONTH_NUMBERS[m[2].toLowerCase().slice(0, 3)], +m[1]),
        tail: m[4],
      })),
      ...[...line.matchAll(ABSOLUTE_NUMERIC_RE)].map((m) => ({
        date: toIsoDate(fullYear(m[3]), +m[2], +m[1]),
        tail: m[4],
      })),
    ];
    for (const hit of hits) {
      if (!hit.date || hit.date <= apptDate || hit.date > horizon) continue;
      last = hit;
    }
  }
  if (!last) return null;
  return { date: last.date, timing: null, notes: cleanFollowUpNotes(last.tail) };
}

export function extractFollowUpFromNote(rawText, apptDate) {
  return extractAbsoluteFollowUp(rawText, apptDate) || extractRelativeFollowUp(rawText);
}

export const CLINICAL_EXTRACTION_PROMPT = `Parse this clinical note into structured JSON. Extract ONLY data present in the text.

Return JSON with these keys:
{
  "symptoms": [{"name": "...", "duration": "...", "since_date": "YYYY-MM-DD or null", "severity": "mild/moderate/severe", "related_to": "diagnosis/condition this symptom is related to, or null"}],
  "diagnoses": [{"name": "...", "details": "...", "since": "...", "status": "Present/Absent"}],
  "labs": [{"test": "...", "value": "...", "unit": "...", "date": "..."}],
  "medications": [{"name": "...", "form": "Tablet/Capsule/Injection/Syrup/Drops/Ointment/Cream/Gel/Lotion/Spray/Inhaler/Sachet/Powder/Patch/Suppository/null", "dose": "...", "frequency": "...", "timing": "...", "when_to_take": ["Before breakfast"], "route": "Oral/SC/IM/IV/Topical/Inhaled/Sublingual/Nasal/Rectal/Vaginal", "days_of_week": "<int array 0-6 (0=Sun..6=Sat) of dosing weekdays for weekly / fortnightly meds when the source text names a day, e.g. 'once weekly on Sunday' → [0]; null otherwise>", "is_new": false, "support_for": "<parent brand name as it appears in this same medications array, or null>", "support_condition": "<short trigger e.g. 'for nausea/vomiting on Day 1-2 of injection', 'SOS for diarrhoea', or null>", "common_side_effects": [{"name": "<short side-effect label>", "desc": "<one-line patient-friendly tip>", "severity": "common|uncommon|warn"}]}],
  "previous_medications": [{"name": "...", "form": "Tablet/Capsule/Injection/null", "dose": "...", "frequency": "...", "status": "stopped/changed", "reason": "..."}],
  "vitals": [{"date": "YYYY-MM-DD or null", "height": null, "weight": null, "bmi": null, "bpSys": null, "bpDia": null, "waist": null, "bodyFat": null}],
  "lifestyle": {"diet": null, "exercise": null, "smoking": null, "alcohol": null, "stress": null},
  "investigations_to_order": [{"name": "...", "urgency": "urgent/routine/next_visit"}],
  "follow_up": {"date": null, "timing": null, "notes": null},
  "follow_up_with": "free-text patient instructions for the next visit (e.g. fasting / tests / preparations to bring), or null",
  "advice": "..."
}

STRICT Rules:
- NEVER invent or assume data. If a field is not explicitly mentioned in the text, set it to null. Do NOT fill fields with unrelated data.
- NO-PRESCRIPTION FALLBACK (treat Diagnosis summary AS the prescription): Some visits have NO separate MEDICATIONS/PRESCRIPTION section — the doctor instead wraps the entire plan as free text inside a single diagnosis parenthetical after a program label, e.g. "INTENSIVE DIABETES MANAGEMENT PROGRAM ( TYPE 2 DM (SINCE 2018) … TREATMENT: -INJ. RYZODEG 8 UNIT … -TAB SITACIP DM 10+100+500MG OD … PREVIOUS MEDICATION -TAB GLIMESTAR M2 … OBSERVATION-: -FBG-:251.7 … FOLLOW UP ON 26/6/25: … HBA1C: 7 … ADVICE: … )". When you see this pattern, treat that parenthetical AS THE PRESCRIPTION — extract medications, previous_medications, labs, vitals, follow_up, investigations_to_order, and advice from the labelled sub-blocks inside it exactly as if each sub-block had been its own top-level section of the note. Do NOT discard the parenthetical because its outer name (e.g. "INTENSIVE DIABETES MANAGEMENT PROGRAM") is a program label. The inner real diagnoses (TYPE 2 DM, NEUROPATHY, NEPHROPATHY, RETINOPATHY, HYPERTENSION, MASLD, CAD, etc.) are what get extracted as diagnoses — the program label itself is skipped.
- TREATMENT: block = CURRENT medications. Any drug listed under a "TREATMENT:" / "TREATMENT PLAN:" / "CURRENT TREATMENT:" label — whether that label sits in its own section or inside a diagnosis parenthetical — is a CURRENT medication. Put it in "medications", NOT "previous_medications". A leading "-" or "•" on each line is a bullet, not an absent marker. Example: "TREATMENT: -INJ. RYZODEG 8 UNIT ONCE DAILY 30MIN BEFORE BREAKFAST -TAB SITACIP DM 10+100+500MG ONCE DAILY 30 MINUTES BEFORE BREAKFAST -TAB GLIZID M XR 60+500MG ONCE DAILY 30 MINUTES BEFORE DINNER" → three current medications (Ryzodeg 8U SC OD before breakfast, Sitacip DM 10+100+500mg Oral OD before breakfast, Glizid M XR 60+500mg Oral OD before dinner). "REST CONTINUE AS ADVISED BY CARDIOLOGIST" is an instruction — do NOT extract as a medication.
- PREVIOUS MEDICATION block inside a diagnosis parenthetical = previous_medications with status "stopped" (unless the text explicitly says the dose was changed, in which case status "changed"). Reason is "replaced" / "discontinued" / "dose changed" based on context; use "replaced" as the default when the TREATMENT block contains a different regimen.
- For labs: extract ALL lab values with test name, numeric value, unit. Include HbA1c, FBG, PPBG, LDL, TG, HDL, Non-HDL, Cholesterol (Total), TSH, T3, T4, Creatinine, eGFR, UACR, Hb, Iron, Ferritin, OT/SGOT, PT/SGPT, ALP, Calcium, Albumin, GTT, Insulin, C-Peptide, HOMA-IR, HOMA-Beta, Uric Acid, FIB4, Vitamin D, Vitamin B12, AMH, Testosterone, DHEAS, Prolactin, LH, FSH, Estradiol, Progesterone, FPI, Amylase, Lipase, Fecal Elastase (FE), VPT (Vibration Perception Threshold — extract R and L values separately as "VPT Right" / "VPT Left"), ABI (Ankle-Brachial Index — extract as "ABI Right" / "ABI Left"), Hirsutism Score/FGS/H.Score, Potassium, Sodium, Anti-TPO, Anti-Tg, Anti-tTG (tTG), etc.
  TEST-NAME NORMALISATION — doctors frequently abbreviate or mistype. Normalise these to the canonical names even when the source text uses the variant: "HOMO IR"/"HOMO-IR" → "HOMA-IR"; "HOMO BETA"/"HOMO-BETA" → "HOMA-Beta"; "C-PPETIDE"/"C PPETIDE" → "C-Peptide"; "FCP"/"C-PEPTIDE (FASTING)" → "C-Peptide"; "NHDL"/"NON HDL" → "Non-HDL"; "CRT"/"S CREAT"/"S.CREAT"/"Creatinine, Serum"/"Creatinine Serum"/"Serum Creatinine" → "Creatinine"; "Creatinine, Urine"/"Urine Creatinine"/"Creatinine (Urine)"/"Creatinine- Urine" → "Creatinine, Urine" (IMPORTANT: keep distinct — urine creatinine is a separate test used only for ACR calculation; do NOT normalize to "Creatinine"); "T CHOL"/"T.CHOL"/"TCHOL"/"TOTAL CHOL" → "Total Cholesterol"; "TG"/"TGL"/"S.TG"/"S TG"/"TRIG" → "Triglycerides" (CAUTION: "TG" is TRIGLYCERIDES, never Total Cholesterol — do not confuse the two, they are different tests and swapping them corrupts the lipid panel); "FPG" → "FBS"; "FBG" → "FBS"; "PPG" → "PPBS"; "RBG" → "RBS"; "FPI" → "Fasting Insulin"; "TTG" → "Anti-tTG"; "OT" → "SGOT (AST)"; "PT" → "SGPT (ALT)" (unless the surrounding context clearly discusses coagulation in which case keep as "Prothrombin Time"). Output the canonical name in the test field. Do NOT preserve the raw abbreviation — downstream storage relies on the canonical form.
  DO NOT emit vital-sign fields (Height, Weight, BMI, Waist/WC, Body Fat/BF, Systolic BP, Diastolic BP, Pulse/HR, SpO2) as entries in the labs array. Those belong in the vitals array ONLY. If the clinician wrote "HT-167 WT-83 BMI-29" inside a dated follow-up, put them in vitals for that date — never also in labs. This rule holds regardless of whether the section uses dashes ("HT-167") or spaces ("HT 167").
  IMPORTANT — do NOT extract family history values as patient labs. Lines like "FATHER - TG-329, LDL-94" / "MOTHER- TG-132" / "BROTHER - TG-510" are family history — skip entirely.
  Also extract: Urine Pus Cells (e.g. "URINE RE-8 PUS CELLS" → test: "Urine Pus Cells", value: "8"), Amylase, Lipase, Fecal Elastase, GAD65 antibody / IAA / IA2 / ZnT8 autoantibody results (e.g. "GAD65/IAA/IA2 PANEL NEGATIVE" → extract as test: "GAD65/IAA/IA2 Panel", value: "Negative"), Random C-Peptide (e.g. "RANDOM C PEPTIDE-3.47" → test: "C-Peptide (Random)", value: "3.47").
  BRIEF HISTORY section may contain historical HbA1c or glucose readings — extract these as real lab results with whatever date context is available (e.g. "HBA1C-8 IN SEPT,25" → test: "HbA1c", value: "8", date: "2025-09-01"). If no date given, use date: null.
  IMPORTANT — DEDUPLICATION: If the same test with the SAME numeric value appears in both an OBSERVATIONS section (no date) AND a FOLLOW UP section (with a specific date), extract it ONLY ONCE using the follow-up date (which is more specific). Do NOT create two entries for the same value. Example: OBSERVATIONS has "HBA1C-7" (no date) and FOLLOW UP ON 26/6/25 has "HBA1C-7" → extract ONE entry: {test: "HbA1c", value: "7", date: "2025-06-26"}. However, if the same test appears with DIFFERENT values in different sections (e.g. HbA1c 8 in history vs. HbA1c 7 in follow-up), extract EACH as a separate entry — these are genuinely different measurements from different time points.
  DATE-ATTRIBUTION FOR LABS — every lab in the note sits under (or after) some date header. Find the nearest preceding date header and use its date as that lab's date (YYYY-MM-DD). Recognised date headers include:
    • "FOLLOW UP ON <date>" / "FOLLOW UP TODAY ON <date>" / "FOLLOW UP TODAY:<date>" / "FOLLOW UP TODAY - <date>" / "FOLLOW UP TODAY <date>" (no separator) / "FOLLOW UP TODAY(<date>)" / "FU TODAY <date>" / "F/U TODAY <date>"
    • "FOLLOW UP NOTES(<date>)" / "FOLLOW UP NOTES ON <date>" / "FOLLOW UP NOTES:<date>" / "FOLLOW UP NOTES <date>"
    • "FOLLOW UP WITH <date>" / "FOLLOW UP:<date>" / "FOLLOW UP - <date>" (treat same as FOLLOW UP ON)
    • "PREVIOUS RECORD ON <date>" / "RECORD ON <date>" / "VISIT ON <date>" / "SEEN ON <date>"
    • A standalone "ON <date>" line (e.g. "ON 4TH JUNE 2023") — treat as a date header for labs that follow it
    • Natural-language dates: "5TH MARCH 2023", "24th DECEMBER 2024", "6th NOVEMBER 2023", "3rd APRIL 2024" — parse to YYYY-MM-DD
    • Dash-separated Indian dates: "26-03-24", "11-11-23" = DD-MM-YY → YYYY-MM-DD
    • Parenthesised dates: "(18/06/2024)", "(03-08-24)"
  CRITICAL — "FOLLOW UP TODAY: <date>" / "FOLLOW UP TODAY ON <date>" is the MOST COMMON pattern and is FREQUENTLY MIS-ATTRIBUTED. The word "TODAY" does NOT mean use today's actual calendar date — it means "the date listed on this header IS the visit date for everything below it". EVERY lab, vital, biomarker, BP, weight, HbA1c, FBG, etc. that appears AFTER such a header and BEFORE the next date header MUST carry the header's date. Do NOT use today's date. Do NOT use the note's overall visit_date. Use the EXACT date written in the FOLLOW UP TODAY header. This rule is absolute.
  EXAMPLE: Note contains "FOLLOW UP TODAY: 15/03/2025\nBP-130/80\nHBA1C-7.2\nWT-82". ALL three values get date "2025-03-15", not today's date, not the note's header visit_date. If later the note also has "FOLLOW UP TODAY ON 20/04/2025\nBP-125/78\nHBA1C-6.8", those three carry "2025-04-20". These are TWO separate dated visit logs inside one note — emit TWO vitals entries and six lab entries with their respective dates.
  "TODAY (<date>)" / "DATE: TODAY <date>" / "TODAY - <date>" — when the prescription literally writes the word TODAY immediately followed/preceded by an explicit date, use THAT explicit date for all labs in that section.
  Bare "TODAY" / "DATE: TODAY" / "OBSERVATION TODAY" / "OBSERVATIONS" / "PATIENT VISITED TODAY" with NO surrounding older dated header — set date: "today". This represents the CURRENT visit. Do NOT invent a calendar date. The downstream pipeline anchors "today" to the prescription's own visit date.
  DATED FOLLOW-UP BLOCK — DEFINITION (referenced by the rules below): a section header that names a specific visit date, in ANY of these spellings — "FOLLOW UP ON <date>", "FOLLOW UP TODAY:<date>", "FOLLOW UP TODAY ON <date>", "FOLLOW UP <date>", "FOLLOW UP NOTES(<date>)", "F/U ON <date>", "FU <date>", "REVIEW ON <date>", "VISIT ON <date>", "SEEN ON <date>", "LABS (<date>)", "OBSERVATION ON <date>", "OBSERVATIONS ON <date>" — with or without a colon, and with the date in any Indian format ("29/7/26", "29-07-2026", "29.7.26", "29TH JULY 2026"). These are all the same thing: a dated visit log inside the note. Wherever a rule says "dated follow-up block" it means ANY of these spellings — NEVER only the literal words "FOLLOW UP ON".
  EXCEPTION — OBSERVATIONS SKIPPED WHEN MATCHING FOLLOW UP EXISTS: If the user message begins with "Visit date: YYYY-MM-DD" AND the note contains a dated follow-up block whose date matches that visit date → do NOT assign date "today" to OBSERVATIONS labs. Skip OBSERVATIONS labs entirely — the dated follow-up block for the visit date is the authoritative source and OBSERVATIONS is the historical baseline.
  CUMULATIVE NOTE — STRUCTURAL RULE: doctors keep ONE note per patient and APPEND a new dated follow-up block at each visit, so the same note is re-sent, longer, every time. In such a note the undated "OBSERVATION" / "OBSERVATIONS" block at the TOP is the ENROLLMENT BASELINE from the patient's FIRST visit — it is NEVER the current visit. Therefore: if ONE OR MORE dated follow-up blocks appear ANYWHERE BELOW an undated OBSERVATIONS block, that OBSERVATIONS block is HISTORICAL — do NOT date it "today". "No older dated header ABOVE it" is NOT sufficient evidence that OBSERVATIONS is current; you must ALSO confirm there is no dated follow-up block BELOW it.
  CRITICAL — USE INTELLIGENCE TO DETECT CARRIED-FORWARD HISTORICAL TEXT. HealthRay clinical notes frequently copy prior visits' notes verbatim into a new note. The word "TODAY" inside a sub-block does NOT always mean the current visit — it can mean "today" as written when that block was originally authored. Apply this judgment:
    • If "PATIENT VISITED TODAY" / "TODAY" / "OBSERVATIONS" sits NESTED INSIDE an outer explicitly-older dated header — most often "FOLLOW UP NOTES(<old-date>):" but also "FOLLOW UP ON <old-date>:" / "VISIT ON <old-date>:" — and the note ALSO contains a separate later section that is clearly the real current visit (e.g. another "FOLLOW UP ON <recent-date>", "LABS (<recent-date>)", or fresh complaints/symptoms keyed to today), then the inner "TODAY" is HISTORICAL and refers to the OUTER header's date, NOT the current visit. Attribute those labs to the outer header's date (YYYY-MM-DD).
    • If the only dated context for a "TODAY" / "OBSERVATIONS" block is an older header AND there's no clearly-newer section, still prefer the outer header's date over today — this is likely historical context the doctor is reviewing.
    • If "TODAY" / "OBSERVATIONS" is the FIRST or PRIMARY block in the note, there is no older dated header above it, AND there is no dated follow-up block anywhere below it, treat it as the current visit → date: "today". EXCEPTIONS — this bullet does NOT apply, and OBSERVATIONS labs are skipped entirely, when EITHER (a) the user message starts with "Visit date:" and the note has a dated follow-up block matching that visit date, OR (b) the note contains any dated follow-up block below the OBSERVATIONS block (cumulative note — OBSERVATIONS is the enrollment baseline).
  EXAMPLE (carried-forward, P_137100 pattern):
    "FOLLOW UP NOTES(20-03-24):\n…\nPATIENT VISITED TODAY\nHBA1C : 11.5\nFPG : 112\n…\nFOLLOW UP ON 4/5/26 (PROXY VISIT)\n…\nLABS (19/4/26) S CREAT-1.00 HBA1C-7.9"
    → HBA1C 11.5 and FPG 112 carry date "2024-03-20" (inherited from the outer FOLLOW UP NOTES(20-03-24) header — they were the labs from THAT old visit, copied forward).
    → S CREAT 1.00 and HBA1C 7.9 carry date "2026-04-19" (from "LABS (19/4/26)").
    → Neither set is "today" — the current visit on 2026-05-04 has no fresh lab values of its own.
  EXAMPLE (real current OBSERVATIONS, not carried forward):
    "C/O HEADACHE\nOBSERVATIONS:\nBP-130/80\nFBS-110\nDIAGNOSIS: T2DM\nTREATMENT: …"
    → BP and FBS carry date: "today" — there is no older dated header above OBSERVATIONS **and no dated follow-up block below it**, so this is the current visit.
  EXAMPLE (cumulative note — OBSERVATIONS is the baseline, NOT today):
    Visit date: 2026-07-29. Note: "…PREVIOUS MEDICATION NIL\nOBSERVATION\nHT 152.5\nBP 148/95\nFBG 171.4\nHBA1C 8.8\nLDL 167.6\n…\nFOLLOW UP TODAY:18/6/26\nBP 122/79\nFBG 150\nPP 195\n\nFOLLOW UP TODAY:29/7/26\nBP 136/88\nFBG 82.3\nHBA1C 6.4\nLDL 50.6\n…"
    → The OBSERVATION block is the enrollment baseline — "FOLLOW UP TODAY:<date>" IS a dated follow-up block, and two of them sit below it. Emit NOTHING from OBSERVATION: no FBG 171.4, no HBA1C 8.8, no LDL 167.6, not even tests that appear only there.
    → FBG 150 and PP 195 carry "2026-06-18". FBG 82.3, HBA1C 6.4 and LDL 50.6 carry "2026-07-29".
    → Emitting FBG 171.4 with date "2026-07-29" is the exact error this rule exists to prevent: it makes the patient's enrollment baseline look like today's lab and buries the real result.
  If a lab is listed under no dated section at all (top-of-note BRIEF HISTORY with no date, free-floating values, and no judgment can attribute a date), set date: null. The downstream pipeline SKIPS undated labs entirely (it does not fall back to the appointment date) — so a null-dated value will be DROPPED. Prefer inferring a date (outer header, "today" for current-visit blocks) over emitting null.
  DATE-CERTAINTY GATE FOR LABS — only emit a lab when the date is 100% certain. SKIP the lab entirely (do NOT emit it at all, do NOT emit with date: null, do NOT guess) when ANY of these uncertainty cues surround the value or its date:
    • Hedged value: "MAY BE HBA1C 7", "PROBABLY FBG ~110", "AROUND 200", "APPROX 7", "~7", "?7", "NOT SURE OF VALUE", "POSSIBLY", "LIKELY", "I THINK", "PATIENT SAYS MAYBE".
    • Hedged date: "AROUND SEPT 2025", "APPROX 6 MONTHS BACK", "MAY BE LAST YEAR", "NOT SURE OF DATE", "?DATE", "SOMETIME IN MARCH", "POSSIBLY IN <month>", "PROBABLY <month>", "MAY BE IN <month/year>".
    • Observation/aside in another section that records a value with a hedge (e.g. "OBSERVATION: PATIENT MENTIONS HBA1C MAY BE 7 LAST YEAR", "NOTE: NOT SURE WHEN BUT FBG WAS HIGH") — skip.
  A lab passes the gate ONLY when (a) its value is stated as a definite number AND (b) its date is either an explicit calendar date from a recognised dated header, OR the current-visit anchor "today" (per the rules above). If either side is hedged, drop the lab — we want only values we are 100% sure about.
  WITHIN A SINGLE NOTE, the same canonical test on the same date must appear ONLY ONCE. If the document repeats the same test+date (e.g. an OBSERVATIONS block and a TODAY block both list FBS for the same visit), emit just one entry — choose the one with the most specific date.
  CRITICAL — distinguish measured results vs. target goals:
  • "FOLLOW UP TODAY ON <date>" / "FOLLOW UP NOTES(<date>)" / "FOLLOW UP ON <date>" sections that contain lab values ALONGSIDE clinical notes, C/O complaints, or symptoms = REAL HISTORICAL MEASUREMENTS from that date — extract as labs with that date.
  • "YOUR NEXT FOLLOW UP IS SCHEDULED ON <date>" / a plain date-only header followed only by FBG-X / PP-X target numbers (no clinical context) / sections explicitly labelled "TARGET" or "GOAL" = TARGET GOALS — do NOT extract as labs.
  • An "OBSERVATION" or "OBSERVATION-:" section header followed by "-TESTNAME-:VALUE" lines is an observations block — extract those values as real lab results. The "-:" suffix on the label is just formatting, NOT an absent marker.
  • A line like "FBG-115" under a future follow-up booking heading = target; but "FBG:105" under "FOLLOW UP TODAY ON 03/02/2026" alongside "C/O LOOSE MOTION" = real result from 03/02/2026.
- MEDICATION BRAND-SUFFIX FIDELITY — ABSOLUTE. Preserve every brand suffix EXACTLY as written in the source: XR, SR, MR, CR, ER, OD, LA, XL, MEX, MEZ, MD, M, DSR, DM, DS, AM, CT, CH, PLUS, CD, F, FORTE, TRIO, AT, H, etc. These suffixes denote specific formulations or composition variants and are clinically distinct (e.g. Diamicron XR MEX = gliclazide + metformin combo; Diamicron XR = gliclazide alone — they are DIFFERENT drugs). Do NOT "correct", normalise, drop, or substitute one suffix for another (e.g. NEVER change MEX→MR, MEZ→MR, DM→D, FORTE→F). If unsure how to spell a suffix, copy it verbatim from the source — character-for-character.
- MEDICATION DOSE UNIT FIDELITY — ABSOLUTE. Preserve dose units EXACTLY as written. Case-sensitive interpretation: a single uppercase "G" or "GM" or "g" or "gm" means GRAMS, while "MG"/"mg" means MILLIGRAMS — these differ by 1000× and a unit error is a serious clinical error. If the source says "60+1G", emit "60 mg + 1 g" (or "60+1 g" if the leading number's unit is implied by context) — NEVER coerce both to "mg". Likewise: "60K" or "60 K" (kilo / thousand) for vitamin D etc. → emit "60,000 units" or "60K IU" but NEVER "60 mg". "MCG"/"mcg"/"µg" = micrograms, distinct from mg. If a multi-component dose has different units per component (common for combo drugs like metformin + gliclazide where metformin is in grams and gliclazide is in milligrams), preserve each component's unit. When the source unit is ambiguous, copy it character-for-character rather than guessing.
- MEDICATION NAME FORMAT — STRICT. The "name" field is the BRAND NAME ONLY (or composition name for generics) — NEVER include a dosage-form prefix like "TAB", "TABLET", "INJ", "INJECTION", "CAP", "CAPSULE", "SYP", "SYRUP", "OINT", "OINTMENT", "CREAM", "GEL", "SPRAY", "DROPS", "SACHET", "POWDER", "LOTION", "INHALER", "SUSP", "PWD", or trailing punctuation. Move that information into the "form" field. Examples:
  • Source text "TAB SITACIP DM 10+100+500MG OD" → name: "Sitacip DM", form: "Tablet", dose: "10+100+500 mg", frequency: "OD", route: "Oral"
  • Source text "INJ. RYZODEG 8 UNIT S/C OD BEFORE BREAKFAST" → name: "Ryzodeg", form: "Injection", dose: "8 units", frequency: "OD", timing: "before breakfast", route: "SC"
  • Source text "CAP RABESEC DSR 20 MG OD" → name: "Rabesec DSR", form: "Capsule", dose: "20 mg", route: "Oral"
  • Source text "Ointment Candid B for local application" → name: "Candid B", form: "Ointment", route: "Topical"
  • Source text "DROPS MOISOL AS NEEDED" → name: "Moisol", form: "Drops", route: "Topical"
  This rule is ABSOLUTE — the "name" field must never start with TAB/INJ/CAP/SYP/OINT/etc. If you cannot identify the dosage form, set form: null, but still do NOT put the abbreviation inside name.
- MEDICATION ROUTE RULES — derive route from form when not explicit: Tablet/Capsule/Syrup/Suspension/Sachet/Powder → "Oral"; Injection → "SC" unless text says IM/IV; Ointment/Cream/Gel/Lotion/Spray/Drops/Patch → "Topical"; Inhaler/Nebulizer → "Inhaled"; Suppository → "Rectal"; Pessary → "Vaginal". For injections explicitly marked "S/C" or "SC" → "SC"; "I/M" or "IM" → "IM"; "I/V" or "IV" → "IV".
- WEEKLY / FORTNIGHTLY DAY EXTRACTION — When a medication frequency is "Once weekly", "weekly", "once in 14 days", "once in 15 days" "fortnightly", or similar, look for a weekday mention in the surrounding text ("on Sunday", "every Monday", "Tues & Thurs", "ON MON", etc.) and emit "days_of_week" as an integer array using 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat. Examples: "INJ WEGOVY 0.25MG SC ONCE WEEKLY ON SUNDAY" → days_of_week: [0]; "TAB METHOTREXATE 10MG ONCE WEEKLY EVERY MON" → days_of_week: [1]. For non-weekly meds (OD, BD, TDS, SOS, alternate day etc.) leave days_of_week null. If the source is weekly but names no specific day, also leave it null — the downstream pipeline will default it to the prescription's weekday.
- SUPPORT / CONDITIONAL MEDICATIONS — A drug listed as a remedy for the side-effects of another drug, or as a conditional/PRN cover for that drug, is a SUPPORT MEDICATION for the parent drug named immediately above it in the same TREATMENT block. Detect support meds by surrounding cues such as: "ADVERSE EFFECTS — …", "ADVISED TO TAKE … ON DAY 1 AND 2 OF INJECTION", "ON DAY 1/2 OF …", "SOS IN CASE OF …", "SOS FOR …", "IF NAUSEA/VOMITING/DIARRHOEA/ACIDITY", "PRN FOR …", "TO COVER …", "PROPHYLAXIS FOR …", "TO PREVENT …". For each such support drug:
  • Still extract it as a normal entry in the "medications" array with its own name/form/dose/frequency/route.
  • Set "support_for" to the parent drug's brand name — must match the "name" field of the parent entry in this same medications array character-for-character (so the post-processor can link them).
  • Set "support_condition" to a short phrase summarising the trigger ("for nausea/vomiting", "SOS for diarrhoea", "Day 1-2 prophylaxis").
  • For non-support medications (the parents themselves and standalone drugs), set both "support_for" and "support_condition" to null.
  EXAMPLE — input block:
    "INJ WEGOVY 0.125 MG S/C ONCE WEEKLY AT 9PM WITHHOLD
     ADVERSE EFFECTS – NAUSEA/VOMITING/DIARRHEA/ACIDITY
     ADVISED TO TAKE AMLA CANDY/TAB EMSET 8MG/TAB RANTAC ON DAY 1 AND 2 OF INJECTION
     CAP ROKO SOS IN CASE OF DIARRHEA"
  → five medications: Wegovy (support_for: null, support_condition: null) is the parent;
    Amla Candy, Emset, Rantac each carry support_for: "Wegovy", support_condition: "for nausea/vomiting/acidity on Day 1-2 of injection";
    Roko carries support_for: "Wegovy", support_condition: "SOS for diarrhoea".
  When the trigger text references multiple parent drugs, attach to the most recently listed parent above the trigger line. When unclear, set support_for to null and keep the entry as a top-level medication.
- For medications: parse CURRENT/TREATMENT medications with name, dose, frequency (OD/BD/TDS/SOS/alternate day etc). "PLAN FOR [drug]" or "PLANNED [drug]" in the ADVICE section = future treatment plan — do NOT extract as a current medication. For twice-daily insulin with different morning and evening doses (e.g. "12 units before breakfast / 8 units before dinner"), extract as ONE medication with dose "12 units (morning) + 8 units (evening)", frequency "BD", route "SC"., timing (before/after food etc), route (Oral/SC/IV/IM etc). Set is_new=true if it's a new addition. Also look for medications where dose has CHANGED (e.g. "NMZ 10 to NMZ 20") — the OLD dose should be in previous_medications. Also capture if note says "DOSE WAS REDUCED/INCREASED" for a medication — record it in previous_medications with reason "dose changed". For sliding scale insulin (different doses per meal), extract as ONE entry with dose as the range (e.g. "5-9 units") and frequency as "Thrice daily". Do NOT create separate entries per meal. Do NOT extract diagnoses, lab findings, clinical events (GMI, hypoglycemia, SGLT2 inhibitor-related events) or monitoring instructions as medications — only actual drugs/injections/ointments/supplements. IMPORTANT: A "-" or "–" at the START of a line in a medication list is a BULLET POINT, not an absent marker — extract it as a medication (e.g. "-PET SAFFA POWDER 1/2 TSP DAILY" → medication: "Pet Saffa Powder", dose: "1/2 tsp", frequency: "OD"). For injections: use route "SC" for subcutaneous (S/C), "IM" for intramuscular, "IV" for intravenous. Nutritional supplements (whey protein, protein powder, meal replacement) — extract as medications with route "Oral" and category implied by name. Powders like "Pet Saffa Powder" are laxative supplements — include as medications.
- WHEN_TO_TAKE — for EVERY entry in "medications", ALWAYS populate "when_to_take" as a JSON ARRAY (never a string, never null, never an empty array) using ONLY values from this exact vocabulary: ["Fasting", "Before breakfast", "After breakfast", "Before lunch", "After lunch", "Before dinner", "After dinner", "At bedtime", "SOS only", "Any time"]. Do not invent or paraphrase values. Map from the timing / frequency text:
  • "Empty stomach" / "30 min before food/breakfast" / "fasting" → ["Fasting"]
  • "Before breakfast" / "morning before food" → ["Before breakfast"]
  • "After breakfast" / "morning after food" → ["After breakfast"]
  • "Before lunch" → ["Before lunch"]; "After lunch" → ["After lunch"]
  • "Before dinner" / "night before food" → ["Before dinner"]; "After dinner" / "night after food" → ["After dinner"]
  • "Bedtime" / "HS" / "at night before sleep" → ["At bedtime"]
  • "With milk" → put the phrase "with milk" in the medication's instructions field; map when_to_take from the meal context (e.g. morning with milk → ["After breakfast"]) or fall back to ["Any time"]
  • "SOS" / "PRN" / "as needed" → ["SOS only"]
  • Generic "After meals" / "After food" without a specific meal → expand by frequency: OD → ["After breakfast"], BD → ["After breakfast","After dinner"], TDS → ["After breakfast","After lunch","After dinner"], QID → ["After breakfast","After lunch","After dinner","At bedtime"]
  • Generic "Before meals" / "Before food" without a specific meal → same expansion with "Before …" variants
  • If no timing text at all, INFER from drug class: Metformin → ["After breakfast"] (OD) or ["After breakfast","After dinner"] (BD); SGLT2i/DPP4i/Sulfonylureas → ["Before breakfast"]; Statins → ["At bedtime"]; Levothyroxine → ["Fasting"]; Aspirin → ["After lunch"]; PPIs (pantoprazole/omeprazole/rabeprazole) → ["Before breakfast"]; Antihypertensives (telmisartan/amlodipine/losartan) → ["After breakfast"]; Insulin basal → ["At bedtime"]; Insulin bolus/prandial → ["Before breakfast","Before lunch","Before dinner"] (match frequency); B12 / multivitamin / generic supplement → ["After breakfast"]
  • Last-resort fallback when nothing can be inferred: ["Any time"]. NEVER leave when_to_take empty or null.
- COMMON SIDE EFFECTS — for EVERY entry in "medications", populate the "common_side_effects" array with at MOST 3 entries describing the most clinically relevant common side effects of that drug (use general medical knowledge of the drug — these are NOT extracted from the note text, they are the well-known common side effects the patient should be aware of). Each entry has: name (short label, e.g. "Stomach upset / loose stools"), desc (one short patient-friendly line, e.g. "Take with food. Extended-release form helps."), severity ("common" for the typical mild ones, "uncommon" for less frequent, "warn" for rare-but-serious things the patient should seek help for — at most one "warn" entry). Order by importance: most common first. If the drug is a generic supplement / multivitamin / non-pharmacological item with no notable side effects, return []. Do NOT exceed 3 entries. Keep desc under 90 characters.
- For previous_medications: extract from "PREVIOUS MEDICATION" section + ANY medicines with dose/frequency changes. Capture: old/previous dose, medication name, status ("stopped" or "changed"), and reason (e.g. "side effect", "dose increased from 10mg to 20mg", "replaced by", "discontinued"). If dose changed (e.g. NMZ 10 became NMZ 20), extract NMZ 10 as previous_medication with reason "dose changed". IMPORTANT: Medications mentioned ONLY inside a historical "FOLLOW UP ON <past date>" section as one-off/acute treatments (e.g. "C/O FEVER, SO ON CIPLOX" in July 2024 section) are OLD historical prescriptions — do NOT add them to the current medications list.
- For symptoms: extract ALL chief complaints, presenting complaints, and reported symptoms from "C/O", "COMPLAINTS", "PRESENTING COMPLAINTS" sections (e.g. fatigue, weight gain, tremor, palpitations, pain). Each should have:
  • name: symptom label
  • duration: raw text duration (e.g. "3-4 months", "since last visit")
  • since_date: approximate YYYY-MM-DD date based on duration + context date (e.g. "since 3-4 months" from a Mar 2026 note → "2025-12-01"). Use null if no duration mentioned.
  • severity: "mild/moderate/severe" if explicitly mentioned, otherwise null
  • related_to: the diagnosis or condition this symptom is associated with if inferable (e.g. breathlessness + OSAS in same note → "OSAS"; pedal edema + heart failure → "Heart Failure"). Use null if not clear.
  Do NOT extract diagnoses as symptoms. [] if none found.
- For diagnoses: extract ALL conditions from the DIAGNOSIS section, both present and absent. Rules:
  • A "+" suffix or "+" marker means PRESENT → status: "Present", strip "+" from name (e.g. "NEUROPATHY+" → name: "NEUROPATHY", status: "Present").
  • A "-" suffix directly after the name (before any space or parenthesis) means ABSENT → status: "Absent", strip "-" from name (e.g. "CAD-" → name: "CAD", status: "Absent"; "NEPHROPATHY-(G1A1)" → name: "NEPHROPATHY", details: "G1A1", status: "Absent"; "NEPHROPATHY-(G2 A1)" → name: "NEPHROPATHY", details: "G2 A1", status: "Absent"; "NEUROPATHY-(G2 A2)" → name: "NEUROPATHY", details: "G2 A2", status: "Absent"). The "-" before "(" ALWAYS means Absent regardless of what is inside the parentheses. Also mark Absent if details say "absent", "negative", "no history of", "ruled out", "(-)", "not present".
  • Conditions with NO sign on their OWN LINE in a dedicated DIAGNOSIS/IMPRESSION section → status: "Present" (e.g. "HYPERTENSION", "BPH", "CENTRAL ADIPOSITY" each on their own line).
  • Conditions with NO sign listed INLINE on the SAME COMMA-SEPARATED LINE as absent "-" conditions (e.g. "CAD-, CVA-, PVD" — PVD has no sign but shares the absent line) → status: "Absent". This applies to ALL conditions including diabetic complications. Example: "NEUROPATHY-,NEPHROPATHY-(G2 A1),RETINOPATHY" → RETINOPATHY has no sign but is on the same comma-separated line as two "-" conditions → status: "Absent". Example: "CAD-, CVA-, PVD" → all three are Absent (PVD has no sign but shares the absent line).
  • "AOO-" or "AOO" means "Age of Onset" — it is NOT an absent marker. Do NOT change the status of the diagnosis it belongs to.
  • For conditions with parenthetical details like "NEPHROPATHY-(G1A1)" or "NEPHROPATHY(G1A?)" or "TYPE 2 DM (2025)", extract: name without parentheses and without the +/- sign (e.g. "NEPHROPATHY"), details = the parenthetical content (e.g. "G1A1"), status from the sign before the parenthesis.
  • Extract ALL diagnoses from the DIAGNOSIS section including: Type 2 DM, MASLD, DUAL ADIPOSITY, NEUROPATHY, NEPHROPATHY, RETINOPATHY, HYPERTENSION, PCOS, and any other conditions listed.
  • If the DIAGNOSIS section header is followed by an unclosed parenthesis like "DIAGNOSIS (\nCONDITION A\nCONDITION B" or "○ DIAGNOSIS ( DIAGNOSIS:" — treat each subsequent line as a separate Present diagnosis, do NOT treat the opening "(" or "○" as part of a diagnosis name.
  • Program/category labels in the DIAGNOSIS section (e.g. "INTENSIVE DIABETES MANAGEMENT PROGRAM", "COMPREHENSIVE CARE PROGRAM") are administrative headings — do NOT extract as diagnoses.
  • Clinical descriptors in the DIAGNOSIS section that are weight/lifestyle status (e.g. "NON OBESE", "OBESE", "OVERWEIGHT" if used as a descriptor not a standalone diagnosis, "NON SMOKER", "NON ALCOHOLIC") — extract only if they appear as standalone diagnoses on their own line without context. "NON OBESE" alone is a descriptor, not a diagnosable condition — do NOT extract it as a diagnosis.
  • "PAST MEDICAL/SURGICAL HISTORY" / "F/H/O" / "OBS HISTORY" / "MENSTRUAL HISTORY" / "OBSERVATION" sections contain background context — do NOT extract entries from these sections as active diagnoses. E.g. "B/L TKR", "RECURRENT HEMATOMA 2004", "BICORONAL APPROACH 2004", "BIOPSY - HEMARTOMA" are surgical/past history, not current diagnoses.
  • Lines starting with "H/O" (History Of) are past medical history — do NOT extract as diagnoses. E.g. "H/O COVID: +", "H/O AKI REQUIRING DIALYSIS 2022", "H/O OPIOID ADDICTION" should be ignored for diagnosis extraction.
  • "S/P" or "S/P POST OP" in a diagnosis name means "Status Post" (post-operative) — it is NOT an absent marker. E.g. "LEFT ORBIT HEMARTOMA- S/P POST OP -2004" → name: "LEFT ORBIT HEMARTOMA", details: "S/P Post Op 2004", status: "Present". The "-" before "S/P" is a dash separator, not an absent sign.
  • "CONDITION- POST [TREATMENT] (YEAR)" — a "-" followed by "POST" means the condition was historically present and treated. E.g. "AIDP- POST IVIG TRANSFUSION (2013)" → name: "AIDP", details: "Post IVIG Transfusion 2013", status: "Present" (historical/resolved).
  • A "?" inside parenthetical details does NOT make the diagnosis absent. E.g. "NEPHROPATHY(G2A?)" → name: "NEPHROPATHY", details: "G2A?", status: "Present". The "?" indicates diagnostic uncertainty about the sub-classification, not absence of the condition.
  • "NEUROPATHY+(DDSMP)" → name: "NEUROPATHY", details: "DDSMP", status: "Present". "RETINOPATHY+(LASERS DONE)" → name: "RETINOPATHY", details: "Lasers Done", status: "Present".
  • Run-together diagnosis text (e.g. "RETINOPATHYCAD-" or "PVDMASLD+") must be split into separate diagnoses: "RETINOPATHY" and "CAD-"; "PVD" and "MASLD+". Apply the +/- rules to each after splitting.
  • "TYPE 2 DM (C PEPTIDE-3.83, HOMA IR-4.99) (SINCE: 2023), AOO-35YRS" → name: "TYPE 2 DM", details: "C PEPTIDE-3.83, HOMA IR-4.99, Since 2023, AOO 35 yrs", status: "Present". The numbers inside are diagnosis context values — do NOT re-extract them as current lab results (they have their own dated entry elsewhere).
  • "PANCREATIC EXOCRINE INSUFFICIENCY (FE: 44.20)" → name: "PANCREATIC EXOCRINE INSUFFICIENCY", details: "FE: 44.20", status: "Present". Also extract FE 44.20 as a lab result (test: "Fecal Elastase", value: "44.20") with date: null.
  • "PREDIABETES (GTT FBG 76.7,2HR BG 140,HBA1C:5.8%)" → name: "PREDIABETES", details: "GTT FBG 76.7,2HR BG 140,HBA1C:5.8%". Do NOT re-extract the numbers inside diagnosis parentheses as separate lab results.
  • Sub-bullets under a parent diagnosis (indented lines starting with "-" or "•") are FEATURES of that parent, not separate absent diagnoses. Example: under "PCOS:", the lines "-SECONDARY AMENORRHEA", "-FGS - 14/36, ACNE: GRADE 2", "-USG: PCOM+" are PCOS features. Extract them as Present sub-diagnoses or details — do NOT mark them Absent just because they have a leading "-".
  • "ACNE: GRADE 2" → name: "ACNE", details: "Grade 2", status: "Present". "SECONDARY AMENORRHEA" as a sub-bullet under PCOS → Present diagnosis.
  • "USG: PCOM+" or "USG: PCOM" → this is a USG finding (Polycystic Ovarian Morphology on ultrasound) that confirms PCOS — do NOT create a separate diagnosis entry for PCOM. Add it as details on the PCOS diagnosis instead.
  • "FGS - 14/36" in the DIAGNOSIS section is a Ferriman-Gallwey Score value, NOT an absent diagnosis. Extract as a lab result (test: "FGS", value: "14/36") — do NOT create a diagnosis entry for it.
- For vitals: return an ARRAY with ONE entry per DATED section that contains vital values. Each entry must carry the date of the section it came from.
  • "FOLLOW UP TODAY ON <date>" / "FOLLOW UP TODAY:<date>" / "FOLLOW UP TODAY - <date>" / "FOLLOW UP TODAY <date>" / "FOLLOW UP TODAY(<date>)" / "FU TODAY <date>" / "F/U TODAY <date>" → date = that date (NOT today's calendar date — use the literal date written after "FOLLOW UP TODAY")
  • "FOLLOW UP ON <date>" / "FOLLOW UP:<date>" / "FOLLOW UP NOTES(<date>)" / "FOLLOW UP NOTES:<date>" → date = that date
  • Any other dated section that contains vital values → date = that date
  CRITICAL — "FOLLOW UP TODAY: <date>" (and all its variants above) means "this is the log from the visit on <date>" — the word TODAY refers to that date, not the current real-world date. Any HT/WT/BMI/BP/WC/BF written underneath such a header MUST be emitted as a vitals entry whose date equals that header's date. If the note has multiple "FOLLOW UP TODAY" blocks at different dates, emit ONE vitals entry per block. Never collapse them; never assign today's calendar date.
  Dates come in DD/MM/YYYY (Indian format) — convert to YYYY-MM-DD.
  Extract HT/WT/BMI/BP(sitting)/WC(waist circumference)/BF(body fat) into the entry for that date.
  For BP: "BP SITTING: 165/97 SITTING" — the trailing word "SITTING" is a label duplication error, extract bpSys:165, bpDia:97. "BP STANDING: 152/93" is standing BP — SKIP, do not emit into vitals (we track sitting BP only).
  For undated "OBSERVATIONS" / "OBSERVATION-:" / "VITAL SIGNS" / "TODAY" / "PATIENT VISITED TODAY" blocks (no explicit date in or above the header), apply the same carried-forward judgment used for labs above:
    • If the OBSERVATIONS block is the FIRST or PRIMARY block in the note, there is NO older dated header above it, AND there is NO dated follow-up block below it, treat it as the CURRENT visit → emit a vitals entry with date: "today". The downstream pipeline anchors "today" to the prescription's own visit date, so HT/WT/BMI/BP etc. recorded under an undated current-visit OBSERVATIONS block are kept and dated to the prescription date.
    • CUMULATIVE NOTE (same structural rule as labs): if one or more dated follow-up blocks appear BELOW the undated OBSERVATIONS block, that block is the enrollment baseline — do NOT emit it with date "today". Emit the vitals entry for each dated follow-up block under that block's own date instead. Marking the baseline as "today" would make the patient's enrollment weight and BP overwrite the current visit's readings.
    • If the OBSERVATIONS block is NESTED INSIDE an older dated header (e.g. "FOLLOW UP NOTES(20-03-24): … OBSERVATIONS: BP-140/90"), it is HISTORICAL — emit the vitals entry with the outer header's date (YYYY-MM-DD).
    • Only DROP the block (emit nothing) when there is no judgment available, no outer dated header, AND no signal that this is the current visit — in that rare case the date is genuinely unknown.
  DO NOT emit entries from:
    • "TARGET" / "GOAL" / "YOUR NEXT FOLLOW UP IS SCHEDULED ON <date>" sections (these are future targets, not measurements)
    • Numbers inside a diagnosis parenthetical (e.g. "TYPE 2 DM (HBA1C:7)") — those are diagnosis context, not a measurement event
  DATE-CERTAINTY GATE FOR VITALS — same principle as labs: only emit a vital when the date is 100% certain. SKIP the entry (do NOT emit at all) when the value or its date is hedged. Triggers include:
    • Hedged value: "MAY BE BP 130/80", "WT AROUND 80", "APPROX 82", "~80", "?80", "PROBABLY", "POSSIBLY", "NOT SURE", "PATIENT SAYS MAYBE".
    • Hedged date: "MAY BE LAST MONTH", "APPROX 6 MONTHS BACK", "AROUND SEPT", "NOT SURE WHEN", "?DATE", "SOMETIME IN <month>", "POSSIBLY IN <month/year>".
    • Observation/aside in another section that records a vital with a hedge (e.g. "OBSERVATION: PATIENT MENTIONS WT MAY BE 85 LAST YEAR") — skip.
  A vitals entry passes the gate ONLY when every numeric field in it has a definite value AND the entry's date is either an explicit calendar date from a recognised header, or the current-visit "today" anchor. If either side is hedged, drop the entry. We want only vitals we are 100% sure about.
  If no section contains vitals that pass the gate, return [] (empty array).
- For lifestyle: SPLIT into separate fields. Set to null if not found — do NOT put medication instructions, monitoring instructions, or follow-up advice here:
  - diet: ONLY calorie/protein/food plan (e.g. "1400 kcal with 60g protein"). Must mention kcal/calories/protein/food. Null if not found
  - exercise: ONLY physical activity like steps, walking, gym (e.g. "10,000 steps daily"). Must mention steps/walk/exercise. Null if not found
  - smoking: ONLY if explicitly mentioned. Null if not found
  - alcohol: ONLY if explicitly mentioned. Null if not found
  - stress: ONLY if explicitly mentioned. Null if not found
- For advice: glucose monitoring instructions (e.g. "D1-FASTING AND 2HR POST BREAKFAST, D3-..., D5-..."), insulin titration rules (e.g. "increase evening dose by 1 unit per day till post dinner 150 and fasting 100"), TSH targets, medication holds, other clinical instructions. Null if not found. Do NOT put glucose monitoring schedules into medications.
- For investigations_to_order: extract ALL tests/investigations ordered or recommended. Set urgency to "urgent" if marked urgent, "next_visit" if scheduled for next visit, "routine" otherwise. [] if none found
- For follow_up: extract the NEXT scheduled follow-up (the appointment the doctor is booking AT THE END OF this visit, for a future date). Fields: date (YYYY-MM-DD if exact date given), timing (e.g. "1 month", "3 months"), notes. Null fields if not found.
  • The NEXT follow-up is signalled by phrases like "NEXT FOLLOW UP", "NEXT FOLLOW UP ON", "YOUR NEXT FOLLOW UP IS SCHEDULED ON", "REVIEW ON", "REVISIT ON", "F/U ON", "RTC ON", "come back after X weeks/months", "FOLLOW UP AFTER X DAYS/WEEKS/MONTHS", "FOLLOW UP AFTER X MONTHS WITH <tests>", "FOLLOW UP IN X WEEKS/MONTHS", "FOLLOW UP WITH IN X MONTHS", "FOLLOW UP WITHIN X MONTHS", "REVIEW AFTER X WEEKS/MONTHS", "F/U AFTER X MONTHS", "RTC AFTER X MONTHS", or a plain future date under a "NEXT FOLLOW UP" / "PLAN" header.
  • CRITICAL — a header like "FOLLOW UP TODAY ON <date>" / "FOLLOW UP ON <past date>:" / "FOLLOW UP NOTES(<past date>)" that is followed by lab values, vitals, or C/O complaints is a PAST visit log entry (the doctor is recording what happened previously). Those are NOT the next follow-up and must be IGNORED when choosing follow_up.
  • A relative phrase IMMEDIATELY FOLLOWED BY A DATE is also a past log header, not a booking — e.g. "FOLLOW UP AFTER 3 MONTHS 24/4/23:\nFBG: 120" means "the follow-up that was due after 3 months happened on 24/4/23". Ignore it and keep looking for an undated relative phrase later in the note.
  • If multiple "FOLLOW UP" sections appear, pick the one whose date is chronologically LATEST AND is strictly in the future relative to the note's own visit date. If every dated "FOLLOW UP" section is a past log entry, then follow_up.date = null (use timing/notes only if the note also says something like "come back after 1 month").
  • If only a relative phrase is given (e.g. "review in 2 weeks"), put that in timing and leave date null — do NOT compute the date.
  • UNDATED "FOLLOW UP" LINE = THE NEXT FOLLOW-UP. The past-log rule above applies ONLY to headers that name a date. A "FOLLOW UP …" line carrying NO date, and not followed by lab values / vitals / C/O complaints, is the next follow-up — never a past log. This is the single most commonly missed case: notes that END with "FOLLOW UP AFTER 3 MONTH" or "FOLLOW UP AFTER 3 MONTHS WITH FPG, PPBG CHARTING, HBA1C, LIPIDS, CREATININE, UACR", usually the last line after the TREATMENT block. Returning follow_up: null for such a note is WRONG.
    EXAMPLE: note tail "…INJ NEUROBION FORTE 500 MCG I/M WEEKLY FOR 5 WEEKS\n\nFOLLOW UP AFTER 3 MONTH\nFOLLOW UP AFTER 3 MONTHS WITH FPG, PPBG CHARTING, HBA1C, LIPIDS, CREATININE, UACR"
    → follow_up: {"date": null, "timing": "3 months", "notes": "With FPG, PPBG charting, HbA1c, Lipids, Creatinine, UACR"} and follow_up_with: "FPG, PPBG CHARTING, HBA1C, LIPIDS, CREATININE, UACR"
  • TIMING FORMAT — always write timing as a plain digit + unit, lower case, pluralised: "3 months", "6 weeks", "10 days", "1 year". Downstream code counts that interval from the visit date, so "3 MONTH", "three months", "3/12" or "quarterly" are NOT acceptable — normalise them to "3 months".
- For follow_up_with: capture the ENTIRE free-text block that follows the heading "FOLLOW UP WITH" (or "Follow up with", "FOLLOWUP WITH", "Next visit instructions") — including the prep instructions AND the trailing list of tests/labs the patient must bring. This is ONE field, not split. Read until you hit a hard section break: a new heading, a blank line followed by a non-prep heading, a closing parenthesis ")" that closes the surrounding block, or end of note. Do NOT stop early at the first period / "HRS" / "AM" — the trailing list of tests after those words is part of the same instruction and MUST be preserved.
  EXAMPLE (the entire run-on string is one value, tests included):
    Input: "FOLLOW UP WITH FASTING SAMPLE AT GINI HEALTH 8:30AM AFTER OMISSION OF ANTIDIABETIC MEDICATION FOR 24 HRS FBG ,FPI,C-PEPTIDE ,HBA1C ,CREATININE ,URINE ACR ,LIPIDS . )"
    → follow_up_with: "FASTING SAMPLE AT GINI HEALTH 8:30AM AFTER OMISSION OF ANTIDIABETIC MEDICATION FOR 24 HRS — FBG, FPI, C-PEPTIDE, HBA1C, CREATININE, URINE ACR, LIPIDS"
  Normalisation rules INSIDE the captured string: collapse runs of whitespace; tidy " ,X" → ", X"; preserve original line breaks as \\n; drop the trailing closing-paren / lone period; strip the literal heading words "FOLLOW UP WITH" themselves. Do NOT include the next-visit date (that maps to follow_up). Set to null only when no such block exists.
- CRITICAL — all dates in these notes are in DD/MM/YYYY format (Indian standard). "06/04/2026" means April 6 2026 → output as 2026-04-06. NEVER interpret as MM/DD/YYYY.
- Return ONLY valid JSON, no markdown`;

export const PRESCRIPTION_EXTRACTION_PROMPT = `
STRUCTURED-OUTPUT OVERRIDES (these supersede any "set to null" instruction above — the response schema is strict and does not allow null):
STRICT Rules:
- NEVER invent or assume data. If a field is not explicitly mentioned in the text, set it to null. Do NOT fill fields with unrelated data.
- NO-PRESCRIPTION FALLBACK (treat Diagnosis summary AS the prescription): Some visits have NO separate MEDICATIONS/PRESCRIPTION section — the doctor instead wraps the entire plan as free text inside a single diagnosis parenthetical after a program label, e.g. "INTENSIVE DIABETES MANAGEMENT PROGRAM ( TYPE 2 DM (SINCE 2018) … TREATMENT: -INJ. RYZODEG 8 UNIT … -TAB SITACIP DM 10+100+500MG OD … PREVIOUS MEDICATION -TAB GLIMESTAR M2 … OBSERVATION-: -FBG-:251.7 … FOLLOW UP ON 26/6/25: … HBA1C: 7 … ADVICE: … )". When you see this pattern, treat that parenthetical AS THE PRESCRIPTION — extract medications, previous_medications, labs, vitals, follow_up, investigations_to_order, and advice from the labelled sub-blocks inside it exactly as if each sub-block had been its own top-level section of the note. Do NOT discard the parenthetical because its outer name (e.g. "INTENSIVE DIABETES MANAGEMENT PROGRAM") is a program label. The inner real diagnoses (TYPE 2 DM, NEUROPATHY, NEPHROPATHY, RETINOPATHY, HYPERTENSION, MASLD, CAD, etc.) are what get extracted as diagnoses — the program label itself is skipped.
- TREATMENT: block = CURRENT medications. Any drug listed under a "TREATMENT:" / "TREATMENT PLAN:" / "CURRENT TREATMENT:" label — whether that label sits in its own section or inside a diagnosis parenthetical — is a CURRENT medication. Put it in "medications", NOT "previous_medications". A leading "-" or "•" on each line is a bullet, not an absent marker. Example: "TREATMENT: -INJ. RYZODEG 8 UNIT ONCE DAILY 30MIN BEFORE BREAKFAST -TAB SITACIP DM 10+100+500MG ONCE DAILY 30 MINUTES BEFORE BREAKFAST -TAB GLIZID M XR 60+500MG ONCE DAILY 30 MINUTES BEFORE DINNER" → three current medications (Ryzodeg 8U SC OD before breakfast, Sitacip DM 10+100+500mg Oral OD before breakfast, Glizid M XR 60+500mg Oral OD before dinner). "REST CONTINUE AS ADVISED BY CARDIOLOGIST" is an instruction — do NOT extract as a medication.
- PREVIOUS MEDICATION block inside a diagnosis parenthetical = previous_medications with status "stopped" (unless the text explicitly says the dose was changed, in which case status "changed"). Reason is "replaced" / "discontinued" / "dose changed" based on context; use "replaced" as the default when the TREATMENT block contains a different regimen.
- For labs: extract ALL lab values with test name, numeric value, unit. Include HbA1c, FBG, PPBG, LDL, TG, HDL, Non-HDL, Cholesterol (Total), TSH, T3, T4, Creatinine, eGFR, UACR, Hb, Iron, Ferritin, OT/SGOT, PT/SGPT, ALP, Calcium, Albumin, GTT, Insulin, C-Peptide, HOMA-IR, HOMA-Beta, Uric Acid, FIB4, Vitamin D, Vitamin B12, AMH, Testosterone, DHEAS, Prolactin, LH, FSH, Estradiol, Progesterone, FPI, Amylase, Lipase, Fecal Elastase (FE), VPT (Vibration Perception Threshold — extract R and L values separately as "VPT Right" / "VPT Left"), ABI (Ankle-Brachial Index — extract as "ABI Right" / "ABI Left"), Hirsutism Score/FGS/H.Score, Potassium, Sodium, Anti-TPO, Anti-Tg, Anti-tTG (tTG), etc.
  TEST-NAME NORMALISATION — doctors frequently abbreviate or mistype. Normalise these to the canonical names even when the source text uses the variant: "HOMO IR"/"HOMO-IR" → "HOMA-IR"; "HOMO BETA"/"HOMO-BETA" → "HOMA-Beta"; "C-PPETIDE"/"C PPETIDE" → "C-Peptide"; "FCP"/"C-PEPTIDE (FASTING)" → "C-Peptide"; "NHDL"/"NON HDL" → "Non-HDL"; "CRT"/"S CREAT"/"S.CREAT"/"Creatinine, Serum"/"Creatinine Serum"/"Serum Creatinine" → "Creatinine"; "Creatinine, Urine"/"Urine Creatinine"/"Creatinine (Urine)"/"Creatinine- Urine" → "Creatinine, Urine" (IMPORTANT: keep distinct — urine creatinine is a separate test used only for ACR calculation; do NOT normalize to "Creatinine"); "T CHOL"/"T.CHOL"/"TCHOL"/"TOTAL CHOL" → "Total Cholesterol"; "TG"/"TGL"/"S.TG"/"S TG"/"TRIG" → "Triglycerides" (CAUTION: "TG" is TRIGLYCERIDES, never Total Cholesterol — do not confuse the two, they are different tests and swapping them corrupts the lipid panel); "FPG" → "FBS"; "FBG" → "FBS"; "PPG" → "PPBS"; "RBG" → "RBS"; "FPI" → "Fasting Insulin"; "TTG" → "Anti-tTG"; "OT" → "SGOT (AST)"; "PT" → "SGPT (ALT)" (unless the surrounding context clearly discusses coagulation in which case keep as "Prothrombin Time"). Output the canonical name in the test field. Do NOT preserve the raw abbreviation — downstream storage relies on the canonical form.
  DO NOT emit vital-sign fields (Height, Weight, BMI, Waist/WC, Body Fat/BF, Systolic BP, Diastolic BP, Pulse/HR, SpO2) as entries in the labs array. Those belong in the vitals array ONLY. If the clinician wrote "HT-167 WT-83 BMI-29" inside a dated follow-up, put them in vitals for that date — never also in labs. This rule holds regardless of whether the section uses dashes ("HT-167") or spaces ("HT 167").
  IMPORTANT — do NOT extract family history values as patient labs. Lines like "FATHER - TG-329, LDL-94" / "MOTHER- TG-132" / "BROTHER - TG-510" are family history — skip entirely.
  Also extract: Urine Pus Cells (e.g. "URINE RE-8 PUS CELLS" → test: "Urine Pus Cells", value: "8"), Amylase, Lipase, Fecal Elastase, GAD65 antibody / IAA / IA2 / ZnT8 autoantibody results (e.g. "GAD65/IAA/IA2 PANEL NEGATIVE" → extract as test: "GAD65/IAA/IA2 Panel", value: "Negative"), Random C-Peptide (e.g. "RANDOM C PEPTIDE-3.47" → test: "C-Peptide (Random)", value: "3.47").
  BRIEF HISTORY section may contain historical HbA1c or glucose readings — extract these as real lab results with whatever date context is available (e.g. "HBA1C-8 IN SEPT,25" → test: "HbA1c", value: "8", date: "2025-09-01"). If no date given, use date: null.
  IMPORTANT — DEDUPLICATION: If the same test with the SAME numeric value appears in both an OBSERVATIONS section (no date) AND a FOLLOW UP section (with a specific date), extract it ONLY ONCE using the follow-up date (which is more specific). Do NOT create two entries for the same value. Example: OBSERVATIONS has "HBA1C-7" (no date) and FOLLOW UP ON 26/6/25 has "HBA1C-7" → extract ONE entry: {test: "HbA1c", value: "7", date: "2025-06-26"}. However, if the same test appears with DIFFERENT values in different sections (e.g. HbA1c 8 in history vs. HbA1c 7 in follow-up), extract EACH as a separate entry — these are genuinely different measurements from different time points.
  DATE-ATTRIBUTION FOR LABS — every lab in the note sits under (or after) some date header. Find the nearest preceding date header and use its date as that lab's date (YYYY-MM-DD). Recognised date headers include:
    • "FOLLOW UP ON <date>" / "FOLLOW UP TODAY ON <date>" / "FOLLOW UP TODAY:<date>" / "FOLLOW UP TODAY - <date>" / "FOLLOW UP TODAY <date>" (no separator) / "FOLLOW UP TODAY(<date>)" / "FU TODAY <date>" / "F/U TODAY <date>"
    • "FOLLOW UP NOTES(<date>)" / "FOLLOW UP NOTES ON <date>" / "FOLLOW UP NOTES:<date>" / "FOLLOW UP NOTES <date>"
    • "FOLLOW UP WITH <date>" / "FOLLOW UP:<date>" / "FOLLOW UP - <date>" (treat same as FOLLOW UP ON)
    • "PREVIOUS RECORD ON <date>" / "RECORD ON <date>" / "VISIT ON <date>" / "SEEN ON <date>"
    • A standalone "ON <date>" line (e.g. "ON 4TH JUNE 2023") — treat as a date header for labs that follow it
    • Natural-language dates: "5TH MARCH 2023", "24th DECEMBER 2024", "6th NOVEMBER 2023", "3rd APRIL 2024" — parse to YYYY-MM-DD
    • Dash-separated Indian dates: "26-03-24", "11-11-23" = DD-MM-YY → YYYY-MM-DD
    • Parenthesised dates: "(18/06/2024)", "(03-08-24)"
  CRITICAL — "FOLLOW UP TODAY: <date>" / "FOLLOW UP TODAY ON <date>" is the MOST COMMON pattern and is FREQUENTLY MIS-ATTRIBUTED. The word "TODAY" does NOT mean use today's actual calendar date — it means "the date listed on this header IS the visit date for everything below it". EVERY lab, vital, biomarker, BP, weight, HbA1c, FBG, etc. that appears AFTER such a header and BEFORE the next date header MUST carry the header's date. Do NOT use today's date. Do NOT use the note's overall visit_date. Use the EXACT date written in the FOLLOW UP TODAY header. This rule is absolute.
  EXAMPLE: Note contains "FOLLOW UP TODAY: 15/03/2025\nBP-130/80\nHBA1C-7.2\nWT-82". ALL three values get date "2025-03-15", not today's date, not the note's header visit_date. If later the note also has "FOLLOW UP TODAY ON 20/04/2025\nBP-125/78\nHBA1C-6.8", those three carry "2025-04-20". These are TWO separate dated visit logs inside one note — emit TWO vitals entries and six lab entries with their respective dates.
  "TODAY (<date>)" / "DATE: TODAY <date>" / "TODAY - <date>" — when the prescription literally writes the word TODAY immediately followed/preceded by an explicit date, use THAT explicit date for all labs in that section.
  Bare "TODAY" / "DATE: TODAY" / "OBSERVATION TODAY" / "OBSERVATIONS" / "PATIENT VISITED TODAY" with NO surrounding older dated header — set date: "today". This represents the CURRENT visit. Do NOT invent a calendar date. The downstream pipeline anchors "today" to the prescription's own visit date.
  DATED FOLLOW-UP BLOCK — DEFINITION (referenced by the rules below): a section header that names a specific visit date, in ANY of these spellings — "FOLLOW UP ON <date>", "FOLLOW UP TODAY:<date>", "FOLLOW UP TODAY ON <date>", "FOLLOW UP <date>", "FOLLOW UP NOTES(<date>)", "F/U ON <date>", "FU <date>", "REVIEW ON <date>", "VISIT ON <date>", "SEEN ON <date>", "LABS (<date>)", "OBSERVATION ON <date>", "OBSERVATIONS ON <date>" — with or without a colon, and with the date in any Indian format ("29/7/26", "29-07-2026", "29.7.26", "29TH JULY 2026"). These are all the same thing: a dated visit log inside the note. Wherever a rule says "dated follow-up block" it means ANY of these spellings — NEVER only the literal words "FOLLOW UP ON".
  EXCEPTION — OBSERVATIONS SKIPPED WHEN MATCHING FOLLOW UP EXISTS: If the user message begins with "Visit date: YYYY-MM-DD" AND the note contains a dated follow-up block whose date matches that visit date → do NOT assign date "today" to OBSERVATIONS labs. Skip OBSERVATIONS labs entirely — the dated follow-up block for the visit date is the authoritative source and OBSERVATIONS is the historical baseline.
  CUMULATIVE NOTE — STRUCTURAL RULE: doctors keep ONE note per patient and APPEND a new dated follow-up block at each visit, so the same note is re-sent, longer, every time. In such a note the undated "OBSERVATION" / "OBSERVATIONS" block at the TOP is the ENROLLMENT BASELINE from the patient's FIRST visit — it is NEVER the current visit. Therefore: if ONE OR MORE dated follow-up blocks appear ANYWHERE BELOW an undated OBSERVATIONS block, that OBSERVATIONS block is HISTORICAL — do NOT date it "today". "No older dated header ABOVE it" is NOT sufficient evidence that OBSERVATIONS is current; you must ALSO confirm there is no dated follow-up block BELOW it.
  CRITICAL — USE INTELLIGENCE TO DETECT CARRIED-FORWARD HISTORICAL TEXT. HealthRay clinical notes frequently copy prior visits' notes verbatim into a new note. The word "TODAY" inside a sub-block does NOT always mean the current visit — it can mean "today" as written when that block was originally authored. Apply this judgment:
    • If "PATIENT VISITED TODAY" / "TODAY" / "OBSERVATIONS" sits NESTED INSIDE an outer explicitly-older dated header — most often "FOLLOW UP NOTES(<old-date>):" but also "FOLLOW UP ON <old-date>:" / "VISIT ON <old-date>:" — and the note ALSO contains a separate later section that is clearly the real current visit (e.g. another "FOLLOW UP ON <recent-date>", "LABS (<recent-date>)", or fresh complaints/symptoms keyed to today), then the inner "TODAY" is HISTORICAL and refers to the OUTER header's date, NOT the current visit. Attribute those labs to the outer header's date (YYYY-MM-DD).
    • If the only dated context for a "TODAY" / "OBSERVATIONS" block is an older header AND there's no clearly-newer section, still prefer the outer header's date over today — this is likely historical context the doctor is reviewing.
    • If "TODAY" / "OBSERVATIONS" is the FIRST or PRIMARY block in the note, there is no older dated header above it, AND there is no dated follow-up block anywhere below it, treat it as the current visit → date: "today". EXCEPTIONS — this bullet does NOT apply, and OBSERVATIONS labs are skipped entirely, when EITHER (a) the user message starts with "Visit date:" and the note has a dated follow-up block matching that visit date, OR (b) the note contains any dated follow-up block below the OBSERVATIONS block (cumulative note — OBSERVATIONS is the enrollment baseline).
  EXAMPLE (carried-forward, P_137100 pattern):
    "FOLLOW UP NOTES(20-03-24):\n…\nPATIENT VISITED TODAY\nHBA1C : 11.5\nFPG : 112\n…\nFOLLOW UP ON 4/5/26 (PROXY VISIT)\n…\nLABS (19/4/26) S CREAT-1.00 HBA1C-7.9"
    → HBA1C 11.5 and FPG 112 carry date "2024-03-20" (inherited from the outer FOLLOW UP NOTES(20-03-24) header — they were the labs from THAT old visit, copied forward).
    → S CREAT 1.00 and HBA1C 7.9 carry date "2026-04-19" (from "LABS (19/4/26)").
    → Neither set is "today" — the current visit on 2026-05-04 has no fresh lab values of its own.
  EXAMPLE (real current OBSERVATIONS, not carried forward):
    "C/O HEADACHE\nOBSERVATIONS:\nBP-130/80\nFBS-110\nDIAGNOSIS: T2DM\nTREATMENT: …"
    → BP and FBS carry date: "today" — there is no older dated header above OBSERVATIONS **and no dated follow-up block below it**, so this is the current visit.
  EXAMPLE (cumulative note — OBSERVATIONS is the baseline, NOT today):
    Visit date: 2026-07-29. Note: "…PREVIOUS MEDICATION NIL\nOBSERVATION\nHT 152.5\nBP 148/95\nFBG 171.4\nHBA1C 8.8\nLDL 167.6\n…\nFOLLOW UP TODAY:18/6/26\nBP 122/79\nFBG 150\nPP 195\n\nFOLLOW UP TODAY:29/7/26\nBP 136/88\nFBG 82.3\nHBA1C 6.4\nLDL 50.6\n…"
    → The OBSERVATION block is the enrollment baseline — "FOLLOW UP TODAY:<date>" IS a dated follow-up block, and two of them sit below it. Emit NOTHING from OBSERVATION: no FBG 171.4, no HBA1C 8.8, no LDL 167.6, not even tests that appear only there.
    → FBG 150 and PP 195 carry "2026-06-18". FBG 82.3, HBA1C 6.4 and LDL 50.6 carry "2026-07-29".
    → Emitting FBG 171.4 with date "2026-07-29" is the exact error this rule exists to prevent: it makes the patient's enrollment baseline look like today's lab and buries the real result.
  If a lab is listed under no dated section at all (top-of-note BRIEF HISTORY with no date, free-floating values, and no judgment can attribute a date), set date: null. The downstream pipeline SKIPS undated labs entirely (it does not fall back to the appointment date) — so a null-dated value will be DROPPED. Prefer inferring a date (outer header, "today" for current-visit blocks) over emitting null.
  DATE-CERTAINTY GATE FOR LABS — only emit a lab when the date is 100% certain. SKIP the lab entirely (do NOT emit it at all, do NOT emit with date: null, do NOT guess) when ANY of these uncertainty cues surround the value or its date:
    • Hedged value: "MAY BE HBA1C 7", "PROBABLY FBG ~110", "AROUND 200", "APPROX 7", "~7", "?7", "NOT SURE OF VALUE", "POSSIBLY", "LIKELY", "I THINK", "PATIENT SAYS MAYBE".
    • Hedged date: "AROUND SEPT 2025", "APPROX 6 MONTHS BACK", "MAY BE LAST YEAR", "NOT SURE OF DATE", "?DATE", "SOMETIME IN MARCH", "POSSIBLY IN <month>", "PROBABLY <month>", "MAY BE IN <month/year>".
    • Observation/aside in another section that records a value with a hedge (e.g. "OBSERVATION: PATIENT MENTIONS HBA1C MAY BE 7 LAST YEAR", "NOTE: NOT SURE WHEN BUT FBG WAS HIGH") — skip.
  A lab passes the gate ONLY when (a) its value is stated as a definite number AND (b) its date is either an explicit calendar date from a recognised dated header, OR the current-visit anchor "today" (per the rules above). If either side is hedged, drop the lab — we want only values we are 100% sure about.
  WITHIN A SINGLE NOTE, the same canonical test on the same date must appear ONLY ONCE. If the document repeats the same test+date (e.g. an OBSERVATIONS block and a TODAY block both list FBS for the same visit), emit just one entry — choose the one with the most specific date.
  CRITICAL — distinguish measured results vs. target goals:
  • "FOLLOW UP TODAY ON <date>" / "FOLLOW UP NOTES(<date>)" / "FOLLOW UP ON <date>" sections that contain lab values ALONGSIDE clinical notes, C/O complaints, or symptoms = REAL HISTORICAL MEASUREMENTS from that date — extract as labs with that date.
  • "YOUR NEXT FOLLOW UP IS SCHEDULED ON <date>" / a plain date-only header followed only by FBG-X / PP-X target numbers (no clinical context) / sections explicitly labelled "TARGET" or "GOAL" = TARGET GOALS — do NOT extract as labs.
  • An "OBSERVATION" or "OBSERVATION-:" section header followed by "-TESTNAME-:VALUE" lines is an observations block — extract those values as real lab results. The "-:" suffix on the label is just formatting, NOT an absent marker.
  • A line like "FBG-115" under a future follow-up booking heading = target; but "FBG:105" under "FOLLOW UP TODAY ON 03/02/2026" alongside "C/O LOOSE MOTION" = real result from 03/02/2026.
- MEDICATION BRAND-SUFFIX FIDELITY — ABSOLUTE. Preserve every brand suffix EXACTLY as written in the source: XR, SR, MR, CR, ER, OD, LA, XL, MEX, MEZ, MD, M, DSR, DM, DS, AM, CT, CH, PLUS, CD, F, FORTE, TRIO, AT, H, etc. These suffixes denote specific formulations or composition variants and are clinically distinct (e.g. Diamicron XR MEX = gliclazide + metformin combo; Diamicron XR = gliclazide alone — they are DIFFERENT drugs). Do NOT "correct", normalise, drop, or substitute one suffix for another (e.g. NEVER change MEX→MR, MEZ→MR, DM→D, FORTE→F). If unsure how to spell a suffix, copy it verbatim from the source — character-for-character.
- MEDICATION DOSE UNIT FIDELITY — ABSOLUTE. Preserve dose units EXACTLY as written. Case-sensitive interpretation: a single uppercase "G" or "GM" or "g" or "gm" means GRAMS, while "MG"/"mg" means MILLIGRAMS — these differ by 1000× and a unit error is a serious clinical error. If the source says "60+1G", emit "60 mg + 1 g" (or "60+1 g" if the leading number's unit is implied by context) — NEVER coerce both to "mg". Likewise: "60K" or "60 K" (kilo / thousand) for vitamin D etc. → emit "60,000 units" or "60K IU" but NEVER "60 mg". "MCG"/"mcg"/"µg" = micrograms, distinct from mg. If a multi-component dose has different units per component (common for combo drugs like metformin + gliclazide where metformin is in grams and gliclazide is in milligrams), preserve each component's unit. When the source unit is ambiguous, copy it character-for-character rather than guessing.
- MEDICATION NAME FORMAT — STRICT. The "name" field is the BRAND NAME ONLY (or composition name for generics) — NEVER include a dosage-form prefix like "TAB", "TABLET", "INJ", "INJECTION", "CAP", "CAPSULE", "SYP", "SYRUP", "OINT", "OINTMENT", "CREAM", "GEL", "SPRAY", "DROPS", "SACHET", "POWDER", "LOTION", "INHALER", "SUSP", "PWD", or trailing punctuation. Move that information into the "form" field. Examples:
  • Source text "TAB SITACIP DM 10+100+500MG OD" → name: "Sitacip DM", form: "Tablet", dose: "10+100+500 mg", frequency: "OD", route: "Oral"
  • Source text "INJ. RYZODEG 8 UNIT S/C OD BEFORE BREAKFAST" → name: "Ryzodeg", form: "Injection", dose: "8 units", frequency: "OD", timing: "before breakfast", route: "SC"
  • Source text "CAP RABESEC DSR 20 MG OD" → name: "Rabesec DSR", form: "Capsule", dose: "20 mg", route: "Oral"
  • Source text "Ointment Candid B for local application" → name: "Candid B", form: "Ointment", route: "Topical"
  • Source text "DROPS MOISOL AS NEEDED" → name: "Moisol", form: "Drops", route: "Topical"
  This rule is ABSOLUTE — the "name" field must never start with TAB/INJ/CAP/SYP/OINT/etc. If you cannot identify the dosage form, set form: null, but still do NOT put the abbreviation inside name.
- MEDICATION ROUTE RULES — derive route from form when not explicit: Tablet/Capsule/Syrup/Suspension/Sachet/Powder → "Oral"; Injection → "SC" unless text says IM/IV; Ointment/Cream/Gel/Lotion/Spray/Drops/Patch → "Topical"; Inhaler/Nebulizer → "Inhaled"; Suppository → "Rectal"; Pessary → "Vaginal". For injections explicitly marked "S/C" or "SC" → "SC"; "I/M" or "IM" → "IM"; "I/V" or "IV" → "IV".
- WEEKLY / FORTNIGHTLY DAY EXTRACTION — When a medication frequency is "Once weekly", "weekly", "once in 14 days", "fortnightly", or similar, look for a weekday mention in the surrounding text ("on Sunday", "every Monday", "Tues & Thurs", "ON MON", etc.) and emit "days_of_week" as an integer array using 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat. Examples: "INJ WEGOVY 0.25MG SC ONCE WEEKLY ON SUNDAY" → days_of_week: [0]; "TAB METHOTREXATE 10MG ONCE WEEKLY EVERY MON" → days_of_week: [1]. For non-weekly meds (OD, BD, TDS, SOS, alternate day etc.) leave days_of_week null. If the source is weekly but names no specific day, also leave it null — the downstream pipeline will default it to the prescription's weekday.
- SUPPORT / CONDITIONAL MEDICATIONS — A drug listed as a remedy for the side-effects of another drug, or as a conditional/PRN cover for that drug, is a SUPPORT MEDICATION for the parent drug named immediately above it in the same TREATMENT block. Detect support meds by surrounding cues such as: "ADVERSE EFFECTS — …", "ADVISED TO TAKE … ON DAY 1 AND 2 OF INJECTION", "ON DAY 1/2 OF …", "SOS IN CASE OF …", "SOS FOR …", "IF NAUSEA/VOMITING/DIARRHOEA/ACIDITY", "PRN FOR …", "TO COVER …", "PROPHYLAXIS FOR …", "TO PREVENT …". For each such support drug:
  • Still extract it as a normal entry in the "medications" array with its own name/form/dose/frequency/route.
  • Set "support_for" to the parent drug's brand name — must match the "name" field of the parent entry in this same medications array character-for-character (so the post-processor can link them).
  • Set "support_condition" to a short phrase summarising the trigger ("for nausea/vomiting", "SOS for diarrhoea", "Day 1-2 prophylaxis").
  • For non-support medications (the parents themselves and standalone drugs), set both "support_for" and "support_condition" to null.
  EXAMPLE — input block:
    "INJ WEGOVY 0.125 MG S/C ONCE WEEKLY AT 9PM WITHHOLD
     ADVERSE EFFECTS – NAUSEA/VOMITING/DIARRHEA/ACIDITY
     ADVISED TO TAKE AMLA CANDY/TAB EMSET 8MG/TAB RANTAC ON DAY 1 AND 2 OF INJECTION
     CAP ROKO SOS IN CASE OF DIARRHEA"
  → five medications: Wegovy (support_for: null, support_condition: null) is the parent;
    Amla Candy, Emset, Rantac each carry support_for: "Wegovy", support_condition: "for nausea/vomiting/acidity on Day 1-2 of injection";
    Roko carries support_for: "Wegovy", support_condition: "SOS for diarrhoea".
  When the trigger text references multiple parent drugs, attach to the most recently listed parent above the trigger line. When unclear, set support_for to null and keep the entry as a top-level medication.
- For medications: parse CURRENT/TREATMENT medications with name, dose, frequency (OD/BD/TDS/SOS/alternate day etc). "PLAN FOR [drug]" or "PLANNED [drug]" in the ADVICE section = future treatment plan — do NOT extract as a current medication. For twice-daily insulin with different morning and evening doses (e.g. "12 units before breakfast / 8 units before dinner"), extract as ONE medication with dose "12 units (morning) + 8 units (evening)", frequency "BD", route "SC"., timing (before/after food etc), route (Oral/SC/IV/IM etc). Set is_new=true if it's a new addition. Also look for medications where dose has CHANGED (e.g. "NMZ 10 to NMZ 20") — the OLD dose should be in previous_medications. Also capture if note says "DOSE WAS REDUCED/INCREASED" for a medication — record it in previous_medications with reason "dose changed". For sliding scale insulin (different doses per meal), extract as ONE entry with dose as the range (e.g. "5-9 units") and frequency as "Thrice daily". Do NOT create separate entries per meal. Do NOT extract diagnoses, lab findings, clinical events (GMI, hypoglycemia, SGLT2 inhibitor-related events) or monitoring instructions as medications — only actual drugs/injections/ointments/supplements. IMPORTANT: A "-" or "–" at the START of a line in a medication list is a BULLET POINT, not an absent marker — extract it as a medication (e.g. "-PET SAFFA POWDER 1/2 TSP DAILY" → medication: "Pet Saffa Powder", dose: "1/2 tsp", frequency: "OD"). For injections: use route "SC" for subcutaneous (S/C), "IM" for intramuscular, "IV" for intravenous. Nutritional supplements (whey protein, protein powder, meal replacement) — extract as medications with route "Oral" and category implied by name. Powders like "Pet Saffa Powder" are laxative supplements — include as medications.
- WHEN_TO_TAKE — for EVERY entry in "medications", ALWAYS populate "when_to_take" as a JSON ARRAY (never a string, never null, never an empty array) using ONLY values from this exact vocabulary: ["Fasting", "Before breakfast", "After breakfast", "Before lunch", "After lunch", "Before dinner", "After dinner", "At bedtime", "SOS only", "Any time"]. Do not invent or paraphrase values. Map from the timing / frequency text:
  • "Empty stomach" / "30 min before food/breakfast" / "fasting" → ["Fasting"]
  • "Before breakfast" / "morning before food" → ["Before breakfast"]
  • "After breakfast" / "morning after food" → ["After breakfast"]
  • "Before lunch" → ["Before lunch"]; "After lunch" → ["After lunch"]
  • "Before dinner" / "night before food" → ["Before dinner"]; "After dinner" / "night after food" → ["After dinner"]
  • "Bedtime" / "HS" / "at night before sleep" → ["At bedtime"]
  • "SOS" / "PRN" / "as needed" → ["SOS only"]
  • Generic "After meals" / "After food" without a specific meal → expand by frequency: OD → ["After breakfast"], BD → ["After breakfast","After dinner"], TDS → ["After breakfast","After lunch","After dinner"], QID → ["After breakfast","After lunch","After dinner","At bedtime"]
  • Generic "Before meals" / "Before food" without a specific meal → same expansion with "Before …" variants
  • If no timing text at all, INFER from drug class: Metformin → ["After breakfast"] (OD) or ["After breakfast","After dinner"] (BD); SGLT2i/DPP4i/Sulfonylureas → ["Before breakfast"]; Statins → ["At bedtime"]; Levothyroxine → ["Fasting"]; Aspirin → ["After lunch"]; PPIs (pantoprazole/omeprazole/rabeprazole) → ["Before breakfast"]; Antihypertensives (telmisartan/amlodipine/losartan) → ["After breakfast"]; Insulin basal → ["At bedtime"]; Insulin bolus/prandial → ["Before breakfast","Before lunch","Before dinner"] (match frequency); B12 / multivitamin / generic supplement → ["After breakfast"]
  • Last-resort fallback when nothing can be inferred: ["Any time"]. NEVER leave when_to_take empty or null.
- COMMON SIDE EFFECTS — for EVERY entry in "medications", populate the "common_side_effects" array with at MOST 3 entries describing the most clinically relevant common side effects of that drug (use general medical knowledge of the drug — these are NOT extracted from the note text, they are the well-known common side effects the patient should be aware of). Each entry has: name (short label, e.g. "Stomach upset / loose stools"), desc (one short patient-friendly line, e.g. "Take with food. Extended-release form helps."), severity ("common" for the typical mild ones, "uncommon" for less frequent, "warn" for rare-but-serious things the patient should seek help for — at most one "warn" entry). Order by importance: most common first. If the drug is a generic supplement / multivitamin / non-pharmacological item with no notable side effects, return []. Do NOT exceed 3 entries. Keep desc under 90 characters.
- For previous_medications: extract from "PREVIOUS MEDICATION" section + ANY medicines with dose/frequency changes. Capture: old/previous dose, medication name, status ("stopped" or "changed"), and reason (e.g. "side effect", "dose increased from 10mg to 20mg", "replaced by", "discontinued"). If dose changed (e.g. NMZ 10 became NMZ 20), extract NMZ 10 as previous_medication with reason "dose changed". IMPORTANT: Medications mentioned ONLY inside a historical "FOLLOW UP ON <past date>" section as one-off/acute treatments (e.g. "C/O FEVER, SO ON CIPLOX" in July 2024 section) are OLD historical prescriptions — do NOT add them to the current medications list.
- For symptoms: extract ALL chief complaints, presenting complaints, and reported symptoms from "C/O", "COMPLAINTS", "PRESENTING COMPLAINTS" sections (e.g. fatigue, weight gain, tremor, palpitations, pain). Each should have:
  • name: symptom label
  • duration: raw text duration (e.g. "3-4 months", "since last visit")
  • since_date: approximate YYYY-MM-DD date based on duration + context date (e.g. "since 3-4 months" from a Mar 2026 note → "2025-12-01"). Use null if no duration mentioned.
  • severity: "mild/moderate/severe" if explicitly mentioned, otherwise null
  • related_to: the diagnosis or condition this symptom is associated with if inferable (e.g. breathlessness + OSAS in same note → "OSAS"; pedal edema + heart failure → "Heart Failure"). Use null if not clear.
  Do NOT extract diagnoses as symptoms. [] if none found.
- For diagnoses: extract ALL conditions from the DIAGNOSIS section, both present and absent. Rules:
  • A "+" suffix or "+" marker means PRESENT → status: "Present", strip "+" from name (e.g. "NEUROPATHY+" → name: "NEUROPATHY", status: "Present").
  • A "-" suffix directly after the name (before any space or parenthesis) means ABSENT → status: "Absent", strip "-" from name (e.g. "CAD-" → name: "CAD", status: "Absent"; "NEPHROPATHY-(G1A1)" → name: "NEPHROPATHY", details: "G1A1", status: "Absent"; "NEPHROPATHY-(G2 A1)" → name: "NEPHROPATHY", details: "G2 A1", status: "Absent"; "NEUROPATHY-(G2 A2)" → name: "NEUROPATHY", details: "G2 A2", status: "Absent"). The "-" before "(" ALWAYS means Absent regardless of what is inside the parentheses. Also mark Absent if details say "absent", "negative", "no history of", "ruled out", "(-)", "not present".
  • Conditions with NO sign on their OWN LINE in a dedicated DIAGNOSIS/IMPRESSION section → status: "Present" (e.g. "HYPERTENSION", "BPH", "CENTRAL ADIPOSITY" each on their own line).
  • Conditions with NO sign listed INLINE on the SAME COMMA-SEPARATED LINE as absent "-" conditions (e.g. "CAD-, CVA-, PVD" — PVD has no sign but shares the absent line) → status: "Absent". This applies to ALL conditions including diabetic complications. Example: "NEUROPATHY-,NEPHROPATHY-(G2 A1),RETINOPATHY" → RETINOPATHY has no sign but is on the same comma-separated line as two "-" conditions → status: "Absent". Example: "CAD-, CVA-, PVD" → all three are Absent (PVD has no sign but shares the absent line).
  • "AOO-" or "AOO" means "Age of Onset" — it is NOT an absent marker. Do NOT change the status of the diagnosis it belongs to.
  • For conditions with parenthetical details like "NEPHROPATHY-(G1A1)" or "NEPHROPATHY(G1A?)" or "TYPE 2 DM (2025)", extract: name without parentheses and without the +/- sign (e.g. "NEPHROPATHY"), details = the parenthetical content (e.g. "G1A1"), status from the sign before the parenthesis.
  • Extract ALL diagnoses from the DIAGNOSIS section including: Type 2 DM, MASLD, DUAL ADIPOSITY, NEUROPATHY, NEPHROPATHY, RETINOPATHY, HYPERTENSION, PCOS, and any other conditions listed.
  • If the DIAGNOSIS section header is followed by an unclosed parenthesis like "DIAGNOSIS (\nCONDITION A\nCONDITION B" or "○ DIAGNOSIS ( DIAGNOSIS:" — treat each subsequent line as a separate Present diagnosis, do NOT treat the opening "(" or "○" as part of a diagnosis name.
  • Program/category labels in the DIAGNOSIS section (e.g. "INTENSIVE DIABETES MANAGEMENT PROGRAM", "COMPREHENSIVE CARE PROGRAM") are administrative headings — do NOT extract as diagnoses.
  • Clinical descriptors in the DIAGNOSIS section that are weight/lifestyle status (e.g. "NON OBESE", "OBESE", "OVERWEIGHT" if used as a descriptor not a standalone diagnosis, "NON SMOKER", "NON ALCOHOLIC") — extract only if they appear as standalone diagnoses on their own line without context. "NON OBESE" alone is a descriptor, not a diagnosable condition — do NOT extract it as a diagnosis.
  • "PAST MEDICAL/SURGICAL HISTORY" / "F/H/O" / "OBS HISTORY" / "MENSTRUAL HISTORY" / "OBSERVATION" sections contain background context — do NOT extract entries from these sections as active diagnoses. E.g. "B/L TKR", "RECURRENT HEMATOMA 2004", "BICORONAL APPROACH 2004", "BIOPSY - HEMARTOMA" are surgical/past history, not current diagnoses.
  • Lines starting with "H/O" (History Of) are past medical history — do NOT extract as diagnoses. E.g. "H/O COVID: +", "H/O AKI REQUIRING DIALYSIS 2022", "H/O OPIOID ADDICTION" should be ignored for diagnosis extraction.
  • "S/P" or "S/P POST OP" in a diagnosis name means "Status Post" (post-operative) — it is NOT an absent marker. E.g. "LEFT ORBIT HEMARTOMA- S/P POST OP -2004" → name: "LEFT ORBIT HEMARTOMA", details: "S/P Post Op 2004", status: "Present". The "-" before "S/P" is a dash separator, not an absent sign.
  • "CONDITION- POST [TREATMENT] (YEAR)" — a "-" followed by "POST" means the condition was historically present and treated. E.g. "AIDP- POST IVIG TRANSFUSION (2013)" → name: "AIDP", details: "Post IVIG Transfusion 2013", status: "Present" (historical/resolved).
  • A "?" inside parenthetical details does NOT make the diagnosis absent. E.g. "NEPHROPATHY(G2A?)" → name: "NEPHROPATHY", details: "G2A?", status: "Present". The "?" indicates diagnostic uncertainty about the sub-classification, not absence of the condition.
  • "NEUROPATHY+(DDSMP)" → name: "NEUROPATHY", details: "DDSMP", status: "Present". "RETINOPATHY+(LASERS DONE)" → name: "RETINOPATHY", details: "Lasers Done", status: "Present".
  • Run-together diagnosis text (e.g. "RETINOPATHYCAD-" or "PVDMASLD+") must be split into separate diagnoses: "RETINOPATHY" and "CAD-"; "PVD" and "MASLD+". Apply the +/- rules to each after splitting.
  • "TYPE 2 DM (C PEPTIDE-3.83, HOMA IR-4.99) (SINCE: 2023), AOO-35YRS" → name: "TYPE 2 DM", details: "C PEPTIDE-3.83, HOMA IR-4.99, Since 2023, AOO 35 yrs", status: "Present". The numbers inside are diagnosis context values — do NOT re-extract them as current lab results (they have their own dated entry elsewhere).
  • "PANCREATIC EXOCRINE INSUFFICIENCY (FE: 44.20)" → name: "PANCREATIC EXOCRINE INSUFFICIENCY", details: "FE: 44.20", status: "Present". Also extract FE 44.20 as a lab result (test: "Fecal Elastase", value: "44.20") with date: null.
  • "PREDIABETES (GTT FBG 76.7,2HR BG 140,HBA1C:5.8%)" → name: "PREDIABETES", details: "GTT FBG 76.7,2HR BG 140,HBA1C:5.8%". Do NOT re-extract the numbers inside diagnosis parentheses as separate lab results.
  • Sub-bullets under a parent diagnosis (indented lines starting with "-" or "•") are FEATURES of that parent, not separate absent diagnoses. Example: under "PCOS:", the lines "-SECONDARY AMENORRHEA", "-FGS - 14/36, ACNE: GRADE 2", "-USG: PCOM+" are PCOS features. Extract them as Present sub-diagnoses or details — do NOT mark them Absent just because they have a leading "-".
  • "ACNE: GRADE 2" → name: "ACNE", details: "Grade 2", status: "Present". "SECONDARY AMENORRHEA" as a sub-bullet under PCOS → Present diagnosis.
  • "USG: PCOM+" or "USG: PCOM" → this is a USG finding (Polycystic Ovarian Morphology on ultrasound) that confirms PCOS — do NOT create a separate diagnosis entry for PCOM. Add it as details on the PCOS diagnosis instead.
  • "FGS - 14/36" in the DIAGNOSIS section is a Ferriman-Gallwey Score value, NOT an absent diagnosis. Extract as a lab result (test: "FGS", value: "14/36") — do NOT create a diagnosis entry for it.
- For vitals: return an ARRAY with ONE entry per DATED section that contains vital values. Each entry must carry the date of the section it came from.
  • "FOLLOW UP TODAY ON <date>" / "FOLLOW UP TODAY:<date>" / "FOLLOW UP TODAY - <date>" / "FOLLOW UP TODAY <date>" / "FOLLOW UP TODAY(<date>)" / "FU TODAY <date>" / "F/U TODAY <date>" → date = that date (NOT today's calendar date — use the literal date written after "FOLLOW UP TODAY")
  • "FOLLOW UP ON <date>" / "FOLLOW UP:<date>" / "FOLLOW UP NOTES(<date>)" / "FOLLOW UP NOTES:<date>" → date = that date
  • Any other dated section that contains vital values → date = that date
  CRITICAL — "FOLLOW UP TODAY: <date>" (and all its variants above) means "this is the log from the visit on <date>" — the word TODAY refers to that date, not the current real-world date. Any HT/WT/BMI/BP/WC/BF written underneath such a header MUST be emitted as a vitals entry whose date equals that header's date. If the note has multiple "FOLLOW UP TODAY" blocks at different dates, emit ONE vitals entry per block. Never collapse them; never assign today's calendar date.
  Dates come in DD/MM/YYYY (Indian format) — convert to YYYY-MM-DD.
  Extract HT/WT/BMI/BP(sitting)/WC(waist circumference)/BF(body fat) into the entry for that date.
  For BP: "BP SITTING: 165/97 SITTING" — the trailing word "SITTING" is a label duplication error, extract bpSys:165, bpDia:97. "BP STANDING: 152/93" is standing BP — SKIP, do not emit into vitals (we track sitting BP only).
  For undated "OBSERVATIONS" / "OBSERVATION-:" / "VITAL SIGNS" / "TODAY" / "PATIENT VISITED TODAY" blocks (no explicit date in or above the header), apply the same carried-forward judgment used for labs above:
    • If the OBSERVATIONS block is the FIRST or PRIMARY block in the note, there is NO older dated header above it, AND there is NO dated follow-up block below it, treat it as the CURRENT visit → emit a vitals entry with date: "today". The downstream pipeline anchors "today" to the prescription's own visit date, so HT/WT/BMI/BP etc. recorded under an undated current-visit OBSERVATIONS block are kept and dated to the prescription date.
    • CUMULATIVE NOTE (same structural rule as labs): if one or more dated follow-up blocks appear BELOW the undated OBSERVATIONS block, that block is the enrollment baseline — do NOT emit it with date "today". Emit the vitals entry for each dated follow-up block under that block's own date instead. Marking the baseline as "today" would make the patient's enrollment weight and BP overwrite the current visit's readings.
    • If the OBSERVATIONS block is NESTED INSIDE an older dated header (e.g. "FOLLOW UP NOTES(20-03-24): … OBSERVATIONS: BP-140/90"), it is HISTORICAL — emit the vitals entry with the outer header's date (YYYY-MM-DD).
    • Only DROP the block (emit nothing) when there is no judgment available, no outer dated header, AND no signal that this is the current visit — in that rare case the date is genuinely unknown.
  DO NOT emit entries from:
    • "TARGET" / "GOAL" / "YOUR NEXT FOLLOW UP IS SCHEDULED ON <date>" sections (these are future targets, not measurements)
    • Numbers inside a diagnosis parenthetical (e.g. "TYPE 2 DM (HBA1C:7)") — those are diagnosis context, not a measurement event
  DATE-CERTAINTY GATE FOR VITALS — same principle as labs: only emit a vital when the date is 100% certain. SKIP the entry (do NOT emit at all) when the value or its date is hedged. Triggers include:
    • Hedged value: "MAY BE BP 130/80", "WT AROUND 80", "APPROX 82", "~80", "?80", "PROBABLY", "POSSIBLY", "NOT SURE", "PATIENT SAYS MAYBE".
    • Hedged date: "MAY BE LAST MONTH", "APPROX 6 MONTHS BACK", "AROUND SEPT", "NOT SURE WHEN", "?DATE", "SOMETIME IN <month>", "POSSIBLY IN <month/year>".
    • Observation/aside in another section that records a vital with a hedge (e.g. "OBSERVATION: PATIENT MENTIONS WT MAY BE 85 LAST YEAR") — skip.
  A vitals entry passes the gate ONLY when every numeric field in it has a definite value AND the entry's date is either an explicit calendar date from a recognised header, or the current-visit "today" anchor. If either side is hedged, drop the entry. We want only vitals we are 100% sure about.
  If no section contains vitals that pass the gate, return [] (empty array).
- For lifestyle: SPLIT into separate fields. Set to null if not found — do NOT put medication instructions, monitoring instructions, or follow-up advice here:
  - diet: ONLY calorie/protein/food plan (e.g. "1400 kcal with 60g protein"). Must mention kcal/calories/protein/food. Null if not found
  - exercise: ONLY physical activity like steps, walking, gym (e.g. "10,000 steps daily"). Must mention steps/walk/exercise. Null if not found
  - smoking: ONLY if explicitly mentioned. Null if not found
  - alcohol: ONLY if explicitly mentioned. Null if not found
  - stress: ONLY if explicitly mentioned. Null if not found
- For advice: glucose monitoring instructions (e.g. "D1-FASTING AND 2HR POST BREAKFAST, D3-..., D5-..."), insulin titration rules (e.g. "increase evening dose by 1 unit per day till post dinner 150 and fasting 100"), TSH targets, medication holds, other clinical instructions. Null if not found. Do NOT put glucose monitoring schedules into medications.
- For investigations_to_order: extract ALL tests/investigations ordered or recommended. Set urgency to "urgent" if marked urgent, "next_visit" if scheduled for next visit, "routine" otherwise. [] if none found
- For follow_up: extract the NEXT scheduled follow-up (the appointment the doctor is booking AT THE END OF this visit, for a future date). Fields: date (YYYY-MM-DD if exact date given), timing (e.g. "1 month", "3 months"), notes. Null fields if not found.
  • The NEXT follow-up is signalled by phrases like "NEXT FOLLOW UP", "NEXT FOLLOW UP ON", "YOUR NEXT FOLLOW UP IS SCHEDULED ON", "REVIEW ON", "REVISIT ON", "F/U ON", "RTC ON", "come back after X weeks/months", "FOLLOW UP AFTER X DAYS/WEEKS/MONTHS", "FOLLOW UP AFTER X MONTHS WITH <tests>", "FOLLOW UP IN X WEEKS/MONTHS", "FOLLOW UP WITH IN X MONTHS", "FOLLOW UP WITHIN X MONTHS", "REVIEW AFTER X WEEKS/MONTHS", "F/U AFTER X MONTHS", "RTC AFTER X MONTHS", or a plain future date under a "NEXT FOLLOW UP" / "PLAN" header.
  • CRITICAL — a header like "FOLLOW UP TODAY ON <date>" / "FOLLOW UP ON <past date>:" / "FOLLOW UP NOTES(<past date>)" that is followed by lab values, vitals, or C/O complaints is a PAST visit log entry (the doctor is recording what happened previously). Those are NOT the next follow-up and must be IGNORED when choosing follow_up.
  • A relative phrase IMMEDIATELY FOLLOWED BY A DATE is also a past log header, not a booking — e.g. "FOLLOW UP AFTER 3 MONTHS 24/4/23:\nFBG: 120" means "the follow-up that was due after 3 months happened on 24/4/23". Ignore it and keep looking for an undated relative phrase later in the note.
  • If multiple "FOLLOW UP" sections appear, pick the one whose date is chronologically LATEST AND is strictly in the future relative to the note's own visit date. If every dated "FOLLOW UP" section is a past log entry, then follow_up.date = null (use timing/notes only if the note also says something like "come back after 1 month").
  • If only a relative phrase is given (e.g. "review in 2 weeks"), put that in timing and leave date null — do NOT compute the date.
  • UNDATED "FOLLOW UP" LINE = THE NEXT FOLLOW-UP. The past-log rule above applies ONLY to headers that name a date. A "FOLLOW UP …" line carrying NO date, and not followed by lab values / vitals / C/O complaints, is the next follow-up — never a past log. This is the single most commonly missed case: notes that END with "FOLLOW UP AFTER 3 MONTH" or "FOLLOW UP AFTER 3 MONTHS WITH FPG, PPBG CHARTING, HBA1C, LIPIDS, CREATININE, UACR", usually the last line after the TREATMENT block. Returning follow_up: null for such a note is WRONG.
    EXAMPLE: note tail "…INJ NEUROBION FORTE 500 MCG I/M WEEKLY FOR 5 WEEKS\n\nFOLLOW UP AFTER 3 MONTH\nFOLLOW UP AFTER 3 MONTHS WITH FPG, PPBG CHARTING, HBA1C, LIPIDS, CREATININE, UACR"
    → follow_up: {"date": null, "timing": "3 months", "notes": "With FPG, PPBG charting, HbA1c, Lipids, Creatinine, UACR"} and follow_up_with: "FPG, PPBG CHARTING, HBA1C, LIPIDS, CREATININE, UACR"
  • TIMING FORMAT — always write timing as a plain digit + unit, lower case, pluralised: "3 months", "6 weeks", "10 days", "1 year". Downstream code counts that interval from the visit date, so "3 MONTH", "three months", "3/12" or "quarterly" are NOT acceptable — normalise them to "3 months".
- For follow_up_with: capture the ENTIRE free-text block that follows the heading "FOLLOW UP WITH" (or "Follow up with", "FOLLOWUP WITH", "Next visit instructions") — including the prep instructions AND the trailing list of tests/labs the patient must bring. This is ONE field, not split. Read until you hit a hard section break: a new heading, a blank line followed by a non-prep heading, a closing parenthesis ")" that closes the surrounding block, or end of note. Do NOT stop early at the first period / "HRS" / "AM" — the trailing list of tests after those words is part of the same instruction and MUST be preserved.
  EXAMPLE (the entire run-on string is one value, tests included):
    Input: "FOLLOW UP WITH FASTING SAMPLE AT GINI HEALTH 8:30AM AFTER OMISSION OF ANTIDIABETIC MEDICATION FOR 24 HRS FBG ,FPI,C-PEPTIDE ,HBA1C ,CREATININE ,URINE ACR ,LIPIDS . )"
    → follow_up_with: "FASTING SAMPLE AT GINI HEALTH 8:30AM AFTER OMISSION OF ANTIDIABETIC MEDICATION FOR 24 HRS — FBG, FPI, C-PEPTIDE, HBA1C, CREATININE, URINE ACR, LIPIDS"
  Normalisation rules INSIDE the captured string: collapse runs of whitespace; tidy " ,X" → ", X"; preserve original line breaks as \\n; drop the trailing closing-paren / lone period; strip the literal heading words "FOLLOW UP WITH" themselves. Do NOT include the next-visit date (that maps to follow_up). Set to null only when no such block exists.
- IMPORTANT — do NOT extract glucose or lab values mentioned inline in C/O (complaints) or symptom context as standalone lab results. A value like "RBG-60" or "FBS-80" written immediately after a complaint line (e.g. "C/O SYMPTOMATIC HYPOGLYCEMIA SINCE OCT,24\nRBG-60") is a symptom-context reading cited to support the complaint — NOT a current visit lab. Skip it entirely. Only extract lab values that appear under a dedicated OBSERVATIONS / FOLLOW UP / LABS section header.
  This applies equally to NARRATIVE HISTORY values in the free-text intake paragraph — e.g. "48 YR FEMALE CAME AT GINI HEALTH WITH C/O POLYURIA\nDONE WITH ROUTINE INVESTIGATIONS\nHBA1C 8.5\nNOT STARTED ORALLY". That 8.5 is the patient recounting an OUTSIDE lab done before enrolment; it is NOT the clinic's measurement. Skip it. When the same test also appears under the OBSERVATION / FOLLOW UP block with a different value (HBA1C 8.8 there), the SECTION-HEADER value is the measurement and the narrative value must never replace or compete with it.
- OBSERVATIONS BLOCK vs SAME-DATE FOLLOW UP — VISIT DATE ANCHOR: The user message may begin with a line "Visit date: YYYY-MM-DD". When present, use it to resolve whether an undated OBSERVATIONS block belongs to the current visit or is a historical baseline:
  • The trigger is a DATED FOLLOW-UP BLOCK in ANY of the spellings defined above ("FOLLOW UP ON <date>", "FOLLOW UP TODAY:<date>", "FOLLOW UP NOTES(<date>)", "VISIT ON <date>", "LABS (<date>)", …) — NOT only the literal words "FOLLOW UP ON". Matching on the literal phrase alone is a bug: "FOLLOW UP TODAY:29/7/26" is a dated follow-up block and MUST trigger these rules.
  • ABSOLUTE RULE — If a dated follow-up block exists whose date equals the visit date: use ONLY the data (labs, vitals, medications) present in that block. The OBSERVATIONS block is the enrollment-time baseline and MUST BE COMPLETELY IGNORED. Do NOT extract any field from OBSERVATIONS — not UACR, not Creatinine, not HbA1c, not any test — even if that test is absent from the follow-up block. A test missing from the follow-up block means it was NOT measured on this visit. Do NOT backfill from OBSERVATIONS. Do NOT attribute OBSERVATIONS data to "today". The OBSERVATIONS block does not exist for the purpose of this extraction.
  • If the note contains NO dated follow-up blocks at all (first/fresh visit with no prior visit history in this note), treat the undated OBSERVATIONS block as the current visit prescription source — extract labs, vitals, and medications from it with date: "today".
  • If the note DOES contain dated follow-up blocks but NONE of them match the visit date, do NOT use OBSERVATIONS data — skip it entirely and leave those fields empty. The patient likely did not visit on this appointment date.
  • Apply this rule ONLY when the user message starts with "Visit date:". Without it, fall back to the existing date-attribution rules — including the CUMULATIVE NOTE structural rule, which alone is enough to reject an OBSERVATIONS block that has dated follow-up blocks below it.
  EXAMPLE (match — strict): Visit date: 2026-05-18. Note has undated OBSERVATIONS (FBG-131, HBA1C-7.2, TG-211, UACR-45) and "FOLLOW UP ON 18/5/26" (HBA1C-7, FBG-103, TG-73). Since 18/5/26 == 2026-05-18: OBSERVATIONS is IGNORED ENTIRELY. Only FOLLOW UP ON 18/5/26 labs are emitted — UACR is NOT emitted even though it appears in OBSERVATIONS and is absent from the FOLLOW UP section.
  • COUNT IS IRRELEVANT — ONE dated follow-up block is enough to trigger the ABSOLUTE RULE. A note with a single appended block still means the OBSERVATION above it is the enrollment baseline. Do NOT reason "there is only one follow-up, so OBSERVATION must be this visit". Do NOT backfill the tests that OBSERVATION has and the follow-up block lacks — a test absent from the follow-up block was NOT measured on this visit, and emitting the baseline value for it fabricates a measurement that never happened.
  EXAMPLE (match — only ONE follow-up block, still ignore OBSERVATION): Visit date: 2026-06-18. Note: "…PREVIOUS MEDICATION NIL\nOBSERVATION\nHT 152.5\nBP 148/95\nFBG 171.4\nFPI 7.9\nC-PEPTIDE 3.01\nHBA1C 8.8\nCREATININE 0.56\neGFR 112\nURINE ACR 62.4\nTG 305\nLDL 167.6\nNON HDL 228\nHB 12.4\nFERITIN 62.2\nTSH 3.3\nT4 5.2\nT3 0.81\n\nFOLLOW UP TODAY:18/6/26\nBP 122/79\nFBG 150\nPP 195". Correct output: EXACTLY TWO labs — FBS 150 and PPBS 195, both dated 2026-06-18. NOT sixteen. HBA1C 8.8, C-PEPTIDE 3.01, TSH 3.3, FPI 7.9, TG 305, LDL 167.6, CREATININE 0.56, eGFR 112, URINE ACR 62.4, HB 12.4, FERITIN 62.2, T3, T4 and NON HDL are ALL baseline-only — none of them were measured on 18/6/26, so NONE of them may be emitted with that date.
  EXAMPLE (match — "FOLLOW UP TODAY" spelling): Visit date: 2026-07-29. Note has undated OBSERVATION (FBG 171.4, HBA1C 8.8, LDL 167.6, TG 305, UACR 62.4, CREATININE 0.56), then "FOLLOW UP TODAY:18/6/26" (FBG 150, PP 195), then "FOLLOW UP TODAY:29/7/26" (FBG 82.3, HBA1C 6.4, LDL 50.6, TG 214.3, UACR 39.05, CREATININE 0.78). Since 29/7/26 == 2026-07-29: OBSERVATION is IGNORED ENTIRELY — FBG 171.4 and HBA1C 8.8 are NOT emitted at all. Emit only FBG 150 / PP 195 dated 2026-06-18 and the six 29/7 values dated 2026-07-29.
  EXAMPLE (no match — skip): Visit date: 2026-05-18. Note has "FOLLOW UP ON 20/3/26" and "FOLLOW UP ON 15/4/26" but NO block for 18/5/26. OBSERVATIONS block has FBG-131, HBA1C-7.2, TREATMENT: TAB MED 500MG OD. Since the note has follow-up history but none matches 2026-05-18: OMIT OBSERVATIONS entirely — return empty arrays for labs, medications, vitals.
  EXAMPLE (first visit — use OBSERVATIONS): Visit date: 2026-05-18. Note has NO dated follow-up blocks at all — only an OBSERVATIONS block (FBG-200, HBA1C-9, TREATMENT: TAB METFORMIN 500MG OD). Since there are no follow-up sections: OBSERVATIONS IS the current visit — extract FBG-200 and HBA1C-9 as labs with date "today", and TAB METFORMIN as a current medication.
- CRITICAL — all dates in these notes are in DD/MM/YYYY format (Indian standard). "06/04/2026" means April 6 2026 → output as 2026-04-06. NEVER interpret as MM/DD/YYYY.`;

export const PrescriptionSchema = z.object({
  symptoms: z.array(
    z.object({
      name: z.string(),
      duration: z.string(),
      since_date: z.string().describe("YYYY-MM-DD"),
      severity: z.string(),
      related_to: z.string(),
    }),
  ),
  diagnoses: z.array(
    z.object({
      name: z.string(),
      details: z.string(),
      since: z.string(),
      // .catch() so a rare off-enum value from the model defaults to "Present"
      // instead of throwing and discarding the ENTIRE parsed note (all
      // diagnoses + meds). A single mislabelled status beats losing everything.
      status: z.enum(["Present", "Absent"]).catch("Present"),
    }),
  ),
  labs: z.array(
    z.object({
      test: z.string(),
      value: z.string(),
      unit: z.string(),
      date: z.string().describe("YYYY-MM-DD"),
    }),
  ),
  medications: z.array(
    z.object({
      name: z.string(),
      form: z.string(),
      dose: z.string(),
      frequency: z.string(),
      timing: z.string(),
      when_to_take: z.array(
        z.enum([
          "Fasting",
          "Before breakfast",
          "After breakfast",
          "Before lunch",
          "After lunch",
          "Before dinner",
          "After dinner",
          "At bedtime",
          "SOS only",
          "Any time",
        ]),
      ),
      route: z.enum([
        "Oral",
        "SC",
        "IM",
        "IV",
        "Topical",
        "Inhaled",
        "Sublingual",
        "Nasal",
        "Rectal",
        "Vaginal",
      ]),
      days_of_week: z.array(z.number().int()),
      is_new: z.boolean(),
      support_for: z.string(),
      support_condition: z.string(),
      instructions: z.string(),
    }),
  ),
  previous_medications: z.array(
    z.object({
      name: z.string(),
      form: z.string(),
      dose: z.string(),
      frequency: z.string(),
      // .catch() — same rationale as diagnoses.status: never let one bad enum
      // value discard the whole parsed note.
      status: z.enum(["stopped", "changed"]).catch("stopped"),
      reason: z.string(),
    }),
  ),
  vitals: z.array(
    z.object({
      date: z.string().describe("YYYY-MM-DD"),
      height: z.number(),
      weight: z.number(),
      bmi: z.number(),
      bpSys: z.number(),
      bpDia: z.number(),
      waist: z.number(),
      bodyFat: z.number(),
    }),
  ),
  investigations_to_order: z.array(
    z.object({
      name: z.string(),
      urgency: z.enum(["urgent", "routine", "next_visit"]),
    }),
  ),
  follow_up: z.object({
    date: z.string().describe("YYYY-MM-DD"),
    timing: z.string(),
    notes: z.string(),
  }),
  follow_up_with: z.string(),
  advice: z.string(),
});

export async function parsePrescriptionWithAi(rawText, visitDate = null) {
  if (!anthropic) return null;
  if (!rawText || rawText.trim().length < 10) return null;

  const clean = stripPageFurniture(rawText);
  const userContent = visitDate ? `Visit date: ${visitDate}\n\n${clean}` : clean;

  try {
    const response = await anthropic.messages.parse({
      model: "claude-haiku-4-5",
      max_tokens: 12000,
      temperature: 0,
      // Cache the static extraction prompt. This parser runs once per appointment
      // during the HealthRay sync loop, so the identical prefix is re-read at
      // ~0.1x cost across the burst of appointments within the 5-minute window.
      system: [
        {
          type: "text",
          text: PRESCRIPTION_EXTRACTION_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
      output_config: { format: zodOutputFormat(PrescriptionSchema) },
    });

    if (response?.usage) {
      const u = response.usage;
      console.log(
        `[healthray-parse usage] in=${u.input_tokens} out=${u.output_tokens} ` +
          `cache_write=${u.cache_creation_input_tokens || 0} cache_read=${u.cache_read_input_tokens || 0}`,
      );
    }

    return response.parsed_output ?? null;
  } catch (e) {
    error("Parser", "messages.parse failed:", e?.message || e);
    return null;
  }
}

// ── Batch path helpers ──────────────────────────────────────────────────────
// Build the raw Messages API request for the batch queue. Mirrors
// parsePrescriptionWithAi exactly (same model, prompt, schema) so a batched
// parse is identical to the inline one — only the transport differs.
export function buildHealthrayParseRequest(rawText, visitDate = null) {
  const clean = stripPageFurniture(rawText);
  const userContent = visitDate ? `Visit date: ${visitDate}\n\n${clean}` : clean;
  return {
    model: "claude-haiku-4-5",
    max_tokens: 12000,
    temperature: 0,
    system: [
      { type: "text", text: PRESCRIPTION_EXTRACTION_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(PrescriptionSchema) },
  };
}

// Extract + validate the structured prescription from a completed batch result
// message. Returns the parsed object, or null if absent/invalid (treated as a
// parse failure by the caller, same as the inline null return).
export function extractPrescriptionFromMessage(message) {
  try {
    const text = (message?.content || [])
      .map((c) => c.text || "")
      .join("")
      .trim();
    if (!text) return null;
    const validated = PrescriptionSchema.safeParse(JSON.parse(text));
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}
