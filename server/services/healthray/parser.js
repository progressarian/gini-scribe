// ── Clinical notes parsing — extract text, AI parse, JSON repair ────────────

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { createLogger } from "../logger.js";
const { error } = createLogger("HealthRay Sync");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// ── Extract all filled text from clinical notes API response ────────────────
// Handles both formats:
//   1. medical_clinical_notes: categories → topics.selected[]
//   2. get_previous_appt_data: menus[] → categories → topics[] (flat array)
// For visits with no structured prescription, the doctor often writes the
// full plan (diagnoses + TREATMENT + PREVIOUS MEDICATION + labs) as free
// text on a single topic. That text may live under dynamic_answers[].answer
// OR on sibling fields like details / description / note / value, and
// sometimes on nested diagnoses[]/items[] arrays. Capture all of them.
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

// ── Extract vitals from Healthray `answers[]` (structured vital_sign rows) ──
// The medical_clinical_notes payload carries a deterministic `answers[]` array
// with form_type:"vital_sign" entries — no AI needed. Walks arbitrarily nested
// shapes (answers at the top, inside categories, topics, or selected entries)
// and pulls every vital sign it finds. Returns null if nothing extracted.
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
    if (!a || a.form_type !== "vital_sign") return;
    const col = (a.column_name || "").toLowerCase();
    const label = (a.label || "").toLowerCase();
    const alias = (a.alias || "").toLowerCase();
    const raw = a.value;

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

