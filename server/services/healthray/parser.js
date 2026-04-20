// ── Clinical notes parsing — extract text, AI parse, JSON repair ────────────

import { createLogger } from "../logger.js";
const { error } = createLogger("HealthRay Sync");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

// ── Use Claude to parse clinical text into structured data ──────────────────
export async function parseClinicalWithAI(rawText) {
  if (!ANTHROPIC_KEY || !rawText || rawText.trim().length < 10) return null;

  const prompt = `Parse this clinical note into structured JSON. Extract ONLY data present in the text.

Return JSON with these keys:
{
  "symptoms": [{"name": "...", "duration": "...", "since_date": "YYYY-MM-DD or null", "severity": "mild/moderate/severe", "related_to": "diagnosis/condition this symptom is related to, or null"}],
  "diagnoses": [{"name": "...", "details": "...", "since": "...", "status": "Present/Absent"}],
  "labs": [{"test": "...", "value": "...", "unit": "...", "date": "..."}],
  "medications": [{"name": "...", "dose": "...", "frequency": "...", "timing": "...", "route": "Oral", "is_new": false}],
  "previous_medications": [{"name": "...", "dose": "...", "frequency": "...", "status": "stopped/changed", "reason": "..."}],
  "vitals": [{"date": "YYYY-MM-DD or null", "height": null, "weight": null, "bmi": null, "bpSys": null, "bpDia": null, "waist": null, "bodyFat": null}],
  "lifestyle": {"diet": null, "exercise": null, "smoking": null, "alcohol": null, "stress": null},
  "investigations_to_order": [{"name": "...", "urgency": "urgent/routine/next_visit"}],
  "follow_up": {"date": null, "timing": null, "notes": null},
  "advice": "..."
}

STRICT Rules:
- NEVER invent or assume data. If a field is not explicitly mentioned in the text, set it to null. Do NOT fill fields with unrelated data.
- NO-PRESCRIPTION FALLBACK (treat Diagnosis summary AS the prescription): Some visits have NO separate MEDICATIONS/PRESCRIPTION section — the doctor instead wraps the entire plan as free text inside a single diagnosis parenthetical after a program label, e.g. "INTENSIVE DIABETES MANAGEMENT PROGRAM ( TYPE 2 DM (SINCE 2018) … TREATMENT: -INJ. RYZODEG 8 UNIT … -TAB SITACIP DM 10+100+500MG OD … PREVIOUS MEDICATION -TAB GLIMESTAR M2 … OBSERVATION-: -FBG-:251.7 … FOLLOW UP ON 26/6/25: … HBA1C: 7 … ADVICE: … )". When you see this pattern, treat that parenthetical AS THE PRESCRIPTION — extract medications, previous_medications, labs, vitals, follow_up, investigations_to_order, and advice from the labelled sub-blocks inside it exactly as if each sub-block had been its own top-level section of the note. Do NOT discard the parenthetical because its outer name (e.g. "INTENSIVE DIABETES MANAGEMENT PROGRAM") is a program label. The inner real diagnoses (TYPE 2 DM, NEUROPATHY, NEPHROPATHY, RETINOPATHY, HYPERTENSION, MASLD, CAD, etc.) are what get extracted as diagnoses — the program label itself is skipped.
- TREATMENT: block = CURRENT medications. Any drug listed under a "TREATMENT:" / "TREATMENT PLAN:" / "CURRENT TREATMENT:" label — whether that label sits in its own section or inside a diagnosis parenthetical — is a CURRENT medication. Put it in "medications", NOT "previous_medications". A leading "-" or "•" on each line is a bullet, not an absent marker. Example: "TREATMENT: -INJ. RYZODEG 8 UNIT ONCE DAILY 30MIN BEFORE BREAKFAST -TAB SITACIP DM 10+100+500MG ONCE DAILY 30 MINUTES BEFORE BREAKFAST -TAB GLIZID M XR 60+500MG ONCE DAILY 30 MINUTES BEFORE DINNER" → three current medications (Ryzodeg 8U SC OD before breakfast, Sitacip DM 10+100+500mg Oral OD before breakfast, Glizid M XR 60+500mg Oral OD before dinner). "REST CONTINUE AS ADVISED BY CARDIOLOGIST" is an instruction — do NOT extract as a medication.
- PREVIOUS MEDICATION block inside a diagnosis parenthetical = previous_medications with status "stopped" (unless the text explicitly says the dose was changed, in which case status "changed"). Reason is "replaced" / "discontinued" / "dose changed" based on context; use "replaced" as the default when the TREATMENT block contains a different regimen.
- For labs: extract ALL lab values with test name, numeric value, unit. Include HbA1c, FBG, PPBG, LDL, TG, HDL, Non-HDL, Cholesterol (Total), TSH, T3, T4, Creatinine, eGFR, UACR, Hb, Iron, Ferritin, OT/SGOT, PT/SGPT, ALP, Calcium, Albumin, GTT, Insulin, C-Peptide, HOMA-IR, HOMA-Beta, Uric Acid, FIB4, Vitamin D, Vitamin B12, AMH, Testosterone, DHEAS, Prolactin, LH, FSH, Estradiol, Progesterone, FPI, Amylase, Lipase, Fecal Elastase (FE), VPT (Vibration Perception Threshold — extract R and L values separately as "VPT Right" / "VPT Left"), ABI (Ankle-Brachial Index — extract as "ABI Right" / "ABI Left"), Hirsutism Score/FGS/H.Score, Potassium, Sodium, etc.
  IMPORTANT — do NOT extract family history values as patient labs. Lines like "FATHER - TG-329, LDL-94" / "MOTHER- TG-132" / "BROTHER - TG-510" are family history — skip entirely.
  Also extract: Urine Pus Cells (e.g. "URINE RE-8 PUS CELLS" → test: "Urine Pus Cells", value: "8"), Amylase, Lipase, Fecal Elastase, GAD65 antibody / IAA / IA2 / ZnT8 autoantibody results (e.g. "GAD65/IAA/IA2 PANEL NEGATIVE" → extract as test: "GAD65/IAA/IA2 Panel", value: "Negative"), Random C-Peptide (e.g. "RANDOM C PEPTIDE-3.47" → test: "C-Peptide (Random)", value: "3.47").
  BRIEF HISTORY section may contain historical HbA1c or glucose readings — extract these as real lab results with whatever date context is available (e.g. "HBA1C-8 IN SEPT,25" → test: "HbA1c", value: "8", date: "2025-09-01"). If no date given, use date: null.
  IMPORTANT — DEDUPLICATION: If the same test with the SAME numeric value appears in both an OBSERVATIONS section (no date) AND a FOLLOW UP section (with a specific date), extract it ONLY ONCE using the follow-up date (which is more specific). Do NOT create two entries for the same value. Example: OBSERVATIONS has "HBA1C-7" (no date) and FOLLOW UP ON 26/6/25 has "HBA1C-7" → extract ONE entry: {test: "HbA1c", value: "7", date: "2025-06-26"}. However, if the same test appears with DIFFERENT values in different sections (e.g. HbA1c 8 in history vs. HbA1c 7 in follow-up), extract EACH as a separate entry — these are genuinely different measurements from different time points.
  When a lab value appears under a "FOLLOW UP ON <date>" or "FOLLOW UP TODAY ON <date>" header, ALWAYS set that lab's date to the follow-up date in YYYY-MM-DD format.
  CRITICAL — distinguish measured results vs. target goals:
  • "FOLLOW UP TODAY ON <date>" / "FOLLOW UP NOTES(<date>)" / "FOLLOW UP ON <date>" sections that contain lab values ALONGSIDE clinical notes, C/O complaints, or symptoms = REAL HISTORICAL MEASUREMENTS from that date — extract as labs with that date.
  • "YOUR NEXT FOLLOW UP IS SCHEDULED ON <date>" / a plain date-only header followed only by FBG-X / PP-X target numbers (no clinical context) / sections explicitly labelled "TARGET" or "GOAL" = TARGET GOALS — do NOT extract as labs.
  • An "OBSERVATION" or "OBSERVATION-:" section header followed by "-TESTNAME-:VALUE" lines is an observations block — extract those values as real lab results. The "-:" suffix on the label is just formatting, NOT an absent marker.
  • A line like "FBG-115" under a future follow-up booking heading = target; but "FBG:105" under "FOLLOW UP TODAY ON 03/02/2026" alongside "C/O LOOSE MOTION" = real result from 03/02/2026.
- For medications: parse CURRENT/TREATMENT medications with name, dose, frequency (OD/BD/TDS/SOS/alternate day etc). "PLAN FOR [drug]" or "PLANNED [drug]" in the ADVICE section = future treatment plan — do NOT extract as a current medication. For twice-daily insulin with different morning and evening doses (e.g. "12 units before breakfast / 8 units before dinner"), extract as ONE medication with dose "12 units (morning) + 8 units (evening)", frequency "BD", route "SC"., timing (before/after food etc), route (Oral/SC/IV/IM etc). Set is_new=true if it's a new addition. Also look for medications where dose has CHANGED (e.g. "NMZ 10 to NMZ 20") — the OLD dose should be in previous_medications. Also capture if note says "DOSE WAS REDUCED/INCREASED" for a medication — record it in previous_medications with reason "dose changed". For sliding scale insulin (different doses per meal), extract as ONE entry with dose as the range (e.g. "5-9 units") and frequency as "Thrice daily". Do NOT create separate entries per meal. Do NOT extract diagnoses, lab findings, clinical events (GMI, hypoglycemia, SGLT2 inhibitor-related events) or monitoring instructions as medications — only actual drugs/injections/ointments/supplements. IMPORTANT: A "-" or "–" at the START of a line in a medication list is a BULLET POINT, not an absent marker — extract it as a medication (e.g. "-PET SAFFA POWDER 1/2 TSP DAILY" → medication: "Pet Saffa Powder", dose: "1/2 tsp", frequency: "OD"). For injections: use route "SC" for subcutaneous (S/C), "IM" for intramuscular, "IV" for intravenous. Nutritional supplements (whey protein, protein powder, meal replacement) — extract as medications with route "Oral" and category implied by name. Powders like "Pet Saffa Powder" are laxative supplements — include as medications.
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
  • "FOLLOW UP TODAY ON <date>" / "FOLLOW UP TODAY:<date>" → date = that date
  • "FOLLOW UP ON <date>" / "FOLLOW UP NOTES(<date>)" → date = that date
  • Any other dated section that contains vital values → date = that date
  Dates come in DD/MM/YYYY (Indian format) — convert to YYYY-MM-DD.
  Extract HT/WT/BMI/BP(sitting)/WC(waist circumference)/BF(body fat) into the entry for that date.
  For BP: "BP SITTING: 165/97 SITTING" — the trailing word "SITTING" is a label duplication error, extract bpSys:165, bpDia:97. "BP STANDING: 152/93" is standing BP — SKIP, do not emit into vitals (we track sitting BP only).
  DO NOT emit entries from:
    • "OBSERVATIONS" / "OBSERVATION-:" sections (undated historical baseline)
    • "VITAL SIGNS" blocks with no associated date
    • "TARGET" / "GOAL" / "YOUR NEXT FOLLOW UP IS SCHEDULED ON <date>" sections (these are future targets, not measurements)
    • Numbers inside a diagnosis parenthetical (e.g. "TYPE 2 DM (HBA1C:7)") — those are diagnosis context, not a measurement event
  If no dated section contains vitals, return [] (empty array).
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
- CRITICAL — all dates in these notes are in DD/MM/YYYY format (Indian standard). "06/04/2026" means April 6 2026 → output as 2026-04-06. NEVER interpret as MM/DD/YYYY.
- Return ONLY valid JSON, no markdown`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16000,
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