// ── Shared clinical-extraction prompt ───────────────────────────────────────
// Used by BOTH the HealthRay clinical-text parser AND the OPD prescription
// image/PDF extractor so both flows produce the same unified schema.
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
  TEST-NAME NORMALISATION — doctors frequently abbreviate or mistype. Normalise these to the canonical names even when the source text uses the variant: "HOMO IR"/"HOMO-IR" → "HOMA-IR"; "HOMO BETA"/"HOMO-BETA" → "HOMA-Beta"; "C-PPETIDE"/"C PPETIDE" → "C-Peptide"; "FCP"/"C-PEPTIDE (FASTING)" → "C-Peptide"; "NHDL"/"NON HDL" → "Non-HDL"; "CRT"/"S CREAT"/"S.CREAT" → "Creatinine"; "T CHOL"/"T.CHOL" → "Total Cholesterol"; "FPG" → "FBS"; "FBG" → "FBS"; "PPG" → "PPBS"; "RBG" → "RBS"; "FPI" → "Fasting Insulin"; "TTG" → "Anti-tTG"; "OT" → "SGOT (AST)"; "PT" → "SGPT (ALT)" (unless the surrounding context clearly discusses coagulation in which case keep as "Prothrombin Time"). Output the canonical name in the test field. Do NOT preserve the raw abbreviation — downstream storage relies on the canonical form.
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
  CRITICAL — USE INTELLIGENCE TO DETECT CARRIED-FORWARD HISTORICAL TEXT. HealthRay clinical notes frequently copy prior visits' notes verbatim into a new note. The word "TODAY" inside a sub-block does NOT always mean the current visit — it can mean "today" as written when that block was originally authored. Apply this judgment:
    • If "PATIENT VISITED TODAY" / "TODAY" / "OBSERVATIONS" sits NESTED INSIDE an outer explicitly-older dated header — most often "FOLLOW UP NOTES(<old-date>):" but also "FOLLOW UP ON <old-date>:" / "VISIT ON <old-date>:" — and the note ALSO contains a separate later section that is clearly the real current visit (e.g. another "FOLLOW UP ON <recent-date>", "LABS (<recent-date>)", or fresh complaints/symptoms keyed to today), then the inner "TODAY" is HISTORICAL and refers to the OUTER header's date, NOT the current visit. Attribute those labs to the outer header's date (YYYY-MM-DD).
    • If the only dated context for a "TODAY" / "OBSERVATIONS" block is an older header AND there's no clearly-newer section, still prefer the outer header's date over today — this is likely historical context the doctor is reviewing.
    • If "TODAY" / "OBSERVATIONS" is the FIRST or PRIMARY block in the note and there is no older dated header above it, treat it as the current visit → date: "today".
  EXAMPLE (carried-forward, P_137100 pattern):
    "FOLLOW UP NOTES(20-03-24):\n…\nPATIENT VISITED TODAY\nHBA1C : 11.5\nFPG : 112\n…\nFOLLOW UP ON 4/5/26 (PROXY VISIT)\n…\nLABS (19/4/26) S CREAT-1.00 HBA1C-7.9"
    → HBA1C 11.5 and FPG 112 carry date "2024-03-20" (inherited from the outer FOLLOW UP NOTES(20-03-24) header — they were the labs from THAT old visit, copied forward).
    → S CREAT 1.00 and HBA1C 7.9 carry date "2026-04-19" (from "LABS (19/4/26)").
    → Neither set is "today" — the current visit on 2026-05-04 has no fresh lab values of its own.
  EXAMPLE (real current OBSERVATIONS, not carried forward):
    "C/O HEADACHE\nOBSERVATIONS:\nBP-130/80\nFBS-110\nDIAGNOSIS: T2DM\nTREATMENT: …"
    → BP and FBS carry date: "today" — there is no older dated header above OBSERVATIONS, so this is the current visit.
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
- WHEN_TO_TAKE — for EVERY entry in "medications", ALWAYS populate "when_to_take" as a JSON ARRAY (never a string, never null, never an empty array) using ONLY values from this exact vocabulary: ["Fasting", "Before breakfast", "After breakfast", "Before lunch", "After lunch", "Before dinner", "After dinner", "At bedtime", "With milk", "SOS only", "Any time"]. Do not invent or paraphrase values. Map from the timing / frequency text:
  • "Empty stomach" / "30 min before food/breakfast" / "fasting" → ["Fasting"]
  • "Before breakfast" / "morning before food" → ["Before breakfast"]
  • "After breakfast" / "morning after food" → ["After breakfast"]
  • "Before lunch" → ["Before lunch"]; "After lunch" → ["After lunch"]
  • "Before dinner" / "night before food" → ["Before dinner"]; "After dinner" / "night after food" → ["After dinner"]
  • "Bedtime" / "HS" / "at night before sleep" → ["At bedtime"]
  • "With milk" → ["With milk"]
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
    • If the OBSERVATIONS block is the FIRST or PRIMARY block in the note and there is NO older dated header above it, treat it as the CURRENT visit → emit a vitals entry with date: "today". The downstream pipeline anchors "today" to the prescription's own visit date, so HT/WT/BMI/BP etc. recorded under an undated current-visit OBSERVATIONS block are kept and dated to the prescription date.
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
  • The NEXT follow-up is signalled by phrases like "NEXT FOLLOW UP", "NEXT FOLLOW UP ON", "YOUR NEXT FOLLOW UP IS SCHEDULED ON", "REVIEW ON", "REVISIT ON", "F/U ON", "RTC ON", "come back after X weeks/months", or a plain future date under a "NEXT FOLLOW UP" / "PLAN" header.
  • CRITICAL — a header like "FOLLOW UP TODAY ON <date>" / "FOLLOW UP ON <past date>:" / "FOLLOW UP NOTES(<past date>)" that is followed by lab values, vitals, or C/O complaints is a PAST visit log entry (the doctor is recording what happened previously). Those are NOT the next follow-up and must be IGNORED when choosing follow_up.
  • If multiple "FOLLOW UP" sections appear, pick the one whose date is chronologically LATEST AND is strictly in the future relative to the note's own visit date. If every dated "FOLLOW UP" section is a past log entry, then follow_up.date = null (use timing/notes only if the note also says something like "come back after 1 month").
  • If only a relative phrase is given (e.g. "review in 2 weeks"), put that in timing and leave date null — do NOT compute the date.
- For follow_up_with: capture the ENTIRE free-text block that follows the heading "FOLLOW UP WITH" (or "Follow up with", "FOLLOWUP WITH", "Next visit instructions") — including the prep instructions AND the trailing list of tests/labs the patient must bring. This is ONE field, not split. Read until you hit a hard section break: a new heading, a blank line followed by a non-prep heading, a closing parenthesis ")" that closes the surrounding block, or end of note. Do NOT stop early at the first period / "HRS" / "AM" — the trailing list of tests after those words is part of the same instruction and MUST be preserved.
  EXAMPLE (the entire run-on string is one value, tests included):
    Input: "FOLLOW UP WITH FASTING SAMPLE AT GINI HEALTH 8:30AM AFTER OMISSION OF ANTIDIABETIC MEDICATION FOR 24 HRS FBG ,FPI,C-PEPTIDE ,HBA1C ,CREATININE ,URINE ACR ,LIPIDS . )"
    → follow_up_with: "FASTING SAMPLE AT GINI HEALTH 8:30AM AFTER OMISSION OF ANTIDIABETIC MEDICATION FOR 24 HRS — FBG, FPI, C-PEPTIDE, HBA1C, CREATININE, URINE ACR, LIPIDS"
  Normalisation rules INSIDE the captured string: collapse runs of whitespace; tidy " ,X" → ", X"; preserve original line breaks as \\n; drop the trailing closing-paren / lone period; strip the literal heading words "FOLLOW UP WITH" themselves. Do NOT include the next-visit date (that maps to follow_up). Set to null only when no such block exists.
- CRITICAL — all dates in these notes are in DD/MM/YYYY format (Indian standard). "06/04/2026" means April 6 2026 → output as 2026-04-06. NEVER interpret as MM/DD/YYYY.
- Return ONLY valid JSON, no markdown`;

// ── Use Claude to parse clinical text into structured data ──────────────────
// Reuses the full CLINICAL_EXTRACTION_PROMPT ruleset as the single source of
// truth, then layers on:
//   1. Strict structured-output overrides — the schema does not allow null,
//      so swap the "set to null" instructions to "" / [] / 0.
//   2. A required `conclusion` field with rules for how to write it.
export const PRESCRIPTION_EXTRACTION_PROMPT = `
STRUCTURED-OUTPUT OVERRIDES (these supersede any "set to null" instruction above — the response schema is strict and does not allow null):
STRICT Rules:
- NEVER invent or assume data. If a field is not explicitly mentioned in the text, set it to null. Do NOT fill fields with unrelated data.
- NO-PRESCRIPTION FALLBACK (treat Diagnosis summary AS the prescription): Some visits have NO separate MEDICATIONS/PRESCRIPTION section — the doctor instead wraps the entire plan as free text inside a single diagnosis parenthetical after a program label, e.g. "INTENSIVE DIABETES MANAGEMENT PROGRAM ( TYPE 2 DM (SINCE 2018) … TREATMENT: -INJ. RYZODEG 8 UNIT … -TAB SITACIP DM 10+100+500MG OD … PREVIOUS MEDICATION -TAB GLIMESTAR M2 … OBSERVATION-: -FBG-:251.7 … FOLLOW UP ON 26/6/25: … HBA1C: 7 … ADVICE: … )". When you see this pattern, treat that parenthetical AS THE PRESCRIPTION — extract medications, previous_medications, labs, vitals, follow_up, investigations_to_order, and advice from the labelled sub-blocks inside it exactly as if each sub-block had been its own top-level section of the note. Do NOT discard the parenthetical because its outer name (e.g. "INTENSIVE DIABETES MANAGEMENT PROGRAM") is a program label. The inner real diagnoses (TYPE 2 DM, NEUROPATHY, NEPHROPATHY, RETINOPATHY, HYPERTENSION, MASLD, CAD, etc.) are what get extracted as diagnoses — the program label itself is skipped.
- TREATMENT: block = CURRENT medications. Any drug listed under a "TREATMENT:" / "TREATMENT PLAN:" / "CURRENT TREATMENT:" label — whether that label sits in its own section or inside a diagnosis parenthetical — is a CURRENT medication. Put it in "medications", NOT "previous_medications". A leading "-" or "•" on each line is a bullet, not an absent marker. Example: "TREATMENT: -INJ. RYZODEG 8 UNIT ONCE DAILY 30MIN BEFORE BREAKFAST -TAB SITACIP DM 10+100+500MG ONCE DAILY 30 MINUTES BEFORE BREAKFAST -TAB GLIZID M XR 60+500MG ONCE DAILY 30 MINUTES BEFORE DINNER" → three current medications (Ryzodeg 8U SC OD before breakfast, Sitacip DM 10+100+500mg Oral OD before breakfast, Glizid M XR 60+500mg Oral OD before dinner). "REST CONTINUE AS ADVISED BY CARDIOLOGIST" is an instruction — do NOT extract as a medication.
- PREVIOUS MEDICATION block inside a diagnosis parenthetical = previous_medications with status "stopped" (unless the text explicitly says the dose was changed, in which case status "changed"). Reason is "replaced" / "discontinued" / "dose changed" based on context; use "replaced" as the default when the TREATMENT block contains a different regimen.
- For labs: extract ALL lab values with test name, numeric value, unit. Include HbA1c, FBG, PPBG, LDL, TG, HDL, Non-HDL, Cholesterol (Total), TSH, T3, T4, Creatinine, eGFR, UACR, Hb, Iron, Ferritin, OT/SGOT, PT/SGPT, ALP, Calcium, Albumin, GTT, Insulin, C-Peptide, HOMA-IR, HOMA-Beta, Uric Acid, FIB4, Vitamin D, Vitamin B12, AMH, Testosterone, DHEAS, Prolactin, LH, FSH, Estradiol, Progesterone, FPI, Amylase, Lipase, Fecal Elastase (FE), VPT (Vibration Perception Threshold — extract R and L values separately as "VPT Right" / "VPT Left"), ABI (Ankle-Brachial Index — extract as "ABI Right" / "ABI Left"), Hirsutism Score/FGS/H.Score, Potassium, Sodium, Anti-TPO, Anti-Tg, Anti-tTG (tTG), etc.
  TEST-NAME NORMALISATION — doctors frequently abbreviate or mistype. Normalise these to the canonical names even when the source text uses the variant: "HOMO IR"/"HOMO-IR" → "HOMA-IR"; "HOMO BETA"/"HOMO-BETA" → "HOMA-Beta"; "C-PPETIDE"/"C PPETIDE" → "C-Peptide"; "FCP"/"C-PEPTIDE (FASTING)" → "C-Peptide"; "NHDL"/"NON HDL" → "Non-HDL"; "CRT"/"S CREAT"/"S.CREAT" → "Creatinine"; "T CHOL"/"T.CHOL" → "Total Cholesterol"; "FPG" → "FBS"; "FBG" → "FBS"; "PPG" → "PPBS"; "RBG" → "RBS"; "FPI" → "Fasting Insulin"; "TTG" → "Anti-tTG"; "OT" → "SGOT (AST)"; "PT" → "SGPT (ALT)" (unless the surrounding context clearly discusses coagulation in which case keep as "Prothrombin Time"). Output the canonical name in the test field. Do NOT preserve the raw abbreviation — downstream storage relies on the canonical form.
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
  CRITICAL — USE INTELLIGENCE TO DETECT CARRIED-FORWARD HISTORICAL TEXT. HealthRay clinical notes frequently copy prior visits' notes verbatim into a new note. The word "TODAY" inside a sub-block does NOT always mean the current visit — it can mean "today" as written when that block was originally authored. Apply this judgment:
    • If "PATIENT VISITED TODAY" / "TODAY" / "OBSERVATIONS" sits NESTED INSIDE an outer explicitly-older dated header — most often "FOLLOW UP NOTES(<old-date>):" but also "FOLLOW UP ON <old-date>:" / "VISIT ON <old-date>:" — and the note ALSO contains a separate later section that is clearly the real current visit (e.g. another "FOLLOW UP ON <recent-date>", "LABS (<recent-date>)", or fresh complaints/symptoms keyed to today), then the inner "TODAY" is HISTORICAL and refers to the OUTER header's date, NOT the current visit. Attribute those labs to the outer header's date (YYYY-MM-DD).
    • If the only dated context for a "TODAY" / "OBSERVATIONS" block is an older header AND there's no clearly-newer section, still prefer the outer header's date over today — this is likely historical context the doctor is reviewing.
    • If "TODAY" / "OBSERVATIONS" is the FIRST or PRIMARY block in the note and there is no older dated header above it, treat it as the current visit → date: "today".
  EXAMPLE (carried-forward, P_137100 pattern):
    "FOLLOW UP NOTES(20-03-24):\n…\nPATIENT VISITED TODAY\nHBA1C : 11.5\nFPG : 112\n…\nFOLLOW UP ON 4/5/26 (PROXY VISIT)\n…\nLABS (19/4/26) S CREAT-1.00 HBA1C-7.9"
    → HBA1C 11.5 and FPG 112 carry date "2024-03-20" (inherited from the outer FOLLOW UP NOTES(20-03-24) header — they were the labs from THAT old visit, copied forward).
    → S CREAT 1.00 and HBA1C 7.9 carry date "2026-04-19" (from "LABS (19/4/26)").
    → Neither set is "today" — the current visit on 2026-05-04 has no fresh lab values of its own.
  EXAMPLE (real current OBSERVATIONS, not carried forward):
    "C/O HEADACHE\nOBSERVATIONS:\nBP-130/80\nFBS-110\nDIAGNOSIS: T2DM\nTREATMENT: …"
    → BP and FBS carry date: "today" — there is no older dated header above OBSERVATIONS, so this is the current visit.
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
    • If the OBSERVATIONS block is the FIRST or PRIMARY block in the note and there is NO older dated header above it, treat it as the CURRENT visit → emit a vitals entry with date: "today". The downstream pipeline anchors "today" to the prescription's own visit date, so HT/WT/BMI/BP etc. recorded under an undated current-visit OBSERVATIONS block are kept and dated to the prescription date.
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
  • The NEXT follow-up is signalled by phrases like "NEXT FOLLOW UP", "NEXT FOLLOW UP ON", "YOUR NEXT FOLLOW UP IS SCHEDULED ON", "REVIEW ON", "REVISIT ON", "F/U ON", "RTC ON", "come back after X weeks/months", or a plain future date under a "NEXT FOLLOW UP" / "PLAN" header.
  • CRITICAL — a header like "FOLLOW UP TODAY ON <date>" / "FOLLOW UP ON <past date>:" / "FOLLOW UP NOTES(<past date>)" that is followed by lab values, vitals, or C/O complaints is a PAST visit log entry (the doctor is recording what happened previously). Those are NOT the next follow-up and must be IGNORED when choosing follow_up.
  • If multiple "FOLLOW UP" sections appear, pick the one whose date is chronologically LATEST AND is strictly in the future relative to the note's own visit date. If every dated "FOLLOW UP" section is a past log entry, then follow_up.date = null (use timing/notes only if the note also says something like "come back after 1 month").
  • If only a relative phrase is given (e.g. "review in 2 weeks"), put that in timing and leave date null — do NOT compute the date.
- For follow_up_with: capture the ENTIRE free-text block that follows the heading "FOLLOW UP WITH" (or "Follow up with", "FOLLOWUP WITH", "Next visit instructions") — including the prep instructions AND the trailing list of tests/labs the patient must bring. This is ONE field, not split. Read until you hit a hard section break: a new heading, a blank line followed by a non-prep heading, a closing parenthesis ")" that closes the surrounding block, or end of note. Do NOT stop early at the first period / "HRS" / "AM" — the trailing list of tests after those words is part of the same instruction and MUST be preserved.
  EXAMPLE (the entire run-on string is one value, tests included):
    Input: "FOLLOW UP WITH FASTING SAMPLE AT GINI HEALTH 8:30AM AFTER OMISSION OF ANTIDIABETIC MEDICATION FOR 24 HRS FBG ,FPI,C-PEPTIDE ,HBA1C ,CREATININE ,URINE ACR ,LIPIDS . )"
    → follow_up_with: "FASTING SAMPLE AT GINI HEALTH 8:30AM AFTER OMISSION OF ANTIDIABETIC MEDICATION FOR 24 HRS — FBG, FPI, C-PEPTIDE, HBA1C, CREATININE, URINE ACR, LIPIDS"
  Normalisation rules INSIDE the captured string: collapse runs of whitespace; tidy " ,X" → ", X"; preserve original line breaks as \\n; drop the trailing closing-paren / lone period; strip the literal heading words "FOLLOW UP WITH" themselves. Do NOT include the next-visit date (that maps to follow_up). Set to null only when no such block exists.
- CRITICAL — all dates in these notes are in DD/MM/YYYY format (Indian standard). "06/04/2026" means April 6 2026 → output as 2026-04-06. NEVER interpret as MM/DD/YYYY.`;

export const PrescriptionSchema = z.object({
  symptoms: z.array(
    z.object({
      name: z.string(),
      duration: z.string(),
      since_date: z.string().describe("YYYY-MM-DD"),
      severity: z.enum(["mild", "moderate", "severe"]),
      related_to: z.string(),
    }),
  ),
  diagnoses: z.array(
    z.object({
      name: z.string(),
      details: z.string(),
      since: z.string(),
      status: z.enum(["Present", "Absent"]),
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
      when_to_take: z.array(z.string()),
      route: z.string(),
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
      status: z.enum(["stopped", "changed"]),
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

export async function parsePrescriptionWithAi(rawText) {
  if (!anthropic) throw new Error("ANTHROPIC_API_KEY not configured");
  if (!rawText || rawText.trim().length < 1) throw new Error("rawText is empty");

  try {
    const response = await anthropic.messages.parse({
      model: "claude-haiku-4-5",
      max_tokens: 8000,
      temperature: 0,
      system: PRESCRIPTION_EXTRACTION_PROMPT,
      messages: [{ role: "user", content: rawText }],
      output_config: { format: zodOutputFormat(PrescriptionSchema) },
    });

    const raw = (response.content || []).map((c) => (c.type === "text" ? c.text : "")).join("");
    return { raw, parsed: response.parsed_output ?? null };
  } catch (e) {
    error("Parser", "messages.parse failed:", e?.message || e);
    throw e;
  }
}

export async function parseClinicalWithAI(rawText) {
  if (!ANTHROPIC_KEY || !rawText || rawText.trim().length < 10) return null;

  const prompt = CLINICAL_EXTRACTION_PROMPT;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 24000,
        temperature: 0,
        messages: [{ role: "user", content: rawText }],
        system: prompt,
      }),
    });

    if (!resp.ok) {
      error("Parser", `Claude API error: ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    const text = (data.content || []).map((c) => c.text || "").join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return repairAndParseJSON(jsonMatch[0]);
  } catch (e) {
    error("Parser", "Parse error:", e.message);
    return null;
  }
}
