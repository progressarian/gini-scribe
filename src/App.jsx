import { useState, useRef, useEffect } from "react";
import { fixMoMedicines, fixConMedicines, fixQuickMedicines, searchPharmacy } from "./medmatch.js";

// API base URL — same origin in production (API + frontend on same server)
const API_URL = import.meta.env.VITE_API_URL || window.location.origin;

// ============ DEEPGRAM ============
async function transcribeDeepgram(audioBlob, apiKey, language) {
  const lang = language === "multi" ? "en" : language;
  const keywords = "HbA1c:2,eGFR:2,creatinine:2,TSH:2,LDL:2,HDL:2,triglycerides:2,metformin:2,insulin:2,thyronorm:2,dianorm:1,glimepiride:1,telmisartan:1,amlodipine:1,rosuvastatin:1,atorvastatin:1,dapagliflozin:1,empagliflozin:1,sitagliptin:1,vildagliptin:1,proteinuria:1,nephropathy:1,retinopathy:1,neuropathy:1,CABG:1,dyslipidemia:1,hypothyroidism:1,ecosprin:1,concor:1,dytor:1,atchol:1,telma:1,amlong:1,cetanil:1,ciplar:1,lantus:1,tresiba:1,novorapid:1,humalog:1,jardiance:1,forxiga:1,shelcal:1,euthrox:1,glimy:1,mixtard:1";
  const kw = keywords.split(",").map(k => `keywords=${encodeURIComponent(k)}`).join("&");
  const url = `https://api.deepgram.com/v1/listen?model=nova-2&language=${lang}&smart_format=true&punctuate=true&paragraphs=true&${kw}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Token ${apiKey}`, "Content-Type": audioBlob.type || "audio/webm" },
    body: audioBlob
  });
  if (!r.ok) throw new Error(`Transcription error ${r.status}: ${(await r.text().catch(()=>"")).slice(0,120)}`);
  const d = await r.json();
  return d.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
}

// ============ WHISPER ============
async function transcribeWhisper(audioBlob, apiKey, language) {
  const lang = language === "hi" ? "hi" : "en";
  const formData = new FormData();
  formData.append("file", audioBlob, "audio.webm");
  formData.append("model", "whisper-1");
  formData.append("language", lang);
  formData.append("prompt", "Medical consultation in India. Terms: HbA1c, eGFR, creatinine, TSH, LDL, HDL, metformin, insulin, telmisartan, amlodipine, rosuvastatin, dapagliflozin, empagliflozin, thyronorm, dianorm, glimepiride, canagliflozin, proteinuria, nephropathy, retinopathy, CABG, dyslipidemia, hypothyroidism. Patient names in Hindi may be spoken.");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: formData
  });
  if (!r.ok) throw new Error(`Whisper error ${r.status}: ${(await r.text().catch(()=>"")).slice(0,120)}`);
  const d = await r.json();
  return d.text || "";
}

// ============ PROMPTS ============
// Gini Pharmacy brand names for exact matching
const GINI_BRANDS = "Thyronorm,Euthrox,Euthyrox,Telma,Telma AM,Telma H,Telma CT,Telma Beta,Concor,Concor AM,Concor T,Ecosprin AV,Ecosprin Gold,Atchol,Atchol F,Dytor,Dytor Plus,Amlong,Cetanil,Cetanil M,Ciplar LA,Glimy,Rosuvas CV,Dolo,Mixtard,Huminsulin,Lantus,Tresiba,Novorapid,Humalog,Clopitab,Dianorm,Glycomet,Amaryl,Jalra,Galvus,Forxiga,Jardiance,Pan D,Razo D,Shelcal,Calnex,Uprise D3,Stamlo,Cardivas,Atorva,Rozavel,Arkamin,Prazopress,Minipress,Lasix,Aldactone,Eltroxin,Thyrox,Cilacar,Amlokind,Telmikind,Metapure,Obimet,Gluconorm";

// Drug class → biomarker relevance mapping for intelligent filtering
const DRUG_BIOMARKER_MAP = {
  // Antidiabetics → HbA1c, Fasting Glucose
  diabetes: { patterns: /glycomet|metformin|glizid|gliclazide|glimepiride|glimy|amaryl|galvus|vildagliptin|jalra|sitagliptin|forxiga|dapagliflozin|jardiance|empagliflozin|dianorm|gluconorm|cetanil|mixtard|huminsulin|lantus|tresiba|novorapid|humalog|insulin|ozempic|rybelsus|semaglutide|liraglutide|reclimet|istavel/i, biomarkers: ["hba1c","fpg"] },
  // Weight-affecting drugs → Weight (SGLT2i, GLP-1, Metformin)
  weight: { patterns: /forxiga|dapagliflozin|jardiance|empagliflozin|ozempic|rybelsus|semaglutide|liraglutide|trulicity|dulaglutide|victoza|saxenda|mounjaro|tirzepatide|metformin|glycomet|reclimet/i, biomarkers: ["weight"] },
  // Antihypertensives → BP
  bp: { patterns: /telma|telmisartan|amlong|amlodipine|concor|bisoprolol|stamlo|cilacar|cilnidipine|arkamin|clonidine|prazopress|minipress|dytor|torsemide|lasix|furosemide|aldactone|metoprolol|atenolol|ramipril|enalapril|losartan|cardivas|carvedilol|ciplar|propranolol|metosartan/i, biomarkers: ["bp"] },
  // Statins/Lipid → LDL, Triglycerides, HDL
  lipid: { patterns: /atchol|atorva|atorvastatin|rosuvas|rosuvastatin|rozavel|ecosprin|clopitab|fenofibrate|torglip/i, biomarkers: ["ldl","triglycerides","hdl"] },
  // Thyroid → TSH
  thyroid: { patterns: /thyronorm|eltroxin|thyrox|euthrox|levothyroxine/i, biomarkers: ["tsh"] },
  // Nephroprotective → eGFR, Creatinine, UACR
  kidney: { patterns: /forxiga|dapagliflozin|jardiance|empagliflozin|telma|telmisartan|ramipril|enalapril|losartan/i, biomarkers: ["egfr","creatinine","uacr"] },
};

function getMedsForBiomarker(biomarkerKey, meds) {
  const relevant = [];
  for (const [cls, info] of Object.entries(DRUG_BIOMARKER_MAP)) {
    if (info.biomarkers.includes(biomarkerKey)) {
      meds.forEach(m => {
        const name = (m.pharmacy_match || m.name || m || "").toString();
        if (info.patterns.test(name)) relevant.push(name);
      });
    }
  }
  // Deduplicate
  return [...new Set(relevant)];
}

const MO_PROMPT = `You are a clinical documentation assistant for Gini Advanced Care Hospital, Mohali.
Structure the MO's verbal summary into JSON. Output ONLY valid JSON. No backticks.

{"diagnoses":[{"id":"hypo","label":"Hypothyroidism (Since 2000)","status":"Controlled"}],"chief_complaints":["Tingling in feet for 3 months","Fatigue","Increased thirst"],"complications":[{"name":"Nephropathy","status":"+","detail":"eGFR 29, CKD Stage 4","severity":"high"}],"history":{"family":"Father CAD post-CABG, Mother DM","past_medical_surgical":"NIL","personal":"Non-smoker, no alcohol","covid":"No exposure","vaccination":"Completed"},"previous_medications":[{"name":"THYRONORM 88","composition":"Levothyroxine 88mcg","dose":"88mcg","frequency":"OD","timing":"Empty stomach morning"}],"investigations":[{"test":"TSH","value":7.2,"unit":"mIU/L","flag":"HIGH","critical":false,"ref":"0.4-4.0"},{"test":"HbA1c","value":6.0,"unit":"%","flag":null,"critical":false,"ref":"<6.5"}],"missing_investigations":["HDL","Total Cholesterol"]}

RULES:
- IDs: dm2,htn,cad,ckd,hypo,obesity,dyslipidemia
- chief_complaints: Extract ALL symptoms patient reports (tingling, fatigue, breathlessness, chest pain, frequent urination, blurry vision, weight gain, etc). Array of strings. MUST be filled — at least 1 complaint.
- Status MUST be exactly one of: "Controlled", "Uncontrolled", "New". NO other values like "Active", "Present", "Suboptimal". If newly diagnosed use "New". If on treatment but not at target use "Uncontrolled". If stable/at target use "Controlled".
- If BMI>=25 or weight concern mentioned, ALWAYS add obesity diagnosis with id:"obesity"
- flag: "HIGH"/"LOW"/null. critical:true ONLY if dangerous (HbA1c>10, eGFR<30, Cr>2)
- Include ALL investigations mentioned with values, units, flags
- Include vital signs as investigations if mentioned (BP, Pulse, Weight, BMI)
- Indian brand names: identify composition
- MEDICINE NAME MATCHING: Use EXACT brand names from Gini pharmacy: ${GINI_BRANDS}. When doctor says a medicine name, match to the closest brand. E.g. "thyro norm 88"→"THYRONORM 88MCG", "telma 40"→"TELMA 40", "ecosprin gold"→"ECOSPRIN GOLD", "atchol 10"→"ATCHOL 10", "concor am"→"CONCOR AM", "dytor 10"→"DYTOR 10"
- Keep label SHORT (max 8 words)
- complications severity: "high" if active/dangerous, "low" if stable`;

const CONSULTANT_PROMPT = `Extract clinical decisions from consultant's verbal notes. Output ONLY valid JSON. No backticks.
Hindi: "uss ke baad"=after that, "phor hum"=then we, "karenge"=will do, "dena hai"=give, "band karo"=stop, "badhao"=increase, "pe focus karenge"=will focus on

{"assessment_summary":"Patient-friendly 1-2 line summary of what's happening and what we're doing","key_issues":["Poor glycemic control - HbA1c 7.5","Blood pressure control needed","Weight management"],"diet_lifestyle":[{"advice":"Calorie-restricted diet","detail":"Focus on complex carbs, avoid sugar","category":"Diet","helps":["dm2","obesity"]},{"advice":"Walking 10,000 steps daily","detail":"Start gradual, increase weekly","category":"Exercise","helps":["dm2","htn"]}],"medications_confirmed":[{"name":"TAB METFORMIN 500","composition":"Metformin 500mg","dose":"500mg","frequency":"OD to BD (titrate)","timing":"After meals","route":"Oral","forDiagnosis":["dm2"],"isNew":true}],"medications_needs_clarification":[{"what_consultant_said":"SGLT2 inhibitor","drug_class":"SGLT2 inhibitor","missing":["brand_name"],"suggested_options":["Dapagliflozin 10mg","Empagliflozin 25mg"],"forDiagnosis":["dm2"],"default_timing":"Before breakfast","default_dose":"10mg"}],"monitoring":["SMBG daily fasting"],"investigations_to_order":["TFT","UACR"],"follow_up":{"duration":"6 weeks","tests_to_bring":["HbA1c","RFT","Lipid profile"]},"future_plan":[{"condition":"If weight not reducing in 6 weeks","action":"Consider GLP-1 RA"}],"goals":[{"marker":"HbA1c","current":"7.5%","target":"<6.5%","timeline":"3 months","priority":"critical"},{"marker":"BP","current":"149/85","target":"<130/80","timeline":"4 weeks","priority":"high"},{"marker":"Weight","current":"85kg","target":"80kg","timeline":"6 weeks","priority":"high"}],"self_monitoring":[{"title":"Blood Sugar Monitoring","instructions":["Check fasting sugar daily morning","Check post-meal sugar 2hrs after lunch twice a week","Maintain diary with date, time, value"],"targets":"Fasting 90-130 mg/dL, Post-meal <180 mg/dL","alert":"If sugar <70: eat 3 glucose tablets IMMEDIATELY, recheck in 15 min"}]}

CRITICAL MEDICATION RULES:
1. For EVERY medication, ALWAYS fill timing:
   - SGLT2i (dapagliflozin/empagliflozin): "Before breakfast"
   - Metformin: "After meals" 
   - Sulfonylureas (glimepiride/gliclazide): "Before breakfast"
   - Statins (atorvastatin/rosuvastatin): "At bedtime"
   - Thyroid (levothyroxine): "Empty stomach, 30min before breakfast"
   - ACE/ARB (telmisartan/losartan): "Morning" or "Morning + Evening"
   - Insulin: "Before meals" or "At bedtime" (specify which)
   - Aspirin: "After lunch"
2. If timing not mentioned explicitly, INFER from drug class. NEVER leave timing empty.
3. If dose range given ("500mg to 1g"), put full range in dose field
4. For needs_clarification items, ALWAYS include default_timing and default_dose based on drug class
5. Extract ALL medications including those to continue from previous
6. MEDICINE NAME MATCHING: Use EXACT brand names from Gini pharmacy: ${GINI_BRANDS}. Match spoken names: "thyro norm"→"THYRONORM", "telma am"→"TELMA AM", "ecosprin"→"ECOSPRIN AV", "atchol"→"ATCHOL", "concor"→"CONCOR", "dytor"→"DYTOR"
7. If INSULIN is prescribed, ALWAYS add an "insulin_education" section:
   {"insulin_education":{"type":"Basal/Premix/Bolus","device":"Pen/Syringe","injection_sites":["Abdomen","Thigh"],"storage":"Keep in fridge, room temp vial valid 28 days","titration":"Increase by 2 units every 3 days if fasting >130","hypo_management":"If sugar <70: 3 glucose tablets, recheck 15 min","needle_disposal":"Use sharps container, never reuse needles"}}
   Fill titration based on consultant's instructions. If not specified, use standard protocols.`;

const LAB_PROMPT = `Extract ALL test results. Return ONLY valid JSON, no backticks.
{"patient_on_report":{"name":"","age":"","sex":""},"panels":[{"panel_name":"Panel","tests":[{"test_name":"","result":0.0,"result_text":null,"unit":"","flag":null}]}]}
flag: "H" high, "L" low, null normal.`;

const IMAGING_PROMPT = `Extract findings from this medical imaging/diagnostic report. Return ONLY valid JSON, no backticks.
{
  "report_type":"DEXA|X-Ray|MRI|Ultrasound|ABI|VPT|Fundus|ECG|Echo|CT|PFT|NCS",
  "patient_on_report":{"name":"","age":"","sex":""},
  "date":"YYYY-MM-DD or null",
  "findings":[{"parameter":"","value":"","unit":"","interpretation":"Normal|Abnormal|Borderline","detail":""}],
  "impression":"overall summary string",
  "recommendations":"string or null"
}
EXTRACTION RULES BY TYPE:
- DEXA: T-score (spine, hip, femoral neck), BMD values, Z-score → flag osteoporosis/osteopenia
- X-Ray: findings, fractures, alignment, soft tissue, joint space
- MRI: disc bulge/herniation levels, spinal canal stenosis, ligament tears, signal changes
- Ultrasound: organ dimensions, echogenicity, lesions, free fluid, Doppler findings
- ABI (Ankle-Brachial Index): ABI ratio per limb (>0.9 normal, 0.7-0.9 mild, <0.7 severe PAD)
- VPT (Vibration Perception Threshold): voltage readings per site, grade (normal <15V, mild 15-25V, severe >25V)
- Fundus: retinopathy grade (none/mild NPDR/moderate NPDR/severe NPDR/PDR), macular edema, disc changes
- ECG: rate, rhythm, axis, intervals (PR, QRS, QTc), ST changes, conduction blocks
- Echo: EF%, chamber dimensions, valve function, wall motion, diastolic function
- PFT: FEV1, FVC, FEV1/FVC ratio, DLCO
- NCS (Nerve Conduction): nerve velocities, amplitudes, latencies per nerve
Extract ALL numeric values. If value is a range or description, put in "detail" field.`;

const AI_CHAT_SYSTEM = `You are Gini AI, a clinical decision support assistant for doctors at Gini Advanced Care Hospital, Mohali.
You have access to the patient's data (provided below). Answer questions about:
- This patient's history, medications, labs, trends
- Drug interactions, dosing guidelines, side effects
- Clinical guidelines (ADA, ESC, KDIGO, NICE, ATS) relevant to this patient
- Differential diagnoses based on patient presentation
- Suggested investigations or referrals
RULES:
- Always reference specific patient data when answering
- Cite guideline sources (e.g., "Per ADA 2024 Standards of Care...")
- Flag drug interactions or contraindications proactively
- Use Indian brand names alongside generics
- Be concise but clinically thorough
- If unsure, say so — never fabricate clinical data
- Language: English with Hindi/Punjabi medical terms OK`;

const PATIENT_VOICE_PROMPT = `Extract patient info. ONLY valid JSON, no backticks.
{"name":"string or null","age":"number or null","sex":"Male/Female or null","phone":"string or null","fileNo":"string or null","dob":"YYYY-MM-DD or null","abhaId":"string or null","aadhaar":"string or null","healthId":"string or null","govtId":"string or null","govtIdType":"Aadhaar/Passport/DrivingLicense or null"}
IMPORTANT: Always return name in ENGLISH/ROMAN script, never Hindi/Devanagari. Transliterate if needed: "हिम्मत सिंह"→"Himmat Singh", "कमला देवी"→"Kamla Devi".
Parse dates: "1949 august 1"="1949-08-01". "file p_100"→fileNo:"P_100". Calculate age from DOB.
ABHA ID format: XX-XXXX-XXXX-XXXX. Aadhaar: 12-digit number.`;

const RX_EXTRACT_PROMPT = `You are a medical record parser. Extract structured data from this old prescription/consultation note.
Return ONLY valid JSON, no backticks.
{
  "visit_date":"YYYY-MM-DD or null",
  "doctor_name":"string or null",
  "specialty":"string or null",
  "diagnoses":[{"id":"dm2","label":"Type 2 DM (since 2015)","status":"Controlled"}],
  "medications":[{"name":"MEDICINE NAME","dose":"dose","frequency":"OD/BD/TDS","timing":"Morning/Night"}],
  "vitals":{"bp_sys":null,"bp_dia":null,"weight":null,"height":null,"pulse":null},
  "advice":["string"],
  "follow_up":"string or null"
}
RULES:
- Diagnosis IDs: dm2,dm1,htn,cad,ckd,hypo,obesity,dyslipidemia,asthma,copd,pcos,oa,ra,liver,stroke,epilepsy,depression,anxiety,gerd,ibs
- Status: "Controlled","Uncontrolled","New" based on context
- MEDICINE: Use EXACT brand names from prescription, capitalize properly
- Extract ALL medicines even if partially readable
- Parse Hindi/Punjabi terms: "sugar ki dawai"=diabetes medication, "BP ki goli"=antihypertensive
- If date not found, return null
- Name must be in English/Roman script`;

const REPORT_EXTRACT_PROMPT = `Extract ALL test results from this medical report. Return ONLY valid JSON, no backticks.
{
  "report_type":"Blood Test|Thyroid Panel|Lipid Profile|Kidney Function|Liver Function|HbA1c|CBC|Urine|Other",
  "lab_name":"string or null",
  "report_date":"YYYY-MM-DD or null",
  "patient_on_report":{"name":"","age":"","sex":""},
  "tests":[{"test_name":"HbA1c","result":8.2,"unit":"%","flag":"HIGH","ref_range":"4.0-6.5","critical":false}]
}
RULES:
- flag: "HIGH" if above range, "LOW" if below, null if normal
- critical: true if dangerously out of range (e.g., K+ >6, glucose >400, creatinine >5)
- Include ALL tests found, even basic ones
- Normalize test names: "Glycosylated Haemoglobin"→"HbA1c", "Serum Creatinine"→"Creatinine", "TSH (Ultrasensitive)"→"TSH"
- result must be numeric where possible
- If text result like "Positive"/"Negative", put in result_text field and set result to null`;

const QUICK_MODE_PROMPT = `You are a clinical documentation assistant for Gini Advanced Care Hospital.
The doctor has dictated a COMPLETE consultation in one go. Parse it into ALL sections.
Hindi: "patient ka naam"=patient name, "sugar"=diabetes, "BP"=blood pressure, "dawai"=medicine
Output ONLY valid JSON, no backticks.

{"patient":{"name":"string","age":"number","sex":"Male/Female","phone":"string or null","fileNo":"string or null","dob":"YYYY-MM-DD or null"},"vitals":{"bp_sys":"number or null","bp_dia":"number or null","pulse":"number or null","spo2":"number or null","weight":"number or null","height":"number or null"},"mo":{"diagnoses":[{"id":"dm2","label":"Type 2 DM (10 years)","status":"Uncontrolled"}],"complications":[{"name":"string","status":"Active/Resolved","detail":"string"}],"history":{"family":"","past_medical_surgical":"","personal":""},"previous_medications":[{"name":"METFORMIN 500MG","composition":"Metformin 500mg","dose":"500mg","frequency":"BD","timing":"After meals"}],"investigations":[{"test":"HbA1c","value":8.5,"unit":"%","flag":"HIGH","critical":false,"ref":"<6.5"}],"chief_complaints":["Tingling in feet","Fatigue","Frequent urination"],"compliance":"Good/Partial/Poor — brief note on medicine and lifestyle adherence"},"consultant":{"assessment_summary":"Dear [FirstName]: patient-friendly 2-3 line summary of ALL findings, diagnoses, and treatment plan.","key_issues":["Issue 1","Issue 2"],"diet_lifestyle":[{"advice":"Walk 10,000 steps daily","detail":"Start with 5000, increase weekly","category":"Exercise","helps":["dm2","obesity"]},{"advice":"1500 calorie diabetic diet","detail":"Low GI carbs, avoid sugar","category":"Diet","helps":["dm2"]},{"advice":"Reduce salt to <5g/day","detail":"Avoid pickles, papad","category":"Diet","helps":["htn"]}],"medications_confirmed":[{"name":"BRAND NAME","composition":"Generic","dose":"dose","frequency":"OD/BD/TDS","timing":"Morning/Night/Before meals","route":"Oral/SC/IM","forDiagnosis":["dm2"],"isNew":false}],"medications_needs_clarification":[],"goals":[{"marker":"HbA1c","current":"8.5%","target":"<7%","timeline":"3 months"}],"follow_up":{"duration":"6 weeks","tests_to_bring":["HbA1c","Fasting glucose"]},"self_monitoring":[{"title":"Blood Sugar Monitoring","instructions":["Check fasting sugar daily morning","Check post-meal sugar twice a week"],"targets":"Fasting 90-130 mg/dL, Post-meal <180 mg/dL","alert":"If sugar <70: eat glucose tablets immediately"},{"title":"Blood Pressure Monitoring","instructions":["Check BP morning and evening","Record in diary"],"targets":"<130/80 mmHg","alert":"If BP >180/110: go to ER immediately"}],"future_plan":[{"condition":"If HbA1c not below 7 in 3 months","action":"Consider adding GLP-1 RA or insulin"},{"condition":"Fundus examination pending","action":"Schedule within 2 weeks"}]}}

CRITICAL RULES — EVERY FIELD MUST BE FILLED:
- Split dictation: patient info → history/meds → plan/changes
- Diagnosis IDs: dm2,dm1,htn,cad,ckd,hypo,obesity,dyslipidemia,dfu,masld,nephropathy
- Status: "Controlled", "Uncontrolled", or "New" ONLY
- MEDICINE NAMES: Use EXACT Gini pharmacy brands: ${GINI_BRANDS}
- If BMI>=25 or weight concern: add obesity/weight management diagnosis
- ALWAYS fill medication timing (infer from drug class if not stated)
- Include ALL medications: both existing (isNew:false) AND newly prescribed (isNew:true)
- assessment_summary: MUST be patient-friendly, address by first name, cover ALL findings
- diet_lifestyle: MUST have 3-5 items as OBJECTS with {advice, detail, category, helps}. category: "Diet"/"Exercise"/"Critical"/"Sleep"/"Stress". helps: array of diagnosis IDs this helps
- goals: MUST have 2-4 items with marker, current value, target, and timeline. Use lab values and vitals as current values.
- self_monitoring: MUST have 2-4 OBJECTS with {title, instructions[], targets, alert}. Group by what to monitor (Blood Sugar, BP, Weight etc)
- future_plan: MUST be OBJECTS with {condition, action}. "If X → Y" format
- chief_complaints: Extract ALL symptoms patient reports (tingling, fatigue, breathlessness, chest pain, etc). Empty array if none
- compliance: "Good"/"Partial"/"Poor" + brief note. Infer from context (taking medicines regularly=Good, missed doses/not walking=Partial)
- Calculate age from DOB (e.g., born 1957 → ~67-68 years)
- Extract ALL lab values as investigations with proper flags (HIGH/LOW/null)
- Include complications (e.g., diabetic foot ulcer, retinopathy, neuropathy)
- Name MUST be in English/Roman script, never Hindi/Devanagari`;

const VITALS_VOICE_PROMPT = `Extract vitals. ONLY valid JSON, no backticks.
{"bp_sys":"number or null","bp_dia":"number or null","pulse":"number or null","temp":"number or null","spo2":"number or null","weight":"number or null","height":"number or null","waist":"number or null","body_fat":"number or null","muscle_mass":"number or null"}
"BP 140 over 90"->bp_sys:140,bp_dia:90. "waist 36 inches"->waist:36. "body fat 28 percent"->body_fat:28. "muscle mass 32 kg"->muscle_mass:32`;

// ============ API ============
async function callClaude(prompt, content) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 8000, messages: [{ role: "user", content: `${prompt}\n\nINPUT:\n${content}` }] })
    });
    if (!r.ok) return { data: null, error: `API ${r.status}: ${(await r.text().catch(()=>"")).slice(0,120)}` };
    const d = await r.json();
    if (d.error) return { data: null, error: d.error.message };
    const t = (d.content || []).map(c => c.text || "").join("");
    if (!t) return { data: null, error: "Empty response" };
    let clean = t.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    // Try direct parse
    try { return { data: JSON.parse(clean), error: null }; }
    catch {
      // Fix common issues
      clean = clean.replace(/,\s*([}\]])/g, "$1").replace(/\n/g, " ");
      // Balance brackets
      const balance = (s) => {
        const ob=(s.match(/{/g)||[]).length, cb=(s.match(/}/g)||[]).length;
        const oB=(s.match(/\[/g)||[]).length, cB=(s.match(/\]/g)||[]).length;
        for(let i=0;i<oB-cB;i++) s+="]";
        for(let i=0;i<ob-cb;i++) s+="}";
        return s;
      };
      try { return { data: JSON.parse(balance(clean)), error: null }; }
      catch {
        // Last resort: truncate backwards to find valid JSON
        for (let end = clean.length; end > 50; end -= 10) {
          try {
            const attempt = balance(clean.slice(0, end).replace(/,\s*$/,""));
            return { data: JSON.parse(attempt), error: null };
          } catch {}
        }
        return { data: null, error: `Parse failed. Try shorter input.` };
      }
    }
  } catch (e) { return { data: null, error: e.message }; }
}

async function extractLab(base64, mediaType) {
  try {
    const block = mediaType==="application/pdf"
      ? { type:"document", source:{type:"base64",media_type:"application/pdf",data:base64} }
      : { type:"image", source:{type:"base64",media_type:mediaType,data:base64} };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"},
      body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:8000,messages:[{role:"user",content:[block,{type:"text",text:LAB_PROMPT}]}]})
    });
    if (!r.ok) return { data:null, error:`API ${r.status}` };
    const d = await r.json();
    if (d.error) return { data:null, error:d.error.message };
    const t = (d.content||[]).map(c=>c.text||"").join("");
    let clean = t.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim();
    try { return { data:JSON.parse(clean), error:null }; }
    catch {
      clean = clean.replace(/,\s*([}\]])/g,"$1");
      const ob=(clean.match(/{/g)||[]).length, cb=(clean.match(/}/g)||[]).length;
      for(let i=0;i<ob-cb;i++) clean+="}";
      try { return { data:JSON.parse(clean), error:null }; }
      catch { return { data:null, error:"Parse failed" }; }
    }
  } catch(e) { return { data:null, error:e.message }; }
}

async function extractImaging(base64, mediaType) {
  try {
    const block = mediaType==="application/pdf"
      ? { type:"document", source:{type:"base64",media_type:"application/pdf",data:base64} }
      : { type:"image", source:{type:"base64",media_type:mediaType,data:base64} };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"},
      body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:8000,messages:[{role:"user",content:[block,{type:"text",text:IMAGING_PROMPT}]}]})
    });
    if (!r.ok) return { data:null, error:`API ${r.status}` };
    const d = await r.json();
    if (d.error) return { data:null, error:d.error.message };
    const t = (d.content||[]).map(c=>c.text||"").join("");
    let clean = t.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim();
    try { return { data:JSON.parse(clean), error:null }; }
    catch {
      clean = clean.replace(/,\s*([}\]])/g,"$1");
      const ob=(clean.match(/{/g)||[]).length, cb=(clean.match(/}/g)||[]).length;
      for(let i=0;i<ob-cb;i++) clean+="}";
      try { return { data:JSON.parse(clean), error:null }; }
      catch { return { data:null, error:"Parse failed" }; }
    }
  } catch(e) { return { data:null, error:e.message }; }
}

async function aiChat(messages, patientContext) {
  try {
    const systemPrompt = AI_CHAT_SYSTEM + (patientContext ? `\n\nPATIENT DATA:\n${patientContext}` : "\n\nNo patient loaded.");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"},
      body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:4000,system:systemPrompt,messages})
    });
    if (!r.ok) return { text:null, error:`API ${r.status}` };
    const d = await r.json();
    if (d.error) return { text:null, error:d.error.message };
    return { text:(d.content||[]).map(c=>c.text||"").join(""), error:null };
  } catch(e) { return { text:null, error:e.message }; }
}

// ============ AUDIO INPUT ============
const CLEANUP_PROMPT = `Fix medical transcription errors in this text. Return ONLY the corrected text, nothing else.
Common fixes needed:
- Drug names: "thyro norm"→"Thyronorm", "die a norm"→"Dianorm", "telma"→"Telma", "ecosprin"→"Ecosprin", "atchol"→"Atchol", "concor"→"Concor", "dytor"→"Dytor", "gluco"→"Gluco", "rosu"→"Rosuvastatin"
- Gini pharmacy brands: Thyronorm,Euthrox,Euthyrox,Telma,Concor,Ecosprin,Atchol,Dytor,Amlong,Cetanil,Ciplar,Glimy,Dolo,Lantus,Tresiba,Novorapid,Humalog,Mixtard,Jardiance,Forxiga,Pan D,Shelcal,Stamlo,Atorva,Rozavel
- Lab tests: "H B A one C"/"hba1c"→"HbA1c", "e GFR"→"eGFR", "T S H"→"TSH", "LDL"/"HDL" keep as-is
- Medical: "die a betis"→"diabetes", "hyper tension"→"hypertension", "thyroid ism"→"thyroidism"
- Numbers: Keep all numbers exactly as spoken
- Hindi words: Keep as-is (don't translate)
- Names: Convert Hindi script to English/Roman: "हिम्मत सिंह"→"Himmat Singh"
Do NOT add, remove, or rearrange content. Only fix spelling of medical terms.`;

async function cleanupTranscript(text) {
  if (!text || text.length < 10) return text;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 2000, messages: [{ role: "user", content: `${CLEANUP_PROMPT}\n\nTEXT:\n${text}` }] })
    });
    if (!r.ok) return text; // Fail silently, return original
    const d = await r.json();
    const cleaned = (d.content || []).map(c => c.text || "").join("").trim();
    return cleaned || text;
  } catch { return text; }
}

function AudioInput({ onTranscript, dgKey, whisperKey, label, color, compact }) {
  const [mode, setMode] = useState(null); // null, recording, cleaning, recorded, transcribing, done
  const [transcript, setTranscript] = useState("");
  const [liveText, setLiveText] = useState("");
  const [error, setError] = useState("");
  const [audioUrl, setAudioUrl] = useState(null);
  const [duration, setDuration] = useState(0);
  const [lang, setLang] = useState("en");
  const [engine, setEngine] = useState(dgKey ? "deepgram" : "whisper");
  const [useCleanup, setUseCleanup] = useState(true);
  const mediaRec = useRef(null);
  const chunks = useRef([]);
  const audioBlob = useRef(null);
  const tmr = useRef(null);
  const fileRef = useRef(null);
  const wsRef = useRef(null);
  const finalsRef = useRef([]);
  const interimRef = useRef("");
  const audioCtxRef = useRef(null);
  const streamRef = useRef(null);
  const modeRef = useRef(null); // track mode without stale closures
  const processorRef = useRef(null);

  // Keep modeRef in sync
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const doTranscribe = async (blob) => {
    if (engine === "whisper" && whisperKey) {
      return await transcribeWhisper(blob, whisperKey, lang);
    }
    return await transcribeDeepgram(blob, dgKey, lang);
  };

  // Streaming recording with Deepgram WebSocket + raw PCM via AudioContext
  const startStreamingRec = async () => {
    setError(""); setLiveText(""); setTranscript("");
    finalsRef.current = []; interimRef.current = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
      streamRef.current = stream;

      // Also start MediaRecorder to save audio for playback
      const mt = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mt, audioBitsPerSecond: 32000 });
      chunks.current = [];
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
      mediaRec.current = rec;
      rec.start(1000);

      // AudioContext to get raw PCM for WebSocket
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // Open Deepgram WebSocket
      const wsLang = lang === "hi" ? "hi" : "en";
      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${wsLang}&smart_format=true&punctuate=true&interim_results=true&encoding=linear16&sample_rate=16000&channels=1`;
      const ws = new WebSocket(wsUrl, ["token", dgKey]);
      wsRef.current = ws;

      ws.onopen = () => {
        // Send raw PCM via processor
        processor.onaudioprocess = (e) => {
          if (ws.readyState === WebSocket.OPEN) {
            const float32 = e.inputBuffer.getChannelData(0);
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
              int16[i] = Math.max(-32768, Math.min(32767, Math.floor(float32[i] * 32768)));
            }
            ws.send(int16.buffer);
          }
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "Results" && msg.channel?.alternatives?.[0]) {
            const alt = msg.channel.alternatives[0];
            const text = alt.transcript || "";
            if (msg.is_final) {
              if (text) finalsRef.current.push(text);
              interimRef.current = "";
            } else {
              interimRef.current = text;
            }
            const fullText = [...finalsRef.current, interimRef.current].filter(Boolean).join(" ");
            setLiveText(fullText);
          }
        } catch {}
      };

      ws.onerror = () => {
        setError("Streaming failed — try Upload instead");
        cleanupStreaming();
        setMode("recorded");
      };

      ws.onclose = async () => {
        const finalText = finalsRef.current.filter(Boolean).join(" ");
        if (finalText) {
          // Save recording blob for playback
          if (mediaRec.current?.state !== "inactive") mediaRec.current?.stop();
          await new Promise(r => setTimeout(r, 200)); // Wait for MediaRecorder to flush
          const blob = new Blob(chunks.current, { type: mt });
          audioBlob.current = blob;
          setAudioUrl(URL.createObjectURL(blob));
          // Run AI cleanup
          if (useCleanup) {
            setMode("cleaning");
            const cleaned = await cleanupTranscript(finalText);
            setTranscript(cleaned);
          } else {
            setTranscript(finalText);
          }
          setMode("done");
        } else if (modeRef.current === "recording") {
          setError("No speech detected — try again or speak louder");
          setMode(null);
        }
      };

      setMode("recording"); setDuration(0);
      tmr.current = setInterval(() => setDuration(d => d + 1), 1000);

    } catch (err) {
      setError("Mic access denied. Use Upload or paste text.");
    }
  };

  const cleanupStreaming = () => {
    if (processorRef.current) { try { processorRef.current.disconnect(); } catch {} }
    if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); }
  };

  // Non-streaming fallback (also used for Whisper engine and file uploads)
  const startNonStreamingRec = async (existingStream, mt) => {
    try {
      const stream = existingStream || await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
      if (!mt) mt = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mt, audioBitsPerSecond: 32000 });
      chunks.current = [];
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunks.current, { type: mt });
        audioBlob.current = blob;
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(t => t.stop());
        setMode("transcribing");
        try {
          let text = await doTranscribe(blob);
          if (!text) throw new Error("Empty — try again or speak louder");
          if (useCleanup) { setMode("cleaning"); text = await cleanupTranscript(text); }
          setTranscript(text); setMode("done");
        } catch (err) { setError(err.message); setMode("recorded"); }
      };
      mediaRec.current = rec; rec.start(1000);
      if (!existingStream) {
        setMode("recording"); setDuration(0);
        tmr.current = setInterval(() => setDuration(d => d + 1), 1000);
      }
    } catch { setError("Mic access denied. Use Upload or paste text."); }
  };

  const startRec = () => {
    // Use streaming for Deepgram, non-streaming for Whisper
    if (engine === "deepgram" || (!whisperKey && dgKey)) {
      startStreamingRec();
    } else {
      startNonStreamingRec();
    }
  };

  const stopRec = () => {
    clearInterval(tmr.current);
    // Stop processor and close AudioContext
    cleanupStreaming();
    // Stop MediaRecorder
    if (mediaRec.current?.state !== "inactive") mediaRec.current?.stop();
    // Close WebSocket (triggers onclose which processes the transcript)
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      // Give Deepgram a moment to send final results before closing
      setTimeout(() => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close(); }, 500);
    }
  };

  const handleFile = e => { const f=e.target.files[0]; if(!f) return; audioBlob.current=f; setAudioUrl(URL.createObjectURL(f)); setMode("recorded"); setError(""); };
  const transcribe = async () => {
    if (!audioBlob.current) return;
    setMode("transcribing"); setError("");
    try {
      let text = await doTranscribe(audioBlob.current);
      if (!text) throw new Error("Empty — try again or paste manually");
      if (useCleanup) { setMode("cleaning"); text = await cleanupTranscript(text); }
      setTranscript(text); setMode("done");
    } catch (err) { setError(err.message); setMode("recorded"); }
  };
  const reset = () => {
    setMode(null); setTranscript(""); setLiveText(""); setAudioUrl(null);
    audioBlob.current=null; setError(""); setDuration(0);
    finalsRef.current=[]; interimRef.current="";
    cleanupStreaming();
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close();
  };
  const fmt = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

  return (
    <div style={{ border:`2px solid ${mode==="recording"?"#ef4444":mode==="cleaning"?"#f59e0b":"#e2e8f0"}`, borderRadius:8, padding:compact?8:12, background:mode==="recording"?"#fef2f2":mode==="cleaning"?"#fffbeb":"white", marginBottom:8 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <div style={{ fontSize:compact?11:13, fontWeight:700, color:"#1e293b" }}>🎤 {label}</div>
        <div style={{ display:"flex", gap:4, alignItems:"center" }}>
          {whisperKey && dgKey && <div style={{ display:"flex", gap:1, background:"#f1f5f9", borderRadius:4, padding:1 }}>
            {[{v:"deepgram",l:"DG"},{v:"whisper",l:"W"}].map(x => (
              <button key={x.v} onClick={()=>setEngine(x.v)} style={{ padding:"1px 5px", fontSize:8, fontWeight:700, borderRadius:3, cursor:"pointer", background:engine===x.v?"#1e293b":"transparent", color:engine===x.v?"white":"#94a3b8", border:"none" }}>{x.l}</button>
            ))}
          </div>}
          <button onClick={()=>setUseCleanup(c=>!c)} style={{ padding:"1px 5px", fontSize:8, fontWeight:700, borderRadius:3, cursor:"pointer", background:useCleanup?"#059669":"#f1f5f9", color:useCleanup?"white":"#94a3b8", border:"none" }} title="AI cleanup of medical terms">AI✓</button>
          <div style={{ display:"flex", gap:1 }}>
            {[{v:"en",l:"EN"},{v:"hi",l:"HI"}].map(x => (
              <button key={x.v} onClick={()=>setLang(x.v)} style={{ padding:"1px 5px", fontSize:9, fontWeight:700, borderRadius:3, cursor:"pointer", background:lang===x.v?color:"white", color:lang===x.v?"white":"#94a3b8", border:`1px solid ${lang===x.v?color:"#e2e8f0"}` }}>{x.l}</button>
            ))}
          </div>
        </div>
      </div>
      {!mode && (
        <>
          <div style={{ display:"flex", gap:6 }}>
            <button onClick={startRec} style={{ flex:1, background:"#dc2626", color:"white", border:"none", padding:compact?"6px":"10px", borderRadius:6, fontSize:compact?11:13, fontWeight:700, cursor:"pointer" }}>🔴 Record</button>
            <button onClick={()=>fileRef.current?.click()} style={{ flex:1, background:color, color:"white", border:"none", padding:compact?"6px":"10px", borderRadius:6, fontSize:compact?11:13, fontWeight:700, cursor:"pointer" }}>📁 Upload</button>
            <input ref={fileRef} type="file" accept="audio/*,.ogg,.mp3,.wav,.m4a,.webm" onChange={handleFile} style={{ display:"none" }} />
          </div>
          <textarea placeholder="Or paste transcript here and click outside..." onBlur={e => { if (e.target.value.trim()) { setTranscript(e.target.value.trim()); setMode("done"); } }}
            style={{ width:"100%", minHeight:compact?30:44, marginTop:6, padding:6, border:"1px solid #e2e8f0", borderRadius:4, fontSize:12, fontFamily:"inherit", resize:"vertical", boxSizing:"border-box", color:"#64748b" }} />
        </>
      )}
      {mode==="recording" && (
        <div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
            <div style={{ fontSize:18, fontWeight:800, color:"#dc2626" }}><span style={{ display:"inline-block", width:8, height:8, borderRadius:"50%", background:"#dc2626", marginRight:6, animation:"pulse 1s infinite" }} />{fmt(duration)}</div>
            <button onClick={stopRec} style={{ background:"#1e293b", color:"white", border:"none", padding:"6px 20px", borderRadius:6, fontSize:12, fontWeight:700, cursor:"pointer" }}>⏹ Stop</button>
          </div>
          {/* Live transcript */}
          {liveText && <div style={{ background:"#fff", border:"1px solid #fecaca", borderRadius:4, padding:8, fontSize:13, lineHeight:1.6, color:"#374151", minHeight:40, maxHeight:150, overflow:"auto" }}>
            {liveText}<span style={{ display:"inline-block", width:2, height:14, background:"#dc2626", marginLeft:2, animation:"pulse 0.5s infinite" }} />
          </div>}
          {!liveText && <div style={{ fontSize:11, color:"#94a3b8", textAlign:"center", padding:6 }}>🎙️ Listening... speak now</div>}
        </div>
      )}
      {mode==="cleaning" && (
        <div style={{ textAlign:"center", padding:10 }}>
          <div style={{ fontSize:14, animation:"pulse 1s infinite" }}>✨</div>
          <div style={{ fontSize:11, color:"#92400e", fontWeight:600 }}>Fixing medical terms...</div>
        </div>
      )}
      {mode==="recorded" && (
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
            <audio src={audioUrl} controls style={{ flex:1, height:30 }} />
            <button onClick={reset} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"3px 6px", borderRadius:3, fontSize:10, cursor:"pointer" }}>✕</button>
          </div>
          <button onClick={transcribe} style={{ width:"100%", background:color, color:"white", border:"none", padding:"8px", borderRadius:6, fontSize:12, fontWeight:700, cursor:"pointer" }}>🔊 Transcribe</button>
        </div>
      )}
      {mode==="transcribing" && <div style={{ textAlign:"center", padding:10 }}><div style={{ fontSize:18, animation:"pulse 1s infinite" }}>🔊</div><div style={{ fontSize:11, color:"#475569" }}>Transcribing...</div></div>}
      {mode==="done" && (
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:4, marginBottom:3 }}>
            <span style={{ color:"#059669", fontWeight:700, fontSize:11 }}>✅ Ready</span>
            <button onClick={reset} style={{ marginLeft:"auto", background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"1px 5px", borderRadius:3, fontSize:9, cursor:"pointer" }}>Redo</button>
          </div>
          <textarea value={transcript} onChange={e => setTranscript(e.target.value)} ref={el => { if (el) { el.style.height = "auto"; el.style.height = Math.max(100, el.scrollHeight) + "px"; }}}
            style={{ width:"100%", minHeight:100, padding:8, border:"1px solid #e2e8f0", borderRadius:4, fontSize:13, fontFamily:"inherit", resize:"vertical", lineHeight:1.6, boxSizing:"border-box", overflow:"hidden" }} />
          <button onClick={() => { if (transcript) onTranscript(transcript); }} style={{ marginTop:3, width:"100%", background:"#059669", color:"white", border:"none", padding:"7px", borderRadius:6, fontSize:12, fontWeight:700, cursor:"pointer" }}>✅ Use This</button>
        </div>
      )}
      {error && <div style={{ marginTop:4, background:"#fef2f2", border:"1px solid #fecaca", borderRadius:4, padding:"3px 8px", fontSize:11, color:"#dc2626" }}>⚠️ {error}</div>}
    </div>
  );
}

// ============ HELPERS ============
const DC = { dm2:"#dc2626", htn:"#ea580c", cad:"#d97706", ckd:"#7c3aed", hypo:"#2563eb", obesity:"#92400e", dyslipidemia:"#0891b2" };
const FRIENDLY = { dm2:"Type 2 Diabetes (DM)", dm1:"Type 1 Diabetes (DM)", htn:"High Blood Pressure (Hypertension)", cad:"Heart Disease (CAD)", ckd:"Kidney Disease (CKD)", hypo:"Thyroid — Low (Hypothyroidism)", obesity:"Weight Management (Obesity)", dyslipidemia:"High Cholesterol (Dyslipidemia)", liver:"Fatty Liver (MASLD/NAFLD)", asthma:"Asthma", copd:"COPD", pcos:"PCOS", "overactive-bladder":"Overactive Bladder", "diabetic-neuropathy":"Diabetic Neuropathy", "diabetic-nephropathy":"Diabetic Nephropathy", "diabetic-retinopathy":"Diabetic Retinopathy", osas:"Sleep Apnea (OSAS)", gerd:"Acid Reflux (GERD)", ibs:"IBS", depression:"Depression", anxiety:"Anxiety", "subclinical-hypothyroidism":"Subclinical Hypothyroidism", "hashimotos":"Hashimoto's Thyroiditis" };
const Badge = ({ id, friendly }) => <span style={{ display:"inline-block", fontSize:9, fontWeight:700, background:(DC[id]||"#64748b")+"18", color:DC[id]||"#64748b", border:`1px solid ${(DC[id]||"#64748b")}35`, borderRadius:10, padding:"1px 5px", marginRight:2 }}>{friendly?(FRIENDLY[id]||id):id?.toUpperCase()}</span>;
const Err = ({ msg, onDismiss }) => msg ? <div style={{ marginTop:4, background:"#fef2f2", border:"1px solid #fecaca", borderRadius:6, padding:"6px 10px", fontSize:12, color:"#dc2626" }}>❌ {msg} <button onClick={onDismiss} style={{ marginLeft:6, background:"#dc2626", color:"white", border:"none", padding:"2px 8px", borderRadius:4, fontSize:11, cursor:"pointer" }}>Dismiss</button></div> : null;
const Section = ({ title, color, children }) => <div style={{ marginBottom:14 }}><div style={{ fontSize:12, fontWeight:800, color, borderBottom:`2px solid ${color}`, paddingBottom:3, marginBottom:6 }}>{title}</div>{children}</div>;

// Plan block with hide/show toggle (buttons hidden on print)
const PlanBlock = ({ id, title, color, hidden, onToggle, children }) => {
  if (hidden) return (
    <div className="no-print" style={{ marginBottom:4, opacity:.4, display:"flex", alignItems:"center", gap:4, cursor:"pointer" }} onClick={onToggle}>
      <span style={{ fontSize:9, color:"#94a3b8" }}>➕</span>
      <span style={{ fontSize:10, color:"#94a3b8", textDecoration:"line-through" }}>{title}</span>
    </div>
  );
  return (
    <div style={{ marginBottom:14, position:"relative" }}>
      <div style={{ display:"flex", alignItems:"center", gap:4, borderBottom:`2px solid ${color}`, paddingBottom:3, marginBottom:6 }}>
        <div style={{ fontSize:12, fontWeight:800, color, flex:1 }}>{title}</div>
        <button className="no-print" onClick={onToggle} title="Hide this section" style={{ background:"#fee2e2", border:"none", borderRadius:3, padding:"1px 5px", fontSize:9, cursor:"pointer", color:"#dc2626", fontWeight:700 }}>✕</button>
      </div>
      {children}
    </div>
  );
};

// Editable text span (click to edit, hidden controls on print)
const EditText = ({ value, onChange, style: s }) => {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  useEffect(() => setVal(value), [value]);
  if (editing) return <input value={val} onChange={e=>setVal(e.target.value)} onBlur={()=>{onChange(val);setEditing(false);}} onKeyDown={e=>{if(e.key==="Enter"){onChange(val);setEditing(false);}}} autoFocus
    style={{ ...s, border:"1px solid #3b82f6", borderRadius:3, padding:"1px 4px", outline:"none", background:"#eff6ff", width:"100%", boxSizing:"border-box" }} />;
  return <span onClick={()=>setEditing(true)} style={{ ...s, cursor:"pointer", borderBottom:"1px dashed transparent" }} className="editable-hover">{value}</span>;
};

// Remove button for list items
const RemoveBtn = ({ onClick }) => <button className="no-print" onClick={onClick} title="Remove" style={{ background:"#fee2e2", border:"none", borderRadius:3, padding:"0 4px", fontSize:9, cursor:"pointer", color:"#dc2626", fontWeight:700, lineHeight:"16px" }}>✕</button>;
// Safe array accessor
const sa = (obj, key) => (obj && Array.isArray(obj[key])) ? obj[key] : [];

// ============ MAIN ============
export default function GiniScribe() {
  const [tab, setTab] = useState("setup");
  const [dgKey, setDgKey] = useState("");
  const [whisperKey, setWhisperKey] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [moName, setMoName] = useState("Dr. Beant");
  const [conName, setConName] = useState("Dr. Bhansali");
  const [patient, setPatient] = useState({ name:"", phone:"", dob:"", fileNo:"", age:"", sex:"Male", abhaId:"", aadhaar:"", healthId:"", govtId:"", govtIdType:"" });
  const [vitals, setVitals] = useState({ bp_sys:"", bp_dia:"", pulse:"", temp:"", spo2:"", weight:"", height:"", bmi:"", waist:"", body_fat:"", muscle_mass:"" });
  const [labData, setLabData] = useState(null);
  const [labImageData, setLabImageData] = useState(null);
  const [labMismatch, setLabMismatch] = useState(null);
  const [moTranscript, setMoTranscript] = useState("");
  const [conTranscript, setConTranscript] = useState("");
  const [moData, setMoData] = useState(null);
  const [conData, setConData] = useState(null);
  const [planHidden, setPlanHidden] = useState(new Set());
  const [planEdits, setPlanEdits] = useState({});
  const [clarifications, setClarifications] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [quickTranscript, setQuickTranscript] = useState("");
  const [quickMode, setQuickMode] = useState(false);
  const [savedPatients, setSavedPatients] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [dbPatientId, setDbPatientId] = useState(null); // DB id of current patient
  // History entry form
  const emptyHistory = { visit_date:"", visit_type:"OPD", doctor_name:"", specialty:"", vitals:{bp_sys:"",bp_dia:"",weight:"",height:""},
    diagnoses:[{id:"",label:"",status:"New"}], medications:[{name:"",dose:"",frequency:"",timing:""}],
    labs:[{test_name:"",result:"",unit:"",flag:"",ref_range:""}] };
  const [historyForm, setHistoryForm] = useState({...emptyHistory});
  const [historyList, setHistoryList] = useState([]);
  const [historySaving, setHistorySaving] = useState(false);
  const [rxText, setRxText] = useState("");
  const [rxExtracting, setRxExtracting] = useState(false);
  const [rxExtracted, setRxExtracted] = useState(false);
  const [reports, setReports] = useState([]); // {type, file, base64, mediaType, extracted, extracting}
  const [hxMode, setHxMode] = useState("rx"); // "rx" | "report" | "manual"
  // Outcomes data
  const [outcomesData, setOutcomesData] = useState(null);
  const [outcomesLoading, setOutcomesLoading] = useState(false);
  const [outcomePeriod, setOutcomePeriod] = useState("all");
  const [expandedBiomarker, setExpandedBiomarker] = useState(null);
  const [timelineFilter, setTimelineFilter] = useState("All");
  const [timelineDoctor, setTimelineDoctor] = useState("");
  const [expandedDiagnosis, setExpandedDiagnosis] = useState(null);
  const [patientFullData, setPatientFullData] = useState(null);
  // Imaging uploads
  const [imagingFiles, setImagingFiles] = useState([]); // [{type, base64, mediaType, fileName, data, extracting, error}]
  const imagingRef = useRef(null);
  // AI Chat
  const [aiMessages, setAiMessages] = useState([]);
  const [aiInput, setAiInput] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const aiChatRef = useRef(null);
  // Auth
  const [authToken, setAuthToken] = useState(() => localStorage.getItem("gini_auth_token") || "");
  const [currentDoctor, setCurrentDoctor] = useState(() => { try { return JSON.parse(localStorage.getItem("gini_doctor")||"null"); } catch { return null; }});
  const [doctorsList, setDoctorsList] = useState([]);
  const [loginPin, setLoginPin] = useState("");
  const [loginDoctorId, setLoginDoctorId] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  // Auto-save draft
  const [draftSaved, setDraftSaved] = useState("");

  // Auth helper: headers with token
  const authHeaders = (extra = {}) => ({
    "Content-Type": "application/json",
    ...(authToken ? { "x-auth-token": authToken } : {}),
    ...extra
  });

  // Fetch doctors list on mount
  useEffect(() => {
    if (API_URL) fetch(`${API_URL}/api/doctors`).then(r=>r.json()).then(setDoctorsList).catch(()=>{});
  }, []);

  // Verify auth session on mount
  useEffect(() => {
    if (authToken && API_URL) {
      fetch(`${API_URL}/api/auth/me`, { headers: { "x-auth-token": authToken }})
        .then(r=>r.json())
        .then(data => {
          if (!data.authenticated) { setAuthToken(""); setCurrentDoctor(null); localStorage.removeItem("gini_auth_token"); localStorage.removeItem("gini_doctor"); }
        }).catch(()=>{});
    }
  }, []);

  // Login handler
  const handleLogin = async () => {
    if (!loginDoctorId || !loginPin) { setLoginError("Select doctor and enter PIN"); return; }
    setLoginLoading(true); setLoginError("");
    try {
      const resp = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doctor_id: parseInt(loginDoctorId), pin: loginPin })
      });
      const data = await resp.json();
      if (resp.ok && data.token) {
        setAuthToken(data.token);
        setCurrentDoctor(data.doctor);
        localStorage.setItem("gini_auth_token", data.token);
        localStorage.setItem("gini_doctor", JSON.stringify(data.doctor));
        // Auto-set names based on role
        if (data.doctor.role === "mo") setMoName(data.doctor.short_name);
        else setConName(data.doctor.short_name);
      } else {
        setLoginError(data.error || "Login failed");
      }
    } catch (e) { setLoginError("Connection error"); }
    setLoginLoading(false); setLoginPin("");
  };

  // Logout handler
  const handleLogout = () => {
    if (authToken) fetch(`${API_URL}/api/auth/logout`, { method:"POST", headers:{"x-auth-token":authToken}}).catch(()=>{});
    setAuthToken(""); setCurrentDoctor(null);
    localStorage.removeItem("gini_auth_token"); localStorage.removeItem("gini_doctor");
  };

  // Auto-save draft every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      if (patient.name && (moData || conData || quickTranscript)) {
        try {
          const draft = { patient, vitals, moData, conData, moTranscript, conTranscript, quickTranscript, moName, conName, timestamp: Date.now() };
          localStorage.setItem("gini_draft", JSON.stringify(draft));
          setDraftSaved("💾 " + new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}));
        } catch {}
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [patient, vitals, moData, conData, moTranscript, conTranscript, quickTranscript, moName, conName]);

  // Recover draft on mount
  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem("gini_draft"));
      if (draft && draft.timestamp > Date.now() - 3600000) { // within 1 hour
        setDraftSaved("📋 Draft available from " + new Date(draft.timestamp).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}));
      }
    } catch {}
  }, []);

  // localStorage: load saved patients
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("gini_patients") || "[]");
      setSavedPatients(saved);
    } catch {}
  }, []);

  // Save current consultation to database + localStorage
  const saveConsultation = async () => {
    if (!patient.name) return;
    setSaveStatus("💾 Saving...");
    const record = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      patient: { ...patient },
      vitals: { ...vitals },
      labData, moData, conData,
      moTranscript, conTranscript, quickTranscript,
      moName, conName
    };
    // Save to localStorage as fallback
    const existing = JSON.parse(localStorage.getItem("gini_patients") || "[]");
    existing.unshift(record);
    localStorage.setItem("gini_patients", JSON.stringify(existing.slice(0, 500)));
    setSavedPatients(existing);

    // Save to database if API is configured
    if (API_URL) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        setSaveStatus("💾 Saving to DB...");
        const resp = await fetch(`${API_URL}/api/consultations`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            patient, vitals, moData, conData,
            moTranscript, conTranscript, quickTranscript,
            moName, conName, planEdits,
            moDoctorId: doctorsList.find(d=>d.short_name===moName)?.id || null,
            conDoctorId: doctorsList.find(d=>d.short_name===conName)?.id || null
          }),
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          console.error("DB save HTTP error:", resp.status, errText);
          setSaveStatus("⚠️ Local only — Server " + resp.status);
        } else {
          const result = await resp.json();
          if (result.success) {
            setSaveStatus(`✅ Saved (DB #${result.consultation_id})`);
            setDbPatientId(result.patient_id);
            // Auto-save prescription as retrievable document
            if (conData && result.patient_id) {
              const rxDoc = {
                doc_type: "prescription",
                title: `Prescription — ${conName} — ${new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})}`,
                file_name: `rx_${result.consultation_id}.json`,
                extracted_data: {
                  patient: { name: patient.name, age: patient.age, sex: patient.sex, phone: patient.phone, fileNo: patient.fileNo },
                  doctor: conName, mo: moName,
                  date: new Date().toISOString(),
                  diagnoses: moData?.diagnoses || [],
                  medications: conData.medications_confirmed || [],
                  diet_lifestyle: conData.diet_lifestyle || [],
                  investigations_ordered: conData.investigations_ordered || [],
                  follow_up: conData.follow_up || {},
                  vitals: { ...vitals },
                  chief_complaints: moData?.chief_complaints || [],
                  assessment_summary: conData.assessment_summary || "",
                  goals: conData.goals || [],
                  plan_edits: planEdits
                },
                doc_date: new Date().toISOString().split("T")[0],
                source: "scribe",
                notes: `Consultation by ${conName}`,
                consultation_id: result.consultation_id
              };
              fetch(`${API_URL}/api/patients/${result.patient_id}/documents`, {
                method: "POST", headers: authHeaders(),
                body: JSON.stringify(rxDoc)
              }).catch(e => console.log("Rx doc save:", e.message));
            }
            // Save any imaging reports that were uploaded
            for (const img of imagingFiles.filter(f => f.data)) {
              if (result.patient_id) {
                fetch(`${API_URL}/api/patients/${result.patient_id}/documents`, {
                  method: "POST", headers: authHeaders(),
                  body: JSON.stringify({
                    doc_type: img.data.report_type || img.type,
                    title: `${img.data.report_type || img.type} — ${img.fileName}`,
                    file_name: img.fileName,
                    extracted_data: img.data,
                    doc_date: img.data.date || new Date().toISOString().split("T")[0],
                    source: "upload",
                    notes: img.data.impression,
                    consultation_id: result.consultation_id
                  })
                }).catch(e => console.log("Imaging doc save:", e.message));
              }
            }
          } else {
            setSaveStatus("⚠️ Local only — " + (result.error || "failed").slice(0, 40));
          }
        }
      } catch (e) {
        console.error("DB save error:", e);
        setSaveStatus(e.name === "AbortError" ? "⚠️ Local only — timeout" : "⚠️ Local only — " + e.message.slice(0, 30));
      }
    } else {
      setSaveStatus("✅ Saved locally");
    }
    setTimeout(() => setSaveStatus(""), 4000);
  };

  // Load a previous patient record
  const loadPatient = async (record) => {
    const p = record.patient || {};
    setPatient(p);
    setVitals(record.vitals || {});
    if (record.moData) setMoData(record.moData);
    if (record.conData) setConData(record.conData);
    if (record.moTranscript) setMoTranscript(record.moTranscript);
    if (record.conTranscript) setConTranscript(record.conTranscript);
    setShowSearch(false);
    setTab("patient");
    // Try to find this patient in the DB by name or phone
    if (API_URL && (p.name || p.phone)) {
      try {
        const q = p.phone || p.name;
        const resp = await fetch(`${API_URL}/api/patients?q=${encodeURIComponent(q)}`);
        const results = await resp.json();
        if (results.length > 0) {
          const match = results.find(r => r.name === p.name || r.phone === p.phone) || results[0];
          setDbPatientId(match.id);
          // Load full data for outcomes
          const fullResp = await fetch(`${API_URL}/api/patients/${match.id}`);
          const full = await fullResp.json();
          setPatientFullData(full);
          setHistoryList(full.consultations || []);
          fetchOutcomes(match.id);
        }
      } catch {}
    }
  };

  // Search patients — DB first, localStorage fallback
  const [dbPatients, setDbPatients] = useState([]);
  const searchPatientsDB = async (q) => {
    if (!API_URL) { setDbPatients([]); return; }
    if (!q || q.length < 2) {
      // Show recent patients when no query
      try {
        const resp = await fetch(`${API_URL}/api/patients?limit=10`);
        const data = await resp.json();
        setDbPatients(Array.isArray(data) ? data : []);
      } catch { setDbPatients([]); }
      return;
    }
    try {
      const resp = await fetch(`${API_URL}/api/patients?q=${encodeURIComponent(q)}`);
      const data = await resp.json();
      setDbPatients(Array.isArray(data) ? data : []);
    } catch { setDbPatients([]); }
  };

  // Load patient from DB with full history
  const loadPatientDB = async (dbRecord) => {
    setPatient({
      name: dbRecord.name || "", phone: dbRecord.phone || "", age: dbRecord.age || "",
      sex: dbRecord.sex || "Male", fileNo: dbRecord.file_no || "", dob: dbRecord.dob || "",
      abhaId: dbRecord.abha_id || "", healthId: dbRecord.health_id || "",
      aadhaar: dbRecord.aadhaar || "", govtId: dbRecord.govt_id || "", govtIdType: dbRecord.govt_id_type || ""
    });
    setDbPatientId(dbRecord.id);
    // Load full patient record
    if (API_URL && dbRecord.id) {
      try {
        const resp = await fetch(`${API_URL}/api/patients/${dbRecord.id}`);
        const full = await resp.json();
        setPatientFullData(full);
        setHistoryList(full.consultations || []);
        if (full.consultations?.length > 0) {
          const latest = full.consultations[0];
          const conResp = await fetch(`${API_URL}/api/consultations/${latest.id}`);
          const conDetail = await conResp.json();
          if (conDetail.mo_data) setMoData(conDetail.mo_data);
          if (conDetail.con_data) setConData(conDetail.con_data);
          if (conDetail.mo_transcript) setMoTranscript(conDetail.mo_transcript);
          if (conDetail.con_transcript) setConTranscript(conDetail.con_transcript);
        }
        if (full.vitals?.length > 0) {
          const v = full.vitals[0];
          setVitals(prev => ({
            ...prev,
            bp_sys: v.bp_sys || "", bp_dia: v.bp_dia || "", pulse: v.pulse || "",
            spo2: v.spo2 || "", weight: v.weight || "", height: v.height || "", bmi: v.bmi || ""
          }));
        }
        // Load outcomes
        fetchOutcomes(dbRecord.id);
      } catch {}
    }
    setShowSearch(false);
    setTab("patient");
  };

  const filteredPatients = savedPatients.filter(r => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (r.patient?.name||"").toLowerCase().includes(q) ||
           (r.patient?.phone||"").includes(q) ||
           (r.patient?.fileNo||"").toLowerCase().includes(q) ||
           (r.patient?.abhaId||"").includes(q);
  });
  const labRef = useRef(null);
  const clearErr = id => setErrors(p => ({ ...p, [id]: null }));
  
  const newPatient = () => {
    setPatient({ name:"", phone:"", dob:"", fileNo:"", age:"", sex:"Male", abhaId:"", aadhaar:"", healthId:"", govtId:"", govtIdType:"" });
    setVitals({ bp_sys:"", bp_dia:"", pulse:"", temp:"", spo2:"", weight:"", height:"", bmi:"", waist:"", body_fat:"", muscle_mass:"" });
    setLabData(null); setLabImageData(null); setLabMismatch(null);
    setMoTranscript(""); setConTranscript(""); setQuickTranscript("");
    setMoData(null); setConData(null);
    setClarifications({}); setErrors({});
    setPlanHidden(new Set()); setPlanEdits({});
    setTab("patient");
  };

  // Auto-detect keys from env vars
  useEffect(() => {
    try {
      const dg = import.meta.env?.VITE_DEEPGRAM_KEY;
      const wh = import.meta.env?.VITE_OPENAI_KEY;
      if (dg && dg.length > 10) setDgKey(dg);
      if (wh && wh.length > 10) setWhisperKey(wh);
      if ((dg && dg.length > 10) || (wh && wh.length > 10)) { setKeySet(true); setTab("patient"); }
    } catch {}
  }, []);

  const updatePatient = (k, v) => {
    setPatient(p => { const u = { ...p, [k]: v }; if (k==="dob"&&v) { const a=Math.floor((Date.now()-new Date(v).getTime())/31557600000); u.age=a>0?String(a):""; } return u; });
  };

  const voiceFillPatient = async (t) => {
    setLoading(p=>({...p,pv:true})); clearErr("pv");
    const {data,error} = await callClaude(PATIENT_VOICE_PROMPT, t);
    if (error) setErrors(p=>({...p,pv:error}));
    else if (data) setPatient(prev => ({ name:data.name||prev.name, phone:data.phone||prev.phone, dob:data.dob||prev.dob, fileNo:data.fileNo||prev.fileNo, age:data.age?String(data.age):prev.age, sex:data.sex||prev.sex }));
    setLoading(p=>({...p,pv:false}));
  };

  const updateVital = (k, v) => {
    setVitals(prev => { const u={...prev,[k]:v}; if ((k==="weight"||k==="height")&&u.weight&&u.height) { const h=parseFloat(u.height)/100; u.bmi=h>0?(parseFloat(u.weight)/(h*h)).toFixed(1):""; } return u; });
  };

  const voiceFillVitals = async (t) => {
    setLoading(p=>({...p,vv:true})); clearErr("vv");
    const {data,error} = await callClaude(VITALS_VOICE_PROMPT, t);
    if (error) setErrors(p=>({...p,vv:error}));
    else if (data) {
      setVitals(prev => {
        const u={...prev};
        if(data.bp_sys)u.bp_sys=String(data.bp_sys); if(data.bp_dia)u.bp_dia=String(data.bp_dia);
        if(data.pulse)u.pulse=String(data.pulse); if(data.temp)u.temp=String(data.temp);
        if(data.spo2)u.spo2=String(data.spo2); if(data.weight)u.weight=String(data.weight);
        if(data.height)u.height=String(data.height);
        if(u.weight&&u.height){const h=parseFloat(u.height)/100; u.bmi=h>0?(parseFloat(u.weight)/(h*h)).toFixed(1):"";}
        return u;
      });
    }
    setLoading(p=>({...p,vv:false}));
  };

  const handleLabUpload = e => {
    const f=e.target.files[0]; if(!f) return;
    const reader=new FileReader();
    reader.onload=ev => setLabImageData({ base64:ev.target.result.split(",")[1], mediaType:f.type.startsWith("image/")?f.type:"application/pdf", fileName:f.name });
    reader.readAsDataURL(f);
  };

  const processLab = async () => {
    if(!labImageData) return;
    setLoading(p=>({...p,lab:true})); clearErr("lab");
    const {data,error} = await extractLab(labImageData.base64, labImageData.mediaType);
    if(error) setErrors(p=>({...p,lab:error}));
    else {
      setLabData(data);
      if(data?.patient_on_report?.name && patient.name) {
        const rn=data.patient_on_report.name.toLowerCase(), pn=patient.name.toLowerCase();
        if(rn&&pn&&!rn.includes(pn.split(" ")[0])&&!pn.includes(rn.split(" ")[0]))
          setLabMismatch(`Report: "${data.patient_on_report.name}" ≠ "${patient.name}"`);
        else setLabMismatch(null);
      }
    }
    setLoading(p=>({...p,lab:false}));
  };

  // Imaging upload handler
  const handleImagingUpload = (e, reportType) => {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const newFile = {
        id: Date.now(),
        type: reportType || "Unknown",
        base64: ev.target.result.split(",")[1],
        mediaType: f.type.startsWith("image/") ? f.type : "application/pdf",
        fileName: f.name,
        data: null,
        extracting: false,
        error: null
      };
      setImagingFiles(prev => [...prev, newFile]);
    };
    reader.readAsDataURL(f);
  };

  // Extract imaging findings
  const processImaging = async (fileId) => {
    setImagingFiles(prev => prev.map(f => f.id === fileId ? { ...f, extracting: true, error: null } : f));
    const file = imagingFiles.find(f => f.id === fileId);
    if (!file) return;
    const { data, error } = await extractImaging(file.base64, file.mediaType);
    setImagingFiles(prev => prev.map(f => f.id === fileId ? { ...f, extracting: false, data, error } : f));
    // Auto-save to DB if patient loaded
    if (data && dbPatientId && API_URL) {
      try {
        await fetch(`${API_URL}/api/patients/${dbPatientId}/documents`, {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            doc_type: data.report_type || file.type,
            title: `${data.report_type || file.type} — ${file.fileName}`,
            file_name: file.fileName,
            extracted_data: data,
            doc_date: data.date || new Date().toISOString().split("T")[0],
            source: "upload",
            notes: data.impression
          })
        });
      } catch (e) { console.log("Doc save failed:", e.message); }
    }
  };

  // Remove imaging file
  const removeImaging = (fileId) => setImagingFiles(prev => prev.filter(f => f.id !== fileId));

  // AI Chat send message
  const sendAiMessage = async () => {
    if (!aiInput.trim() || aiLoading) return;
    const userMsg = aiInput.trim();
    setAiInput("");
    const newMessages = [...aiMessages, { role: "user", content: userMsg }];
    setAiMessages(newMessages);
    setAiLoading(true);
    // Build patient context
    let ctx = "";
    if (patient.name) ctx += `Patient: ${patient.name}, ${patient.age}Y/${patient.sex}\n`;
    if (moData?.diagnoses?.length) ctx += `Diagnoses: ${moData.diagnoses.map(d=>`${d.label} (${d.status})`).join(", ")}\n`;
    if (conData?.medications_confirmed?.length) ctx += `Current Meds: ${conData.medications_confirmed.map(m=>`${m.name} ${m.dose} ${m.frequency}`).join(", ")}\n`;
    if (moData?.investigations?.length) ctx += `Recent Labs: ${moData.investigations.map(i=>`${i.test}: ${i.value} ${i.unit||""} ${i.flag||""}`).join(", ")}\n`;
    if (vitals.bp_sys) ctx += `Vitals: BP ${vitals.bp_sys}/${vitals.bp_dia}, Pulse ${vitals.pulse}, SpO2 ${vitals.spo2}%, Wt ${vitals.weight}kg, BMI ${vitals.bmi}\n`;
    if (moData?.chief_complaints?.length) ctx += `Chief Complaints: ${moData.chief_complaints.join(", ")}\n`;
    if (moData?.complications?.length) ctx += `Complications: ${moData.complications.map(c=>`${c.name}: ${c.status}`).join(", ")}\n`;
    if (moData?.history?.medical?.length) ctx += `Medical History: ${moData.history.medical.join(", ")}\n`;
    if (imagingFiles.filter(f=>f.data).length) ctx += `Imaging: ${imagingFiles.filter(f=>f.data).map(f=>`${f.data.report_type}: ${f.data.impression}`).join("; ")}\n`;
    // Include outcomes data if available
    if (patientFullData) {
      if (patientFullData.diagnoses?.length) ctx += `All Diagnoses: ${patientFullData.diagnoses.map(d=>`${d.label}:${d.status}`).join(", ")}\n`;
      if (patientFullData.medications?.length) ctx += `All Meds (active): ${patientFullData.medications.filter(m=>m.is_active).map(m=>`${m.name} ${m.dose||""}`).join(", ")}\n`;
    }
    const apiMessages = newMessages.map(m => ({ role: m.role, content: m.content }));
    const { text, error } = await aiChat(apiMessages, ctx);
    if (error) setAiMessages(prev => [...prev, { role: "assistant", content: `❌ Error: ${error}` }]);
    else setAiMessages(prev => [...prev, { role: "assistant", content: text }]);
    setAiLoading(false);
    setTimeout(() => aiChatRef.current?.scrollTo(0, aiChatRef.current.scrollHeight), 100);
  };

  const processMO = async () => {
    if(!moTranscript) return;
    setLoading(p=>({...p,mo:true})); clearErr("mo");
    let extra="";
    if(labData?.panels) {
      const tests=labData.panels.flatMap(p=>p.tests.map(t=>`${t.test_name}: ${t.result_text||t.result} ${t.unit||""} ${t.flag==="H"?"[HIGH]":t.flag==="L"?"[LOW]":""}`));
      extra=`\n\nLAB RESULTS:\n${tests.join("\n")}`;
    }
    if(vitals.bp_sys) extra+=`\nVITALS: BP ${vitals.bp_sys}/${vitals.bp_dia}, Pulse ${vitals.pulse}, SpO2 ${vitals.spo2}%, Wt ${vitals.weight}kg, BMI ${vitals.bmi}`;
    // Add imaging findings context
    const extractedImaging = imagingFiles.filter(f=>f.data);
    if (extractedImaging.length > 0) {
      extra += `\n\nIMAGING REPORTS:\n${extractedImaging.map(f=>`${f.data.report_type}: ${f.data.impression || ""} ${(f.data.findings||[]).map(fi=>`${fi.parameter}=${fi.value}${fi.unit||""} (${fi.interpretation})`).join(", ")}`).join("\n")}`;
    }
    const {data,error} = await callClaude(MO_PROMPT, moTranscript+extra);
    if(error) setErrors(p=>({...p,mo:error}));
    else if(data) setMoData(fixMoMedicines(data));
    else setErrors(p=>({...p,mo:"No data returned"}));
    setLoading(p=>({...p,mo:false}));
  };

  const processConsultant = async () => {
    if(!conTranscript) return;
    setLoading(p=>({...p,con:true})); clearErr("con");
    // Include MO context so consultant can reference existing data
    let context = conTranscript;
    if (moData) {
      const diagList = sa(moData,"diagnoses").map(d=>d.label).join(", ");
      const medList = sa(moData,"previous_medications").map(m=>`${m.name} ${m.dose}`).join(", ");
      const invList = sa(moData,"investigations").map(i=>`${i.test}: ${i.value}${i.unit}`).join(", ");
      context += `\n\nPATIENT CONTEXT FROM MO:\nDiagnoses: ${diagList}\nPrevious Meds: ${medList}\nInvestigations: ${invList}`;
      if(vitals.bp_sys) context += `\nVitals: BP ${vitals.bp_sys}/${vitals.bp_dia}, Wt ${vitals.weight}kg, BMI ${vitals.bmi}`;
      // Add imaging findings
      const extractedImaging = imagingFiles.filter(f=>f.data);
      if (extractedImaging.length > 0) {
        context += `\nImaging: ${extractedImaging.map(f=>`${f.data.report_type}: ${f.data.impression || (f.data.findings||[]).map(fi=>`${fi.parameter}=${fi.value}`).join(", ")}`).join("; ")}`;
      }
    }
    const {data,error} = await callClaude(CONSULTANT_PROMPT, context);
    if(error) setErrors(p=>({...p,con:error}));
    else if(data) setConData(fixConMedicines(data));
    else setErrors(p=>({...p,con:"No data returned"}));
    setLoading(p=>({...p,con:false}));
  };

  const handleClarification = (i,k,v) => setClarifications(p=>({...p,[i]:{...(p[i]||{}),[k]:v}}));

  const allMeds = [
    ...(sa(conData,"medications_confirmed").length > 0
      ? sa(conData,"medications_confirmed")
      : sa(moData,"previous_medications").map(m => ({...m, isNew:false, route:m.route||"Oral"}))),
    ...sa(conData,"medications_needs_clarification").map((m,i) => {
      const c=clarifications[i]||{};
      return c.resolved_name ? {...m, name:c.resolved_name, dose:c.resolved_dose||m.default_dose||"", frequency:c.resolved_freq||"OD", timing:c.resolved_timing||m.default_timing||"", resolved:true, isNew:true} : null;
    }).filter(Boolean)
  ];

  // Plan editing helpers
  const toggleBlock = (id) => setPlanHidden(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const editPlan = (key, val) => setPlanEdits(p => ({ ...p, [key]: val }));
  const getPlan = (key, fallback) => planEdits[key] !== undefined ? planEdits[key] : fallback;
  const removeMed = (idx) => setPlanEdits(p => ({ ...p, _removedMeds: [...(p._removedMeds||[]), idx] }));
  const removeDiag = (idx) => setPlanEdits(p => ({ ...p, _removedDiags: [...(p._removedDiags||[]), idx] }));
  const removeLifestyle = (idx) => setPlanEdits(p => ({ ...p, _removedLifestyle: [...(p._removedLifestyle||[]), idx] }));
  const removeGoal = (idx) => setPlanEdits(p => ({ ...p, _removedGoals: [...(p._removedGoals||[]), idx] }));
  const removeMonitor = (idx) => setPlanEdits(p => ({ ...p, _removedMonitors: [...(p._removedMonitors||[]), idx] }));
  const removeFuture = (idx) => setPlanEdits(p => ({ ...p, _removedFuture: [...(p._removedFuture||[]), idx] }));
  const resetPlanEdits = () => { setPlanHidden(new Set()); setPlanEdits({}); };

  // Filtered data for plan
  const planDiags = sa(moData,"diagnoses").filter((_,i) => !(planEdits._removedDiags||[]).includes(i));
  const planMeds = allMeds.filter((_,i) => !(planEdits._removedMeds||[]).includes(i));
  const planLifestyle = sa(conData,"diet_lifestyle").filter((_,i) => !(planEdits._removedLifestyle||[]).includes(i));
  const planGoals = sa(conData,"goals").filter((_,i) => !(planEdits._removedGoals||[]).includes(i));
  const planMonitors = sa(conData,"self_monitoring").filter((_,i) => !(planEdits._removedMonitors||[]).includes(i));
  const planFuture = sa(conData,"future_plan").filter((_,i) => !(planEdits._removedFuture||[]).includes(i));

  // ============ HISTORY ENTRY ============
  const updateHistoryField = (path, value) => {
    setHistoryForm(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split(".");
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!isNaN(keys[i+1])) { obj = obj[keys[i]]; }
        else if (!isNaN(keys[i])) { obj = obj[parseInt(keys[i])]; }
        else { obj = obj[keys[i]]; }
      }
      const lastKey = keys[keys.length-1];
      if (!isNaN(lastKey)) obj[parseInt(lastKey)] = value;
      else obj[lastKey] = value;
      return next;
    });
  };
  const addHistoryRow = (section) => {
    setHistoryForm(prev => {
      const next = {...prev};
      if (section === "diagnoses") next.diagnoses = [...next.diagnoses, {id:"",label:"",status:"New"}];
      if (section === "medications") next.medications = [...next.medications, {name:"",dose:"",frequency:"",timing:""}];
      if (section === "labs") next.labs = [...next.labs, {test_name:"",result:"",unit:"",flag:"",ref_range:""}];
      return next;
    });
  };
  const removeHistoryRow = (section, idx) => {
    setHistoryForm(prev => {
      const next = {...prev};
      next[section] = next[section].filter((_,i) => i !== idx);
      return next;
    });
  };

  // Extract prescription text with Claude
  const extractPrescription = async () => {
    if (!rxText.trim()) return;
    setRxExtracting(true);
    try {
      const { data, error } = await callClaude(RX_EXTRACT_PROMPT, rxText);
      if (data && !error) {
        setHistoryForm(prev => ({
          ...prev,
          visit_date: data.visit_date || prev.visit_date,
          doctor_name: data.doctor_name || prev.doctor_name,
          specialty: data.specialty || prev.specialty,
          vitals: { ...prev.vitals, ...(data.vitals || {}) },
          diagnoses: (data.diagnoses?.length > 0) ? data.diagnoses : prev.diagnoses,
          medications: (data.medications?.length > 0) ? data.medications : prev.medications,
        }));
        setRxExtracted(true);
      }
    } catch (e) { console.error("Rx extract error:", e); }
    setRxExtracting(false);
  };

  // Handle report file upload
  const handleReportFile = (e, reportType) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      const mediaType = file.type || "image/jpeg";
      setReports(prev => [...prev, { type: reportType, fileName: file.name, base64, mediaType, extracted: null, extracting: false, error: null }]);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // Extract report with Claude
  const extractReport = async (index) => {
    const report = reports[index];
    if (!report) return;
    setReports(prev => prev.map((r,i) => i===index ? {...r, extracting:true, error:null} : r));
    try {
      const block = report.mediaType === "application/pdf"
        ? { type:"document", source:{type:"base64",media_type:"application/pdf",data:report.base64} }
        : { type:"image", source:{type:"base64",media_type:report.mediaType,data:report.base64} };
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST", headers:{"Content-Type":"application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"},
        body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:8000,messages:[{role:"user",content:[block,{type:"text",text:REPORT_EXTRACT_PROMPT}]}]})
      });
      const d = await r.json();
      const t = (d.content||[]).map(c=>c.text||"").join("");
      let clean = t.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim();
      const parsed = JSON.parse(clean);
      // Add extracted labs to history form
      if (parsed.tests?.length > 0) {
        const newLabs = parsed.tests.map(t => ({
          test_name: t.test_name, result: t.result?.toString() || t.result_text || "",
          unit: t.unit || "", flag: t.flag || "", ref_range: t.ref_range || ""
        }));
        setHistoryForm(prev => ({
          ...prev,
          labs: [...prev.labs.filter(l => l.test_name), ...newLabs]
        }));
        if (parsed.report_date && !historyForm.visit_date) {
          setHistoryForm(prev => ({...prev, visit_date: parsed.report_date}));
        }
      }
      setReports(prev => prev.map((r,i) => i===index ? {...r, extracting:false, extracted:parsed} : r));
    } catch (e) {
      console.error("Report extract error:", e);
      setReports(prev => prev.map((r,i) => i===index ? {...r, extracting:false, error:e.message} : r));
    }
  };

  const removeReport = (index) => {
    setReports(prev => prev.filter((_,i) => i !== index));
  };

  const saveHistoryEntry = async () => {
    if (!dbPatientId || !historyForm.visit_date) return;
    setHistorySaving(true);
    try {
      const payload = {
        visit_date: historyForm.visit_date,
        visit_type: historyForm.visit_type,
        doctor_name: historyForm.doctor_name,
        specialty: historyForm.specialty,
        vitals: historyForm.vitals,
        diagnoses: historyForm.diagnoses.filter(d => d.label),
        medications: historyForm.medications.filter(m => m.name),
        labs: historyForm.labs.filter(l => l.test_name && l.result)
      };
      const resp = await fetch(`${API_URL}/api/patients/${dbPatientId}/history`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await resp.json();
      if (result.success) {
        setHistoryForm({...emptyHistory, diagnoses:[{id:"",label:"",status:"New"}], medications:[{name:"",dose:"",frequency:"",timing:""}], labs:[{test_name:"",result:"",unit:"",flag:"",ref_range:""}]});
        setRxText(""); setRxExtracted(false); setReports([]);
        // Refresh history list
        const pResp = await fetch(`${API_URL}/api/patients/${dbPatientId}`);
        const full = await pResp.json();
        setHistoryList(full.consultations || []);
        setPatientFullData(full);
        fetchOutcomes(dbPatientId);
      }
    } catch (e) { console.error("History save error:", e); }
    setHistorySaving(false);
  };

  // ============ OUTCOMES ============
  const fetchOutcomes = async (pid, period) => {
    if (!API_URL || !pid) return;
    setOutcomesLoading(true);
    try {
      const p = period || outcomePeriod;
      const url = p && p !== "all" ? `${API_URL}/api/patients/${pid}/outcomes?period=${p}` : `${API_URL}/api/patients/${pid}/outcomes`;
      const resp = await fetch(url);
      const data = await resp.json();
      setOutcomesData(data);
    } catch {}
    setOutcomesLoading(false);
  };

  const fmtDate = (d) => { try { const s=String(d); const dt=s.length===10?new Date(s+"T12:00:00"):new Date(s); return dt.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"2-digit"}); } catch { return ""; } };

  // Sparkline with hover tooltips and modern design
  const Sparkline = ({ data, width=200, height=55, color="#2563eb", label, unit, target, lowerBetter, valueKey }) => {
    const [hoverIdx, setHoverIdx] = useState(null);
    if (!data || data.length === 0) return (
      <div style={{ background:"white", borderRadius:12, padding:"10px 14px", border:"1px solid #f1f5f9", boxShadow:"0 1px 2px rgba(0,0,0,0.03)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ fontSize:11, fontWeight:600, color:"#cbd5e1" }}>{label}</div>
          <div style={{ fontSize:10, color:"#cbd5e1" }}>No data</div>
        </div>
      </div>
    );
    const vk = valueKey || "result";
    const values = data.map(d => parseFloat(d[vk] || d.result || d.bp_sys || d.weight || d.waist || d.body_fat || d.muscle_mass || 0));
    const dates = data.map(d => d.test_date || d.date);
    const min = Math.min(...values) * 0.92;
    const max = Math.max(...values) * 1.08;
    const range = max - min || 1;
    const points = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * width},${height - ((v - min) / range) * height}`).join(" ");
    const latest = values[values.length - 1];
    const first = values[0];
    const trend = latest < first ? "↓" : latest > first ? "↑" : "→";
    const improving = lowerBetter !== false ? (latest <= first) : (latest >= first);
    const trendColor = improving ? "#059669" : "#dc2626";
    const targetY = target ? height - ((target - min) / range) * height : null;
    return (
      <div style={{ background:"white", borderRadius:12, padding:"10px 14px", border:"1px solid #f1f5f9", boxShadow:"0 1px 3px rgba(0,0,0,0.04)", position:"relative" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#475569" }}>{label}</div>
          <div style={{ display:"flex", alignItems:"center", gap:4 }}>
            <span style={{ fontSize:15, fontWeight:800, color:trendColor }}>{latest}{unit}</span>
            <span style={{ fontSize:12, color:trendColor, fontWeight:700 }}>{trend}</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${width} ${height}`} style={{ width:"100%", height:height, overflow:"visible" }}
          onMouseLeave={() => setHoverIdx(null)}>
          {/* Target line */}
          {target && targetY >= 0 && targetY <= height && (
            <>
              <line x1="0" y1={targetY} x2={width} y2={targetY} stroke="#10b981" strokeDasharray="3,3" strokeWidth="0.8" opacity="0.5" />
              <text x={width-2} y={targetY-3} fill="#10b981" fontSize="7" textAnchor="end" opacity="0.7">target {target}</text>
            </>
          )}
          {/* Area fill */}
          <polygon points={`0,${height} ${points} ${width},${height}`} fill={`${color}10`} />
          {/* Line */}
          <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
          {/* Data points with hover */}
          {values.map((v, i) => {
            const cx = (i / Math.max(values.length - 1, 1)) * width;
            const cy = height - ((v - min) / range) * height;
            return (
              <g key={i} onMouseEnter={() => setHoverIdx(i)} style={{ cursor:"pointer" }}>
                <circle cx={cx} cy={cy} r={hoverIdx === i ? 5 : 3} fill={hoverIdx === i ? color : "white"} stroke={color} strokeWidth="2" />
                {/* Invisible larger hit area */}
                <circle cx={cx} cy={cy} r="12" fill="transparent" />
              </g>
            );
          })}
          {/* Hover tooltip */}
          {hoverIdx !== null && (() => {
            const cx = (hoverIdx / Math.max(values.length - 1, 1)) * width;
            const cy = height - ((values[hoverIdx] - min) / range) * height;
            const tooltipX = cx < width / 2 ? cx + 8 : cx - 65;
            return (
              <g>
                <line x1={cx} y1={0} x2={cx} y2={height} stroke={color} strokeWidth="0.5" strokeDasharray="2,2" opacity="0.4" />
                <rect x={tooltipX} y={Math.max(cy - 28, 0)} width="60" height="22" rx="4" fill="#1e293b" opacity="0.9" />
                <text x={tooltipX + 30} y={Math.max(cy - 18, 10)} fill="white" fontSize="8" fontWeight="700" textAnchor="middle">{values[hoverIdx]}{unit}</text>
                <text x={tooltipX + 30} y={Math.max(cy - 10, 18)} fill="#94a3b8" fontSize="6" textAnchor="middle">{fmtDate(dates[hoverIdx])}</text>
              </g>
            );
          })()}
        </svg>
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:8, color:"#94a3b8", marginTop:4 }}>
          <span>{fmtDate(dates[0])}</span>
          <span style={{ color:"#cbd5e1" }}>{values.length} reading{values.length!==1?"s":""}</span>
          <span>{fmtDate(dates[dates.length - 1])}</span>
        </div>
      </div>
    );
  };

  // AI Health Summary state
  const [healthSummary, setHealthSummary] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);

  const generateHealthSummary = async () => {
    if (!outcomesData || !patientFullData) return;
    setSummaryLoading(true);
    try {
      const summaryData = {
        patient: { name: patient.name, age: patient.age, sex: patient.sex },
        diagnoses: patientFullData.diagnoses?.map(d => `${d.label}: ${d.status}`) || [],
        medications: patientFullData.medications?.filter(m=>m.is_active).map(m => `${m.name} ${m.dose} ${m.frequency}`) || [],
        labs: patientFullData.lab_results?.slice(0,15).map(l => `${l.test_name}: ${l.result} ${l.unit} (${l.flag||'normal'}) on ${l.test_date}`) || [],
        vitals_trend: {
          hba1c: outcomesData.hba1c?.map(d => `${d.result}% on ${d.test_date}`),
          bp: outcomesData.bp?.map(d => `${d.bp_sys}/${d.bp_dia} on ${d.date}`),
          weight: outcomesData.weight?.map(d => `${d.weight}kg on ${d.date}`),
        },
        diagnosis_journey: outcomesData.diagnosis_journey?.slice(0,20).map(d => `${d.label}: ${d.status} on ${d.visit_date}`),
      };

      const prompt = `You are a caring doctor writing a health journey summary for the patient.
Based on this data, write a 4-6 sentence plain English summary of the patient's health journey.
Include: 1) What conditions they have and how long 2) What's improving and what's not 3) What the biggest concerns are 4) An encouraging note about what's working.
Use simple language a patient can understand. Be specific with numbers. Use the patient's name.

Patient Data: ${JSON.stringify(summaryData)}

Write ONLY the summary paragraph, no headers or formatting.`;

      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 500, messages: [{ role: "user", content: prompt }] })
      });
      const d = await r.json();
      setHealthSummary(d.content?.[0]?.text || "Could not generate summary.");
    } catch (e) { setHealthSummary("Error: " + e.message); }
    setSummaryLoading(false);
  };

  const TABS = [
    { id:"setup", label:"⚙️", show:!keySet },
    { id:"quick", label:"⚡ Quick", show:keySet },
    { id:"patient", label:"👤", show:keySet },
    { id:"vitals", label:"📋", show:keySet },
    { id:"mo", label:"🎤 MO", show:keySet },
    { id:"consultant", label:"👨‍⚕️ Con", show:keySet },
    { id:"plan", label:"📄 Plan", show:keySet },
    { id:"history", label:"📜 Hx", show:keySet && !!API_URL },
    { id:"outcomes", label:"📊", show:keySet && !!API_URL },
    { id:"ai", label:"🤖 AI", show:keySet }
  ];

  // Quick Mode: process single dictation into all sections
  const processQuickMode = async (transcript) => {
    setQuickTranscript(transcript);
    setLoading(l => ({ ...l, quick: true }));
    setErrors(e => ({ ...e, quick: null }));
    try {
      const { data, error } = await callClaude(QUICK_MODE_PROMPT, transcript);
      if (error) throw new Error(error);
      if (data.patient) {
        const p = data.patient;
        // Calculate age from DOB if provided
        let age = p.age;
        if (p.dob && !age) {
          const dob = new Date(p.dob);
          if (!isNaN(dob)) age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        }
        setPatient(prev => ({
          ...prev,
          name: p.name || prev.name,
          age: age || prev.age,
          sex: p.sex || prev.sex,
          phone: p.phone || prev.phone,
          fileNo: p.fileNo || prev.fileNo,
          dob: p.dob || prev.dob,
        }));
      }
      if (data.vitals) {
        const v = data.vitals;
        setVitals(prev => ({
          ...prev,
          bp_sys: v.bp_sys || prev.bp_sys,
          bp_dia: v.bp_dia || prev.bp_dia,
          pulse: v.pulse || prev.pulse,
          spo2: v.spo2 || prev.spo2,
          weight: v.weight || prev.weight,
          height: v.height || prev.height,
        }));
        if (v.weight && v.height) {
          const h = parseFloat(v.height) / 100;
          if (h > 0) setVitals(prev => ({ ...prev, bmi: (parseFloat(v.weight) / (h * h)).toFixed(1) }));
        }
      }
      if (data.mo) setMoData(fixMoMedicines(data.mo));
      if (data.consultant) setConData(fixConMedicines(data.consultant));
      setTab("plan");
    } catch (err) {
      setErrors(e => ({ ...e, quick: err.message }));
    } finally {
      setLoading(l => ({ ...l, quick: false }));
    }
  };

  return (
    <div style={{ fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", maxWidth:1100, margin:"0 auto", padding:"8px 12px", background:"#fff", minHeight:"100vh" }}>

      {/* ═══ LOGIN SCREEN ═══ */}
      {!currentDoctor && doctorsList.length > 0 && (
        <div style={{ position:"fixed", inset:0, background:"linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#0f172a 100%)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999 }}>
          <div style={{ background:"white", borderRadius:20, padding:"36px 32px", width:360, boxShadow:"0 20px 60px rgba(0,0,0,0.4)" }}>
            <div style={{ textAlign:"center", marginBottom:24 }}>
              <div style={{ width:52, height:52, background:"#1e293b", borderRadius:14, display:"inline-flex", alignItems:"center", justifyContent:"center", color:"white", fontWeight:900, fontSize:22, marginBottom:8 }}>G</div>
              <div style={{ fontSize:20, fontWeight:800, color:"#0f172a" }}>Gini Scribe</div>
              <div style={{ fontSize:12, color:"#64748b", marginTop:2 }}>Gini Advanced Care Hospital</div>
            </div>
            <div style={{ marginBottom:14 }}>
              <label style={{ fontSize:11, fontWeight:700, color:"#475569", display:"block", marginBottom:4 }}>Select Doctor</label>
              <select value={loginDoctorId} onChange={e=>setLoginDoctorId(e.target.value)}
                style={{ width:"100%", padding:"10px 12px", border:"1px solid #e2e8f0", borderRadius:10, fontSize:13, background:"#f8fafc", cursor:"pointer" }}>
                <option value="">Choose your name...</option>
                {doctorsList.filter(d=>d.role==="admin").length > 0 && <optgroup label="Admin">
                  {doctorsList.filter(d=>d.role==="admin").map(d => <option key={d.id} value={d.id}>{d.name} — {d.specialty}</option>)}
                </optgroup>}
                {doctorsList.filter(d=>d.role==="consultant").length > 0 && <optgroup label="Consultants">
                  {doctorsList.filter(d=>d.role==="consultant").map(d => <option key={d.id} value={d.id}>{d.name} — {d.specialty}</option>)}
                </optgroup>}
                {doctorsList.filter(d=>d.role==="mo").length > 0 && <optgroup label="Medical Officers">
                  {doctorsList.filter(d=>d.role==="mo").map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </optgroup>}
                {doctorsList.filter(d=>d.role==="nurse").length > 0 && <optgroup label="Nursing">
                  {doctorsList.filter(d=>d.role==="nurse").map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </optgroup>}
                {doctorsList.filter(d=>d.role==="coordinator").length > 0 && <optgroup label="Coordinators">
                  {doctorsList.filter(d=>d.role==="coordinator").map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </optgroup>}
                {doctorsList.filter(d=>d.role==="lab").length > 0 && <optgroup label="Laboratory">
                  {doctorsList.filter(d=>d.role==="lab").map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </optgroup>}
                {doctorsList.filter(d=>d.role==="pharmacy").length > 0 && <optgroup label="Pharmacy">
                  {doctorsList.filter(d=>d.role==="pharmacy").map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </optgroup>}
                {doctorsList.filter(d=>d.role==="reception").length > 0 && <optgroup label="Reception">
                  {doctorsList.filter(d=>d.role==="reception").map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </optgroup>}
                {doctorsList.filter(d=>["guest","longevity"].includes(d.role)).length > 0 && <optgroup label="Other">
                  {doctorsList.filter(d=>["guest","longevity"].includes(d.role)).map(d => <option key={d.id} value={d.id}>{d.name} — {d.specialty}</option>)}
                </optgroup>}
              </select>
            </div>
            <div style={{ marginBottom:18 }}>
              <label style={{ fontSize:11, fontWeight:700, color:"#475569", display:"block", marginBottom:4 }}>PIN</label>
              <input type="password" value={loginPin} onChange={e=>setLoginPin(e.target.value)} placeholder="Enter 4-digit PIN"
                maxLength={4} onKeyDown={e=>e.key==="Enter"&&handleLogin()}
                style={{ width:"100%", padding:"10px 12px", border:"1px solid #e2e8f0", borderRadius:10, fontSize:18, letterSpacing:8, textAlign:"center", boxSizing:"border-box" }} />
            </div>
            {loginError && <div style={{ fontSize:11, color:"#dc2626", textAlign:"center", marginBottom:8, fontWeight:600 }}>❌ {loginError}</div>}
            <button onClick={handleLogin} disabled={loginLoading}
              style={{ width:"100%", padding:"12px", background:loginLoading?"#94a3b8":"#1e293b", color:"white", border:"none", borderRadius:10, fontSize:14, fontWeight:700, cursor:loginLoading?"wait":"pointer" }}>
              {loginLoading ? "⏳ Logging in..." : "🔐 Login"}
            </button>
            <div style={{ textAlign:"center", marginTop:12, fontSize:10, color:"#94a3b8" }}>Default PIN: see admin · v7.8</div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8, paddingBottom:6, borderBottom:"2px solid #1e293b" }}>
        <div style={{ width:28, height:28, background:"#1e293b", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", color:"white", fontWeight:800, fontSize:12 }}>G</div>
        <div style={{ fontSize:13, fontWeight:800, color:"#1e293b" }}>Gini Scribe</div>
        {currentDoctor && <div style={{ fontSize:10, background:"#f0fdf4", color:"#059669", padding:"2px 8px", borderRadius:10, fontWeight:700, border:"1px solid #bbf7d0" }}>
          👨‍⚕️ {currentDoctor.name}{currentDoctor.specialty ? ` · ${currentDoctor.specialty}` : ""}
        </div>}
        <div style={{ flex:1 }} />
        {draftSaved && <span style={{ fontSize:9, color:"#94a3b8" }}>{draftSaved}</span>}
        {keySet && <button onClick={()=>{const next=!showSearch;setShowSearch(next);if(next)searchPatientsDB("");}} style={{ background:showSearch?"#1e293b":"#f1f5f9", color:showSearch?"white":"#64748b", border:"1px solid #e2e8f0", padding:"3px 8px", borderRadius:4, fontSize:10, fontWeight:600, cursor:"pointer" }}>🔍 Find</button>}
        {patient.name && <button onClick={saveConsultation} style={{ background:"#2563eb", color:"white", border:"none", padding:"3px 8px", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>💾 Save</button>}
        {saveStatus && <span style={{ fontSize:10, color:"#059669", fontWeight:600 }}>{saveStatus}</span>}
        {patient.name && <button onClick={newPatient} style={{ background:"#059669", color:"white", border:"none", padding:"3px 8px", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>+ New</button>}
        {patient.name && <div style={{ fontSize:10, fontWeight:600, background:"#f1f5f9", padding:"2px 6px", borderRadius:4, maxWidth:150, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>👤 {patient.name}</div>}
        {currentDoctor && <button onClick={handleLogout} style={{ background:"#fef2f2", color:"#dc2626", border:"1px solid #fecaca", padding:"3px 8px", borderRadius:4, fontSize:9, fontWeight:700, cursor:"pointer" }}>Logout</button>}
      </div>

      {/* Patient Search Panel */}
      {showSearch && (
        <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:8, padding:10, marginBottom:8 }}>
          <input value={searchQuery} onChange={e=>{setSearchQuery(e.target.value);searchPatientsDB(e.target.value);}} placeholder="Search by name, phone, file #, ABHA ID..."
            style={{ width:"100%", padding:"6px 10px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:12, boxSizing:"border-box", marginBottom:6 }} autoFocus />
          <div style={{ maxHeight:250, overflow:"auto" }}>
            {/* DB Results */}
            {dbPatients.length > 0 && (
              <div>
                <div style={{ fontSize:9, fontWeight:700, color:"#2563eb", padding:"2px 4px", background:"#eff6ff", borderRadius:3, marginBottom:3 }}>📊 DATABASE</div>
                {dbPatients.slice(0, 10).map(r => (
                  <div key={`db-${r.id}`} onClick={()=>loadPatientDB(r)} style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 8px", borderRadius:4, cursor:"pointer", fontSize:11, borderBottom:"1px solid #f1f5f9" }}
                    onMouseEnter={e=>e.currentTarget.style.background="#eff6ff"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{ flex:1 }}>
                      <strong>{r.name}</strong>
                      <span style={{ color:"#94a3b8", marginLeft:6 }}>{r.age}Y/{r.sex?.charAt(0)} {r.phone&&`| ${r.phone}`} {r.file_no&&`| ${r.file_no}`}</span>
                    </div>
                    <div style={{ fontSize:9, color:"#2563eb", fontWeight:600 }}>{r.visit_count || 0} visits</div>
                    {r.last_visit && <div style={{ fontSize:9, color:"#94a3b8" }}>{new Date(r.last_visit).toLocaleDateString("en-IN",{day:"2-digit",month:"short"})}</div>}
                    {r.active_diagnoses && <div style={{ fontSize:8, color:"#f59e0b", fontWeight:600 }}>{r.active_diagnoses}</div>}
                  </div>
                ))}
              </div>
            )}
            {/* Local Results */}
            {filteredPatients.length > 0 && (
              <div>
                <div style={{ fontSize:9, fontWeight:700, color:"#64748b", padding:"2px 4px", background:"#f1f5f9", borderRadius:3, marginBottom:3, marginTop:dbPatients.length>0?6:0 }}>💾 LOCAL</div>
                {filteredPatients.slice(0, 10).map(r => (
                  <div key={r.id} onClick={()=>loadPatient(r)} style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 8px", borderRadius:4, cursor:"pointer", fontSize:11, borderBottom:"1px solid #f1f5f9" }}
                    onMouseEnter={e=>e.currentTarget.style.background="#eff6ff"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{ flex:1 }}>
                      <strong>{r.patient?.name || "Unknown"}</strong>
                      <span style={{ color:"#94a3b8", marginLeft:6 }}>{r.patient?.age}Y/{r.patient?.sex?.charAt(0)} {r.patient?.phone&&`| ${r.patient.phone}`} {r.patient?.fileNo&&`| ${r.patient.fileNo}`}</span>
                    </div>
                    <div style={{ fontSize:9, color:"#94a3b8" }}>{new Date(r.date).toLocaleDateString("en-IN",{day:"2-digit",month:"short"})}</div>
                    <div style={{ display:"flex", gap:2 }}>
                      {r.moData && <span style={{ background:"#dbeafe", padding:"0 3px", borderRadius:2, fontSize:8, fontWeight:600 }}>MO</span>}
                      {r.conData && <span style={{ background:"#dcfce7", padding:"0 3px", borderRadius:2, fontSize:8, fontWeight:600 }}>CON</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {dbPatients.length === 0 && filteredPatients.length === 0 && <div style={{ fontSize:11, color:"#94a3b8", textAlign:"center", padding:10 }}>No patients found</div>}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:"flex", gap:0, marginBottom:10, borderRadius:8, overflow:"hidden", border:"1px solid #e2e8f0" }}>
        {TABS.filter(t=>t.show!==false).map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)} style={{ flex:1, padding:"7px 4px", fontSize:11, fontWeight:600, cursor:"pointer", border:"none", background:tab===t.id?(t.id==="quick"?"#dc2626":"#1e293b"):"white", color:tab===t.id?"white":"#64748b" }}>{t.label}</button>
        ))}
      </div>

      {/* ===== SETUP ===== */}
      {tab==="setup" && (
        <div style={{ maxWidth:420, margin:"0 auto", padding:"14px 0" }}>
          <div style={{ textAlign:"center", marginBottom:14 }}>
            <div style={{ fontSize:32 }}>🔑</div>
            <div style={{ fontSize:15, fontWeight:800 }}>Voice Transcription Setup</div>
            <div style={{ fontSize:11, color:"#94a3b8" }}>Enter at least one key. Both enables A/B testing.</div>
          </div>
          <div style={{ marginBottom:10 }}>
            <label style={{ fontSize:11, fontWeight:600, color:"#475569" }}>Deepgram Key <span style={{ color:"#94a3b8", fontWeight:400 }}>(faster, ₹0.35/min)</span></label>
            <input type="password" value={dgKey} onChange={e=>setDgKey(e.target.value)} placeholder="Paste Deepgram API key..."
              style={{ width:"100%", padding:"8px 12px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:13, fontFamily:"monospace", boxSizing:"border-box", marginTop:3 }} />
          </div>
          <div style={{ marginBottom:10 }}>
            <label style={{ fontSize:11, fontWeight:600, color:"#475569" }}>OpenAI Key <span style={{ color:"#94a3b8", fontWeight:400 }}>(Whisper — better Hindi, ₹0.50/min)</span></label>
            <input type="password" value={whisperKey} onChange={e=>setWhisperKey(e.target.value)} placeholder="Paste OpenAI API key..."
              style={{ width:"100%", padding:"8px 12px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:13, fontFamily:"monospace", boxSizing:"border-box", marginTop:3 }} />
          </div>
          <button onClick={()=>{if(dgKey.length>10||whisperKey.length>10){setKeySet(true);setTab("patient");}}} style={{ width:"100%", background:(dgKey.length>10||whisperKey.length>10)?"#059669":"#94a3b8", color:"white", border:"none", padding:"12px", borderRadius:8, fontSize:14, fontWeight:700, cursor:(dgKey.length>10||whisperKey.length>10)?"pointer":"not-allowed" }}>
            {dgKey.length>10||whisperKey.length>10?"✅ Start":"Enter at least one key"}
          </button>
        </div>
      )}

      {/* ===== QUICK MODE ===== */}
      {tab==="quick" && (
        <div>
          <div style={{ background:"linear-gradient(135deg,#dc2626,#b91c1c)", borderRadius:10, padding:14, marginBottom:10, color:"white" }}>
            <div style={{ fontSize:15, fontWeight:800, marginBottom:3 }}>⚡ Quick Dictation</div>
            <div style={{ fontSize:11, opacity:.85 }}>Dictate everything in one go — patient, history, vitals, meds, plan. AI splits it into all sections automatically.</div>
          </div>

          <AudioInput
            onTranscript={processQuickMode}
            dgKey={dgKey} whisperKey={whisperKey}
            label="🎙️ Full Consultation — dictate everything at once"
            color="#dc2626"
          />

          {loading.quick && (
            <div style={{ textAlign:"center", padding:20 }}>
              <div style={{ fontSize:28, animation:"pulse 1s infinite" }}>🧠</div>
              <div style={{ fontSize:12, fontWeight:600, color:"#475569" }}>Parsing consultation into sections...</div>
              <div style={{ fontSize:10, color:"#94a3b8", marginTop:4 }}>Patient • Vitals • Diagnoses • Meds • Plan</div>
            </div>
          )}

          {errors.quick && <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:8, padding:10, marginTop:8 }}>
            <div style={{ fontSize:11, color:"#dc2626", fontWeight:600 }}>⚠️ {errors.quick}</div>
          </div>}

          {quickTranscript && !loading.quick && (
            <div style={{ marginTop:8, background:"#f8fafc", borderRadius:8, padding:10, border:"1px solid #e2e8f0" }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#94a3b8", marginBottom:4 }}>RAW TRANSCRIPT</div>
              <div style={{ fontSize:11, color:"#475569", lineHeight:1.6 }}>{quickTranscript}</div>
            </div>
          )}

          <div style={{ marginTop:12, padding:10, background:"#fefce8", borderRadius:8, border:"1px solid #fef08a" }}>
            <div style={{ fontSize:11, fontWeight:700, color:"#854d0e", marginBottom:3 }}>💡 Tips for best results:</div>
            <div style={{ fontSize:10, color:"#92400e", lineHeight:1.6 }}>
              Start with patient name and demographics, then history and current medications, then today's vitals and lab results, then the plan — new medicines, lifestyle advice, follow-up.
            </div>
          </div>

          <div style={{ marginTop:8, fontSize:10, color:"#94a3b8", textAlign:"center" }}>
            Or use individual tabs → for step-by-step entry
          </div>
        </div>
      )}

      {/* ===== PATIENT ===== */}
      {tab==="patient" && (
        <div style={{ maxWidth:560, margin:"0 auto" }}>
          <AudioInput label="Say patient details" dgKey={dgKey} whisperKey={whisperKey} color="#1e40af" compact onTranscript={voiceFillPatient} />
          {loading.pv && <div style={{ textAlign:"center", padding:4, fontSize:11, color:"#1e40af", fontWeight:600 }}>🔬 Filling fields...</div>}
          <Err msg={errors.pv} onDismiss={()=>clearErr("pv")} />
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:6 }}>
            {[
              { k:"name", l:"Full Name *", ph:"Rajinder Singh", span:2 },
              { k:"phone", l:"Phone", ph:"+91 98765 43210" },
              { k:"fileNo", l:"File No.", ph:"GINI-2025-04821" },
              { k:"dob", l:"DOB", type:"date" },
              { k:"age", l:"Age", ph:"77", disabled:!!patient.dob },
            ].map(f => (
              <div key={f.k} style={{ gridColumn:f.span?"span 2":"span 1" }}>
                <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>{f.l}</label>
                <input type={f.type||"text"} value={patient[f.k]} onChange={e=>updatePatient(f.k,e.target.value)} disabled={f.disabled} placeholder={f.ph}
                  style={{ width:"100%", padding:"6px 8px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:14, boxSizing:"border-box", background:f.disabled?"#f8fafc":"white" }} />
              </div>
            ))}
            <div>
              <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>Sex</label>
              <div style={{ display:"flex", gap:4 }}>
                {["Male","Female"].map(s => (
                  <button key={s} onClick={()=>updatePatient("sex",s)} style={{ flex:1, padding:"6px", border:`1px solid ${patient.sex===s?"#1e293b":"#e2e8f0"}`, borderRadius:6, background:patient.sex===s?"#1e293b":"white", color:patient.sex===s?"white":"#64748b", fontWeight:600, fontSize:12, cursor:"pointer" }}>{s}</button>
                ))}
              </div>
            </div>
          </div>

          {/* IDs Section */}
          <details style={{ marginTop:10, border:"1px solid #e2e8f0", borderRadius:8, overflow:"hidden" }}>
            <summary style={{ padding:"6px 10px", fontSize:11, fontWeight:600, color:"#475569", cursor:"pointer", background:"#f8fafc" }}>🆔 Health & Government IDs (optional)</summary>
            <div style={{ padding:10, display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              <div>
                <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>ABHA ID</label>
                <input value={patient.abhaId||""} onChange={e=>updatePatient("abhaId",e.target.value)} placeholder="XX-XXXX-XXXX-XXXX"
                  style={{ width:"100%", padding:"6px 8px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:12, boxSizing:"border-box" }} />
              </div>
              <div>
                <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>Health ID</label>
                <input value={patient.healthId||""} onChange={e=>updatePatient("healthId",e.target.value)} placeholder="MyHealth Genie ID"
                  style={{ width:"100%", padding:"6px 8px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:12, boxSizing:"border-box" }} />
              </div>
              <div>
                <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>Aadhaar</label>
                <input value={patient.aadhaar||""} onChange={e=>updatePatient("aadhaar",e.target.value)} placeholder="XXXX XXXX XXXX"
                  style={{ width:"100%", padding:"6px 8px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:12, boxSizing:"border-box" }} />
              </div>
              <div>
                <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>
                  <select value={patient.govtIdType||""} onChange={e=>updatePatient("govtIdType",e.target.value)} style={{ fontSize:10, border:"none", background:"transparent", fontWeight:600, color:"#475569" }}>
                    <option value="">Other ID</option>
                    <option value="Passport">Passport</option>
                    <option value="DrivingLicense">Driving License</option>
                    <option value="VoterID">Voter ID</option>
                    <option value="PAN">PAN</option>
                  </select>
                </label>
                <input value={patient.govtId||""} onChange={e=>updatePatient("govtId",e.target.value)} placeholder="ID number"
                  style={{ width:"100%", padding:"6px 8px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:12, boxSizing:"border-box" }} />
              </div>
            </div>
          </details>

          <button onClick={()=>{if(patient.name) setTab("vitals");}} style={{ marginTop:10, width:"100%", background:patient.name?"#1e293b":"#94a3b8", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:patient.name?"pointer":"not-allowed" }}>
            {patient.name?"Next: Vitals →":"Enter name first"}
          </button>
        </div>
      )}

      {/* ===== VITALS ===== */}
      {tab==="vitals" && (
        <div>
          <div style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:800, marginBottom:6 }}>📊 Vitals</div>
              <AudioInput label="Say vitals: BP 140 over 90, weight 80kg" dgKey={dgKey} whisperKey={whisperKey} color="#ea580c" compact onTranscript={voiceFillVitals} />
              {loading.vv && <div style={{ textAlign:"center", padding:3, fontSize:10, color:"#ea580c" }}>🔬 Filling...</div>}
              <Err msg={errors.vv} onDismiss={()=>clearErr("vv")} />
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5, marginTop:6 }}>
                {[{k:"bp_sys",l:"BP Sys"},{k:"bp_dia",l:"BP Dia"},{k:"pulse",l:"Pulse"},{k:"temp",l:"Temp °F"},{k:"spo2",l:"SpO2 %"},{k:"weight",l:"Wt kg"},{k:"height",l:"Ht cm"},{k:"bmi",l:"BMI",disabled:true},{k:"waist",l:"Waist cm"},{k:"body_fat",l:"Body Fat %"},{k:"muscle_mass",l:"Muscle kg"}].map(v => (
                  <div key={v.k}>
                    <label style={{ fontSize:9, fontWeight:600, color:"#64748b" }}>{v.l}</label>
                    <input type="number" value={vitals[v.k]} onChange={e=>updateVital(v.k,e.target.value)} disabled={v.disabled}
                      style={{ width:"100%", padding:"4px 6px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:14, fontWeight:600, boxSizing:"border-box", background:v.disabled?"#f0fdf4":"white" }} />
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:800, color:"#7c3aed", marginBottom:6 }}>🔬 Lab Reports</div>
              <div onClick={()=>labRef.current?.click()} style={{ border:"2px dashed #c4b5fd", borderRadius:8, padding:14, textAlign:"center", cursor:"pointer", background:"#faf5ff" }}>
                <input ref={labRef} type="file" accept="image/*,.pdf" onChange={handleLabUpload} style={{ display:"none" }} />
                {labImageData ? <div style={{ color:"#7c3aed", fontWeight:600, fontSize:12 }}>📋 {labImageData.fileName}</div> : <div><div style={{ fontSize:22 }}>📋</div><div style={{ fontWeight:600, color:"#7c3aed", fontSize:12 }}>Upload Report</div></div>}
              </div>
              {labImageData && !labData && <button onClick={processLab} disabled={loading.lab} style={{ marginTop:4, width:"100%", background:loading.lab?"#94a3b8":"#7c3aed", color:"white", border:"none", padding:"7px", borderRadius:6, fontSize:12, fontWeight:700, cursor:loading.lab?"wait":"pointer" }}>{loading.lab?"🔬 Extracting...":"🔬 Extract Labs"}</button>}
              <Err msg={errors.lab} onDismiss={()=>clearErr("lab")} />
              {labMismatch && <div style={{ marginTop:3, background:"#fef2f2", border:"1px solid #fecaca", borderRadius:4, padding:"3px 6px", fontSize:10, color:"#dc2626" }}>⚠️ {labMismatch}</div>}
              {labData && <div style={{ marginTop:3, color:"#059669", fontWeight:600, fontSize:11 }}>✅ {labData.panels?.reduce((a,p)=>a+p.tests.length,0)} tests extracted</div>}
            </div>
          </div>
          {labData && (labData.panels||[]).map((panel,pi) => (
            <div key={pi} style={{ marginTop:6, border:"1px solid #e2e8f0", borderRadius:6, overflow:"hidden" }}>
              <div style={{ background:"#7c3aed", color:"white", padding:"4px 8px", fontSize:11, fontWeight:700 }}>{panel.panel_name}</div>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}><tbody>
                {panel.tests.map((t,ti) => (
                  <tr key={ti} style={{ background:t.flag==="H"?"#fef2f2":t.flag==="L"?"#eff6ff":ti%2?"#fafafa":"white" }}>
                    <td style={{ padding:"2px 8px" }}>{t.test_name}</td>
                    <td style={{ padding:"2px 8px", textAlign:"right", fontWeight:700, color:t.flag==="H"?"#dc2626":t.flag==="L"?"#2563eb":"#1e293b" }}>{t.result_text||t.result} {t.unit}</td>
                    <td style={{ padding:"2px 8px", textAlign:"center", fontSize:9 }}>{t.flag==="H"?"↑ HIGH":t.flag==="L"?"↓ LOW":"✓"}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          ))}

          {/* ═══ IMAGING / DIAGNOSTIC REPORTS ═══ */}
          <div style={{ marginTop:14, borderTop:"2px solid #e2e8f0", paddingTop:10 }}>
            <div style={{ fontSize:13, fontWeight:800, color:"#0369a1", marginBottom:8 }}>🩻 Imaging & Diagnostic Reports</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:8 }}>
              {["X-Ray","MRI","Ultrasound","DEXA","ECG","Echo","CT","ABI","VPT","Fundus","PFT","NCS"].map(type => (
                <label key={type} style={{ padding:"5px 10px", background:"#f0f9ff", border:"1px solid #bae6fd", borderRadius:6, fontSize:10, fontWeight:600, color:"#0369a1", cursor:"pointer", display:"inline-block" }}>
                  📎 {type}
                  <input type="file" accept="image/*,.pdf" onChange={e=>handleImagingUpload(e, type)} style={{ display:"none" }} />
                </label>
              ))}
            </div>

            {imagingFiles.map(file => (
              <div key={file.id} style={{ border:"1px solid #e2e8f0", borderRadius:8, padding:10, marginBottom:8, background:file.data?"#f0fdf4":"#fafafa" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:file.data?6:0 }}>
                  <span style={{ fontSize:11, fontWeight:700, color:"#0369a1" }}>🩻 {file.type}</span>
                  <span style={{ fontSize:10, color:"#94a3b8" }}>{file.fileName}</span>
                  <div style={{ flex:1 }} />
                  {!file.data && !file.extracting && (
                    <button onClick={()=>processImaging(file.id)} style={{ background:"#0369a1", color:"white", border:"none", padding:"3px 10px", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>🔬 Extract</button>
                  )}
                  {file.extracting && <span style={{ fontSize:10, color:"#0369a1", fontWeight:600 }}>⏳ Analyzing...</span>}
                  {file.data && <span style={{ fontSize:10, color:"#059669", fontWeight:700 }}>✅ Extracted</span>}
                  <button onClick={()=>removeImaging(file.id)} style={{ background:"#fef2f2", color:"#dc2626", border:"none", padding:"2px 6px", borderRadius:4, fontSize:9, cursor:"pointer" }}>✕</button>
                </div>
                {file.error && <div style={{ fontSize:10, color:"#dc2626", marginTop:3 }}>❌ {file.error}</div>}
                {file.data && (
                  <div>
                    {file.data.impression && <div style={{ fontSize:11, color:"#1e293b", fontWeight:600, padding:"4px 8px", background:"#f0f9ff", borderRadius:4, marginBottom:4 }}>💡 {file.data.impression}</div>}
                    {(file.data.findings||[]).length > 0 && (
                      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10, border:"1px solid #e2e8f0", borderRadius:4 }}>
                        <thead><tr style={{ background:"#0369a1", color:"white" }}>
                          <th style={{ padding:"3px 6px", textAlign:"left" }}>Parameter</th>
                          <th style={{ padding:"3px 6px", textAlign:"right" }}>Value</th>
                          <th style={{ padding:"3px 6px", textAlign:"center" }}>Status</th>
                          <th style={{ padding:"3px 6px", textAlign:"left" }}>Detail</th>
                        </tr></thead>
                        <tbody>
                          {file.data.findings.map((f,i) => (
                            <tr key={i} style={{ background:f.interpretation==="Abnormal"?"#fef2f2":f.interpretation==="Borderline"?"#fefce8":i%2?"#fafafa":"white" }}>
                              <td style={{ padding:"2px 6px", fontWeight:600 }}>{f.parameter}</td>
                              <td style={{ padding:"2px 6px", textAlign:"right", fontWeight:700, color:f.interpretation==="Abnormal"?"#dc2626":"#1e293b" }}>{f.value} {f.unit||""}</td>
                              <td style={{ padding:"2px 6px", textAlign:"center" }}>
                                <span style={{ fontSize:8, padding:"1px 4px", borderRadius:3, fontWeight:700,
                                  background:f.interpretation==="Abnormal"?"#dc2626":f.interpretation==="Borderline"?"#f59e0b":"#059669",
                                  color:"white" }}>{f.interpretation}</span>
                              </td>
                              <td style={{ padding:"2px 6px", fontSize:9, color:"#64748b" }}>{f.detail||""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {file.data.recommendations && <div style={{ fontSize:10, color:"#7c3aed", marginTop:3, fontStyle:"italic" }}>📋 {file.data.recommendations}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>

          <button onClick={()=>setTab("mo")} style={{ marginTop:8, width:"100%", background:"#1e293b", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:"pointer" }}>Next: MO Recording →</button>
        </div>
      )}

      {/* ===== MO SUMMARY — RICH DISPLAY ===== */}
      {tab==="mo" && (
        <div>
          <div style={{ display:"flex", gap:6, marginBottom:6, alignItems:"center" }}>
            <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>MO:</label>
            {doctorsList.filter(d=>d.role==="mo").length > 0 ? (
              <select value={moName} onChange={e=>setMoName(e.target.value)}
                style={{ padding:"4px 8px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:12, fontWeight:600, width:200, background:"white" }}>
                {doctorsList.filter(d=>d.role==="mo").map(d => <option key={d.id} value={d.short_name}>{d.name}</option>)}
                <option value="">— Other —</option>
              </select>
            ) : (
              <input value={moName} onChange={e=>setMoName(e.target.value)} placeholder="Dr. Name"
                style={{ padding:"4px 8px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:12, fontWeight:600, width:160 }} />
            )}
          </div>
          <AudioInput label="MO — Patient History" dgKey={dgKey} whisperKey={whisperKey} color="#1e40af" onTranscript={t=>{setMoTranscript(t);setMoData(null);clearErr("mo");}} />
          {moTranscript && <button onClick={processMO} disabled={loading.mo} style={{ marginTop:6, width:"100%", background:loading.mo?"#6b7280":moData?"#059669":"#1e40af", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:loading.mo?"wait":"pointer" }}>
            {loading.mo?"🔬 Structuring...":moData?"✅ Done — Re-process":"🔬 Structure MO Summary"}
          </button>}
          <Err msg={errors.mo} onDismiss={()=>clearErr("mo")} />

          {moData && (
            <div style={{ marginTop:8 }}>
              {/* Header */}
              <div style={{ background:"#1e40af", color:"white", padding:"8px 12px", borderRadius:"8px 8px 0 0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontWeight:700, fontSize:13 }}>📋 MO Summary — {patient.name||"Patient"} <span style={{ fontSize:10, opacity:.7 }}>by {moName}</span></span>
                <button onClick={()=>setTab("consultant")} style={{ background:"rgba(255,255,255,0.2)", border:"none", color:"white", padding:"3px 10px", borderRadius:4, fontSize:11, fontWeight:700, cursor:"pointer" }}>Next: Consultant →</button>
              </div>
              <div style={{ border:"1px solid #bfdbfe", borderTop:"none", borderRadius:"0 0 8px 8px", padding:12 }}>

                {/* Diagnoses */}
                <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:10 }}>
                  {sa(moData,"diagnoses").map((d,i) => (
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:4, padding:"4px 10px", borderRadius:6, background:(DC[d.id]||"#64748b")+"12", border:`1px solid ${(DC[d.id]||"#64748b")}30` }}>
                      <div style={{ width:8, height:8, borderRadius:"50%", background:DC[d.id]||"#64748b" }} />
                      <span style={{ fontSize:12, fontWeight:600, color:DC[d.id]||"#64748b" }}>{d.label}</span>
                      <span style={{ fontSize:9, fontWeight:700, padding:"1px 5px", borderRadius:8, background:d.status==="Uncontrolled"||d.status==="Suboptimal"?"#fef2f2":d.status==="Active"?"#fef3c7":"#f0fdf4", color:d.status==="Uncontrolled"||d.status==="Suboptimal"?"#dc2626":d.status==="Active"?"#92400e":"#059669" }}>{d.status}</span>
                    </div>
                  ))}
                </div>

                {/* Complications */}
                {sa(moData,"complications").length>0 && (
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"#dc2626", marginBottom:3 }}>⚠️ COMPLICATIONS</div>
                    <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                      {sa(moData,"complications").map((c,i) => (
                        <span key={i} style={{ fontSize:11, padding:"2px 8px", borderRadius:6, background:c.severity==="high"?"#fef2f2":"#fef3c7", border:`1px solid ${c.severity==="high"?"#fecaca":"#fde68a"}`, color:c.severity==="high"?"#dc2626":"#92400e" }}>
                          {c.name} ({c.status}) {c.detail && `— ${c.detail}`}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* History */}
                {moData.history && (
                  <div style={{ marginBottom:10, background:"#f8fafc", borderRadius:6, padding:8, border:"1px solid #e2e8f0" }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"#1e293b", marginBottom:4 }}>📖 HISTORY</div>
                    <div style={{ fontSize:11, lineHeight:1.8, color:"#475569" }}>
                      {moData.history.family && moData.history.family !== "NIL" && <div>👨‍👩‍👧 <strong>Family:</strong> {moData.history.family}</div>}
                      {moData.history.past_medical_surgical && moData.history.past_medical_surgical !== "NIL" && <div>🏥 <strong>Past:</strong> {moData.history.past_medical_surgical}</div>}
                      {moData.history.personal && moData.history.personal !== "NIL" && <div>🚬 <strong>Personal:</strong> {moData.history.personal}</div>}
                      {moData.history.covid && <div>🦠 <strong>COVID:</strong> {moData.history.covid}</div>}
                      {moData.history.vaccination && <div>💉 <strong>Vaccination:</strong> {moData.history.vaccination}</div>}
                    </div>
                  </div>
                )}

                {/* Previous Medications */}
                {sa(moData,"previous_medications").length>0 && (
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"#1e40af", marginBottom:4 }}>💊 PREVIOUS MEDICATIONS</div>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11, border:"1px solid #bfdbfe", borderRadius:4, overflow:"hidden" }}>
                      <thead><tr style={{ background:"#1e40af", color:"white" }}><th style={{ padding:"3px 8px", textAlign:"left" }}>Medicine</th><th style={{ padding:"3px 8px" }}>Dose</th><th style={{ padding:"3px 8px" }}>Freq</th><th style={{ padding:"3px 8px" }}>When</th></tr></thead>
                      <tbody>{sa(moData,"previous_medications").map((m,i) => (
                        <tr key={i} style={{ background:i%2?"#eff6ff":"white" }}>
                          <td style={{ padding:"3px 8px" }}><strong>{m.name}</strong>{m.composition && <div style={{ fontSize:9, color:"#94a3b8" }}>{m.composition}</div>}</td>
                          <td style={{ padding:"3px 8px", textAlign:"center" }}>{m.dose}</td>
                          <td style={{ padding:"3px 8px", textAlign:"center" }}>{m.frequency}</td>
                          <td style={{ padding:"3px 8px", textAlign:"center" }}>{m.timing}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}

                {/* Investigations */}
                {sa(moData,"investigations").length>0 && (
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"#7c3aed", marginBottom:4 }}>🔬 INVESTIGATIONS</div>
                    {sa(moData,"investigations").map((inv,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"4px 8px", marginBottom:2, borderRadius:4, background:inv.critical?"#fef2f2":inv.flag==="HIGH"?"#fff7ed":inv.flag==="LOW"?"#eff6ff":"#f0fdf4", border:`1px solid ${inv.critical?"#fecaca":inv.flag==="HIGH"?"#fed7aa":inv.flag==="LOW"?"#bfdbfe":"#bbf7d0"}` }}>
                        <span style={{ fontSize:12, fontWeight:600 }}>{inv.test}</span>
                        <span style={{ display:"flex", alignItems:"center", gap:4 }}>
                          <span style={{ fontSize:13, fontWeight:800, color:inv.critical?"#dc2626":inv.flag==="HIGH"?"#ea580c":inv.flag==="LOW"?"#2563eb":"#059669" }}>{inv.value} {inv.unit}</span>
                          {inv.critical && <span style={{ background:"#dc2626", color:"white", padding:"0 4px", borderRadius:4, fontSize:9, fontWeight:700 }}>CRITICAL</span>}
                          {inv.flag==="HIGH" && !inv.critical && <span style={{ color:"#ea580c", fontSize:10 }}>⚠️ HIGH</span>}
                          {inv.flag==="LOW" && <span style={{ color:"#2563eb", fontSize:10 }}>⚠️ LOW</span>}
                          {!inv.flag && <span style={{ color:"#059669", fontSize:10 }}>✅</span>}
                          {inv.ref && <span style={{ fontSize:9, color:"#94a3b8" }}>({inv.ref})</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Missing */}
                {sa(moData,"missing_investigations").length>0 && (
                  <div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:6, padding:"6px 10px", fontSize:11, color:"#1e40af" }}>
                    ❓ <strong>Missing investigations:</strong> {sa(moData,"missing_investigations").join(", ")}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== CONSULTANT ===== */}
      {tab==="consultant" && (
        <div>
          <div style={{ display:"flex", gap:6, marginBottom:6, alignItems:"center" }}>
            <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>Consultant:</label>
            {doctorsList.filter(d=>d.role==="consultant").length > 0 ? (
              <select value={conName} onChange={e=>setConName(e.target.value)}
                style={{ padding:"4px 8px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:12, fontWeight:600, width:260, background:"white" }}>
                {doctorsList.filter(d=>d.role==="consultant").map(d => <option key={d.id} value={d.short_name}>{d.name} — {d.specialty}</option>)}
                <option value="">— Other —</option>
              </select>
            ) : (
              <input value={conName} onChange={e=>setConName(e.target.value)} placeholder="Dr. Name"
                style={{ padding:"4px 8px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:12, fontWeight:600, width:160 }} />
            )}
          </div>
          <AudioInput label="Consultant — Treatment Decisions" dgKey={dgKey} whisperKey={whisperKey} color="#7c2d12" onTranscript={t=>{setConTranscript(t);setConData(null);clearErr("con");}} />
          {conTranscript && <button onClick={processConsultant} disabled={loading.con} style={{ marginTop:6, width:"100%", background:loading.con?"#6b7280":conData?"#059669":"#7c2d12", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:loading.con?"wait":"pointer" }}>
            {loading.con?"🔬 Extracting...":conData?"✅ Done — Re-process":"🔬 Extract Treatment Plan"}
          </button>}
          <Err msg={errors.con} onDismiss={()=>clearErr("con")} />
          {conData && (
            <div style={{ marginTop:8, display:"flex", gap:8 }}>
              <div style={{ flex:1, border:"1px solid #fed7aa", borderRadius:6, overflow:"hidden" }}>
                <div style={{ background:"#7c2d12", color:"white", padding:"6px 8px", fontSize:12, fontWeight:700 }}>Assessment</div>
                <div style={{ padding:8, fontSize:12, lineHeight:1.5 }}>
                  <div style={{ fontWeight:600, marginBottom:3 }}>{conData.assessment_summary}</div>
                  {sa(conData,"key_issues").map((x,i) => <div key={i}>• {x}</div>)}
                  {sa(conData,"goals").length>0 && <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10, marginTop:6, border:"1px solid #bbf7d0" }}>
                    <thead><tr style={{ background:"#059669", color:"white" }}><th style={{padding:"3px 5px"}}>Marker</th><th style={{padding:"3px 5px"}}>Now</th><th style={{padding:"3px 5px"}}>Target</th></tr></thead>
                    <tbody>{sa(conData,"goals").map((g,i) => <tr key={i}><td style={{padding:"2px 5px"}}>{g.marker}</td><td style={{padding:"2px 5px",color:"#dc2626",fontWeight:700}}>{g.current}</td><td style={{padding:"2px 5px",color:"#059669",fontWeight:700}}>{g.target}</td></tr>)}</tbody>
                  </table>}
                </div>
              </div>
              <div style={{ flex:1, border:"1px solid #e2e8f0", borderRadius:6, overflow:"hidden" }}>
                <div style={{ background:"#1e293b", color:"white", padding:"6px 8px", fontSize:12, fontWeight:700, display:"flex", justifyContent:"space-between" }}>
                  <span>Medications</span>
                  <button onClick={()=>setTab("plan")} style={{ background:"rgba(255,255,255,0.2)", border:"none", color:"white", padding:"1px 6px", borderRadius:3, fontSize:10, cursor:"pointer" }}>Plan →</button>
                </div>
                <div style={{ padding:8, fontSize:11, maxHeight:280, overflow:"auto" }}>
                  {sa(conData,"medications_confirmed").map((m,i) => (
                    <div key={i} style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:4, padding:"4px 8px", marginBottom:3 }}>
                      <div>✅ <strong>{m.name}</strong></div>
                      <div style={{ fontSize:10, color:"#475569" }}>{m.dose} • {m.frequency} • <strong>{m.timing}</strong></div>
                    </div>
                  ))}
                  {sa(conData,"medications_needs_clarification").map((m,i) => (
                    <div key={i} style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:4, padding:6, marginBottom:3, marginTop:i===0?4:0 }}>
                      <div style={{ fontSize:10, color:"#92400e", marginBottom:3 }}>⚠️ "{m.what_consultant_said}" ({m.drug_class})</div>
                      {m.default_dose && <div style={{ fontSize:9, color:"#64748b", marginBottom:2 }}>Suggested: {m.default_dose}, {m.default_timing}</div>}
                      <div style={{ display:"flex", gap:3, flexWrap:"wrap" }}>
                        <input placeholder="Brand name" onChange={e=>handleClarification(i,"resolved_name",e.target.value)} style={{ flex:2, minWidth:70, padding:"3px 5px", border:"1px solid #fde68a", borderRadius:3, fontSize:10 }} />
                        <input placeholder={m.default_dose||"Dose"} onChange={e=>handleClarification(i,"resolved_dose",e.target.value)} style={{ flex:1, minWidth:40, padding:"3px 5px", border:"1px solid #fde68a", borderRadius:3, fontSize:10 }} />
                        <input placeholder={m.default_timing||"Timing"} onChange={e=>handleClarification(i,"resolved_timing",e.target.value)} style={{ flex:1, minWidth:50, padding:"3px 5px", border:"1px solid #fde68a", borderRadius:3, fontSize:10 }} />
                      </div>
                      {m.suggested_options?.length>0 && <div style={{ fontSize:9, color:"#94a3b8", marginTop:2 }}>Options: {m.suggested_options.join(" • ")}</div>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== TREATMENT PLAN — NULL-SAFE ===== */}
      {tab==="plan" && (
        <div>
          <div style={{ display:"flex", gap:4, marginBottom:8 }}>
            <button onClick={()=>setTab("vitals")} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"4px 8px", borderRadius:4, fontSize:10, cursor:"pointer", fontWeight:600 }}>+ Reports</button>
            <button onClick={()=>setTab("mo")} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"4px 8px", borderRadius:4, fontSize:10, cursor:"pointer", fontWeight:600 }}>✏️ MO</button>
            <button onClick={()=>setTab("consultant")} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"4px 8px", borderRadius:4, fontSize:10, cursor:"pointer", fontWeight:600 }}>✏️ Consultant</button>
            <button className="no-print" onClick={resetPlanEdits} style={{ background:"#fef3c7", border:"1px solid #fcd34d", padding:"4px 8px", borderRadius:4, fontSize:10, cursor:"pointer", fontWeight:600, color:"#92400e" }}>↩ Reset</button>
            <div style={{ flex:1 }} />
            <button onClick={()=>window.print()} style={{ background:"#1e293b", color:"white", border:"none", padding:"4px 12px", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>🖨️ Print</button>
          </div>

          {!moData && !conData ? <div style={{ textAlign:"center", padding:24, color:"#94a3b8" }}>Complete MO & Consultant first</div> : (
            <div>
              {/* Plan Header */}
              <div style={{ background:"linear-gradient(135deg,#1e293b,#334155)", color:"white", padding:"12px 16px", borderRadius:"10px 10px 0 0" }}>
                <div style={{ display:"flex", justifyContent:"space-between" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <div style={{ width:26, height:26, background:"white", borderRadius:5, display:"flex", alignItems:"center", justifyContent:"center", color:"#1e293b", fontWeight:900, fontSize:11 }}>G</div>
                    <div><div style={{ fontSize:13, fontWeight:800 }}>GINI ADVANCED CARE HOSPITAL</div><div style={{ fontSize:9, opacity:.7 }}>Sector 69, Mohali | 0172-4120100</div></div>
                  </div>
                  <div style={{ textAlign:"right", fontSize:10 }}><div style={{ fontWeight:700 }}>{conName}</div><div style={{ opacity:.8 }}>Consultant</div></div>
                </div>
                <div style={{ borderTop:"1px solid rgba(255,255,255,.12)", marginTop:6, paddingTop:5, fontSize:12 }}>
                  <strong>{patient.name}</strong> | {patient.age}Y / {patient.sex} {patient.phone&&`| ${patient.phone}`} {patient.fileNo&&`| ${patient.fileNo}`}
                  <span style={{ float:"right", fontSize:11, fontWeight:700 }}>{(()=>{const ld=patientFullData?.consultations?.[0]?.visit_date;if(ld){const s=String(ld);const d=s.length>=10?new Date(s.slice(0,10)+"T12:00:00"):new Date(s);return d.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});}return new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});})()}</span>
                </div>
              </div>

              <div style={{ border:"1px solid #e2e8f0", borderTop:"none", borderRadius:"0 0 10px 10px", padding:14 }}>
                {/* Summary */}
                {!planHidden.has("summary") && conData?.assessment_summary && <div style={{ background:"linear-gradient(135deg,#eff6ff,#f0fdf4)", border:"1px solid #bfdbfe", borderRadius:8, padding:10, marginBottom:12, fontSize:12, color:"#334155", lineHeight:1.6, position:"relative" }}>
                  <button className="no-print" onClick={()=>toggleBlock("summary")} style={{ position:"absolute", top:4, right:4, background:"#fee2e2", border:"none", borderRadius:3, padding:"1px 5px", fontSize:9, cursor:"pointer", color:"#dc2626", fontWeight:700 }}>✕</button>
                  <strong style={{ color:"#1e40af" }}>📋 Dear {patient.name?patient.name.split(" ")[0]:"Patient"}:</strong>{" "}
                  <EditText value={getPlan("summary", conData.assessment_summary)} onChange={v=>editPlan("summary",v)} style={{ fontSize:12 }} />
                </div>}
                {planHidden.has("summary") && <div className="no-print" style={{ marginBottom:4, opacity:.4, cursor:"pointer", fontSize:10, color:"#94a3b8" }} onClick={()=>toggleBlock("summary")}>➕ Summary</div>}

                {/* Chief Complaints */}
                {(() => {
                  const skipPhrases = ["no gmi","no hypoglycemia","no hypoglycaemia","routine follow-up","follow-up visit","no complaints"];
                  const filtered = (moData?.chief_complaints||[]).filter(c => !skipPhrases.some(s => String(c).toLowerCase().includes(s)));
                  return filtered.length > 0 && <PlanBlock id="complaints" title="🗣️ Chief Complaints" color="#dc2626" hidden={planHidden.has("complaints")} onToggle={()=>toggleBlock("complaints")}>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                    {filtered.map((c,i) => (
                      <span key={i} style={{ fontSize:11, padding:"3px 8px", background:"#fef2f2", border:"1px solid #fecaca", borderRadius:6, color:"#dc2626", fontWeight:600 }}>⚠️ {c}</span>
                    ))}
                  </div>
                </PlanBlock>;
                })()}

                {/* Diagnoses */}
                {planDiags.length>0 && <PlanBlock id="diagnoses" title="🏥 Your Conditions" color="#1e293b" hidden={planHidden.has("diagnoses")} onToggle={()=>toggleBlock("diagnoses")}>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:3 }}>
                    {planDiags.map((d,i) => {
                      const origIdx = sa(moData,"diagnoses").indexOf(d);
                      return (
                      <div key={i} style={{ display:"flex", alignItems:"center", gap:4, padding:"4px 8px", background:(DC[d.id]||"#64748b")+"08", border:`1px solid ${(DC[d.id]||"#64748b")}22`, borderRadius:5, fontSize:11 }}>
                        <div style={{ width:6, height:6, borderRadius:"50%", background:DC[d.id]||"#64748b" }} />
                        <strong style={{ flex:1 }}>{FRIENDLY[d.id]||d.label}</strong>
                        <span style={{ fontSize:9, fontWeight:600, padding:"0 4px", borderRadius:6, background:d.status==="Uncontrolled"?"#fef2f2":"#f0fdf4", color:d.status==="Uncontrolled"?"#dc2626":"#059669" }}>{d.status}</span>
                        <RemoveBtn onClick={()=>removeDiag(origIdx)} />
                      </div>
                    );})}
                  </div>
                </PlanBlock>}

                {/* Vitals */}
                {vitals.bp_sys && <PlanBlock id="vitals" title="📊 Vitals" color="#ea580c" hidden={planHidden.has("vitals")} onToggle={()=>toggleBlock("vitals")}>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                    {[{l:"BP",v:vitals.bp_sys?`${vitals.bp_sys}/${vitals.bp_dia}`:null,suffix:vitals.bp2_sys?" (Sitting)":""},
                      {l:"BP Standing",v:vitals.bp2_sys?`${vitals.bp2_sys}/${vitals.bp2_dia}`:null},
                      {l:"Pulse",v:vitals.pulse},{l:"SpO2",v:vitals.spo2&&`${vitals.spo2}%`},{l:"Weight",v:vitals.weight&&`${vitals.weight}kg`},{l:"Height",v:vitals.height&&`${vitals.height}cm`},{l:"BMI",v:vitals.bmi},{l:"Waist",v:vitals.waist&&`${vitals.waist}cm`},{l:"Body Fat",v:vitals.body_fat&&`${vitals.body_fat}%`}].filter(x=>x.v&&x.v!=="/").map((x,i) => <span key={i} style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:4, padding:"2px 6px", fontSize:11 }}><strong style={{ color:"#9a3412" }}>{x.l}:</strong> {x.v}{x.suffix||""}</span>)}
                  </div>
                </PlanBlock>}

                {/* Goals */}
                {planGoals.length>0 && <PlanBlock id="goals" title="🎯 Your Health Goals" color="#059669" hidden={planHidden.has("goals")} onToggle={()=>toggleBlock("goals")}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11, border:"1px solid #bbf7d0" }}>
                    <thead><tr style={{ background:"#059669", color:"white" }}><th style={{padding:"4px 8px",textAlign:"left"}}>Marker</th><th style={{padding:"4px 8px"}}>Current</th><th style={{padding:"4px 8px"}}>Target</th><th style={{padding:"4px 8px"}}>By</th><th className="no-print" style={{padding:"4px 8px",width:20}}></th></tr></thead>
                    <tbody>{planGoals.map((g,i) => {
                      const origIdx = sa(conData,"goals").indexOf(g);
                      return <tr key={i} style={{ background:g.priority==="critical"?"#fef2f2":i%2?"#f0fdf4":"white" }}>
                        <td style={{padding:"3px 8px",fontWeight:600}}>{g.marker}</td>
                        <td style={{padding:"3px 8px",textAlign:"center",fontWeight:700,color:"#dc2626"}}>{g.current}</td>
                        <td style={{padding:"3px 8px",textAlign:"center",fontWeight:700,color:"#059669"}}>{g.target}</td>
                        <td style={{padding:"3px 8px",textAlign:"center",color:"#64748b"}}>{g.timeline}</td>
                        <td className="no-print" style={{padding:"3px 4px"}}><RemoveBtn onClick={()=>removeGoal(origIdx)} /></td>
                      </tr>;
                    })}</tbody>
                  </table>
                </PlanBlock>}

                {/* Medications */}
                {planMeds.length>0 && <PlanBlock id="meds" title="💊 Your Medications" color="#dc2626" hidden={planHidden.has("meds")} onToggle={()=>toggleBlock("meds")}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11, border:"1px solid #e2e8f0" }}>
                    <thead><tr style={{ background:"#1e293b", color:"white" }}><th style={{padding:"5px 8px",textAlign:"left"}}>Medicine</th><th style={{padding:"5px 8px"}}>Dose</th><th style={{padding:"5px 8px"}}>When to Take</th><th style={{padding:"5px 8px",textAlign:"left"}}>For</th><th className="no-print" style={{padding:"5px 8px",width:20}}></th></tr></thead>
                    <tbody>{planMeds.map((m,i) => {
                      const origIdx = allMeds.indexOf(m);
                      return <tr key={i} style={{ background:(m.isNew||m.resolved)?"#eff6ff":i%2?"#fafafa":"white" }}>
                        <td style={{padding:"4px 8px"}}><strong>{m.name}</strong>{m._matched&&<span title={`Pharmacy match: ${m._matched} (${m._confidence}%)`} style={{color:"#059669",fontSize:9,marginLeft:3}}>✓</span>}{(m.isNew||m.resolved)&&<span style={{background:"#1e40af",color:"white",padding:"0 3px",borderRadius:3,fontSize:8,marginLeft:3}}>NEW</span>}{m.composition&&<div style={{fontSize:9,color:"#94a3b8"}}>{m.composition}</div>}</td>
                        <td style={{padding:"4px 8px",textAlign:"center",fontWeight:600}}>{m.dose}</td>
                        <td style={{padding:"4px 8px",textAlign:"center",fontSize:10,fontWeight:600,color:"#1e40af"}}>{m.timing || m.frequency}</td>
                        <td style={{padding:"4px 8px"}}>{(m.forDiagnosis||[]).map(d=><Badge key={d} id={d} friendly />)}</td>
                        <td className="no-print" style={{padding:"4px 4px"}}><RemoveBtn onClick={()=>removeMed(origIdx)} /></td>
                      </tr>;
                    })}</tbody>
                  </table>
                </PlanBlock>}

                {/* Lifestyle */}
                {planLifestyle.length>0 && <PlanBlock id="lifestyle" title="🥗 Lifestyle Changes" color="#059669" hidden={planHidden.has("lifestyle")} onToggle={()=>toggleBlock("lifestyle")}>
                  {planLifestyle.map((l,i) => {
                    const origIdx = sa(conData,"diet_lifestyle").indexOf(l);
                    const isString = typeof l === "string";
                    return (
                    <div key={i} style={{ display:"flex", gap:5, padding:"3px 0", borderBottom:"1px solid #f1f5f9", fontSize:11, alignItems:"center" }}>
                      {!isString && l.category && <span style={{ fontSize:8, fontWeight:700, padding:"1px 4px", borderRadius:4, color:"white", background:l.category==="Critical"?"#dc2626":l.category==="Diet"?"#059669":"#2563eb", alignSelf:"flex-start", marginTop:2 }}>{l.category}</span>}
                      {isString
                        ? <div style={{ flex:1 }}>• {l}</div>
                        : <div style={{ flex:1 }}><strong>{l.advice}</strong>{l.detail ? ` — ${l.detail}` : ""} {(l.helps||[]).map(d=><Badge key={d} id={d} friendly />)}</div>
                      }
                      <RemoveBtn onClick={()=>removeLifestyle(origIdx)} />
                    </div>
                  );})}
                </PlanBlock>}

                {/* Self Monitoring */}
                {planMonitors.length>0 && <PlanBlock id="monitoring" title="📊 What to Monitor at Home" color="#2563eb" hidden={planHidden.has("monitoring")} onToggle={()=>toggleBlock("monitoring")}>
                  {planMonitors.map((sm,i) => {
                    const origIdx = sa(conData,"self_monitoring").indexOf(sm);
                    const isString = typeof sm === "string";
                    return (
                    <div key={i} style={{ marginBottom:6, background:"#eff6ff", borderRadius:6, padding:8, border:"1px solid #bfdbfe" }}>
                      <div style={{ display:"flex", justifyContent:"space-between" }}>
                        {isString
                          ? <div style={{ fontSize:11, fontWeight:600 }}>• {sm}</div>
                          : <>
                            <div style={{ fontSize:11, fontWeight:700, color:"#1e40af" }}>{sm.title}</div>
                            <RemoveBtn onClick={()=>removeMonitor(origIdx)} />
                          </>
                        }
                      </div>
                      {!isString && <>
                        {(sm.instructions||[]).map((ins,j) => <div key={j} style={{ fontSize:10, color:"#334155", paddingLeft:6 }}>• {ins}</div>)}
                        {sm.targets && <div style={{ fontSize:10, fontWeight:600, color:"#059669", marginTop:3 }}>🎯 Target: {sm.targets}</div>}
                        {sm.alert && <div style={{ fontSize:10, fontWeight:700, color:"#dc2626", marginTop:2 }}>⚠️ {sm.alert}</div>}
                      </>}
                    </div>);
                  })}
                </PlanBlock>}

                {/* Investigations Ordered */}
                {(conData?.investigations_ordered||conData?.investigations_to_order||[]).length > 0 && <PlanBlock id="investigations" title="🔬 Investigations Ordered" color="#7c3aed" hidden={planHidden.has("investigations")} onToggle={()=>toggleBlock("investigations")}>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                    {(conData.investigations_ordered||conData.investigations_to_order||[]).map((t,i) => (
                      <span key={i} style={{ background:"#f5f3ff", border:"1px solid #c4b5fd", borderRadius:4, padding:"2px 8px", fontSize:11, fontWeight:600, color:"#6d28d9" }}>{t}</span>
                    ))}
                  </div>
                  {conData?.follow_up?.instructions && (
                    <div style={{ marginTop:8, background:"#fefce8", border:"1px solid #fde68a", borderRadius:6, padding:8, fontSize:11, color:"#92400e", lineHeight:1.6 }}>
                      <div style={{ fontWeight:700, marginBottom:3 }}>📋 Instructions:</div>
                      {conData.follow_up.instructions.split(/\n|(?=\d\.)/).filter(Boolean).map((line,j) => (
                        <div key={j}>• {line.trim()}</div>
                      ))}
                    </div>
                  )}
                </PlanBlock>}

                {/* Insulin Education */}
                {conData?.insulin_education && <PlanBlock id="insulin" title="💉 Insulin Guide" color="#dc2626" hidden={planHidden.has("insulin")} onToggle={()=>toggleBlock("insulin")}>
                  <div style={{ border:"1px solid #fecaca", borderRadius:8, overflow:"hidden" }}>
                    <div style={{ background:"#dc2626", color:"white", padding:"6px 10px", fontSize:12, fontWeight:700 }}>
                      {conData.insulin_education.type} Insulin — {conData.insulin_education.device}
                    </div>
                    <div style={{ padding:10 }}>
                      <div style={{ marginBottom:8, background:"#f8fafc", borderRadius:6, padding:8, border:"1px solid #e2e8f0" }}>
                        <div style={{ fontSize:11, fontWeight:700, color:"#1e293b", marginBottom:4 }}>📋 How to Inject</div>
                        <div style={{ fontSize:11, lineHeight:1.8 }}>
                          {["Wash hands with soap", "Choose injection site: " + (conData.insulin_education.injection_sites||["Abdomen","Thigh"]).join(" or "), "Clean area with alcohol swab", "Pinch skin gently, insert needle at 90°", "Push plunger slowly, hold 10 seconds", "Release skin, remove needle", "Rotate injection site each time"].map((step,i) => (
                            <div key={i} style={{ display:"flex", gap:6, alignItems:"flex-start" }}>
                              <span style={{ background:"#dc2626", color:"white", borderRadius:"50%", width:18, height:18, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:800, flexShrink:0 }}>{i+1}</span>
                              <span>{step}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {conData.insulin_education.titration && (
                        <div style={{ marginBottom:8, background:"#fff7ed", borderRadius:6, padding:8, border:"1px solid #fed7aa" }}>
                          <div style={{ fontSize:11, fontWeight:700, color:"#9a3412", marginBottom:3 }}>📈 Dose Adjustment (Titration)</div>
                          <div style={{ fontSize:12, fontWeight:600 }}>{conData.insulin_education.titration}</div>
                          <table style={{ width:"100%", marginTop:6, borderCollapse:"collapse", fontSize:10, border:"1px solid #fed7aa" }}>
                            <thead><tr style={{ background:"#ea580c", color:"white" }}><th style={{ padding:"3px 6px" }}>Fasting Sugar</th><th style={{ padding:"3px 6px" }}>Action</th></tr></thead>
                            <tbody>
                              <tr><td style={{ padding:"2px 6px", border:"1px solid #fed7aa" }}>Above 130 mg/dL</td><td style={{ padding:"2px 6px", border:"1px solid #fed7aa", fontWeight:600, color:"#ea580c" }}>↑ Increase by 2 units</td></tr>
                              <tr><td style={{ padding:"2px 6px", border:"1px solid #fed7aa" }}>90-130 mg/dL</td><td style={{ padding:"2px 6px", border:"1px solid #fed7aa", fontWeight:600, color:"#059669" }}>✅ No change (at target)</td></tr>
                              <tr><td style={{ padding:"2px 6px", border:"1px solid #fed7aa" }}>Below 90 mg/dL</td><td style={{ padding:"2px 6px", border:"1px solid #fed7aa", fontWeight:600, color:"#dc2626" }}>↓ Decrease by 2 units</td></tr>
                              <tr style={{ background:"#fef2f2" }}><td style={{ padding:"2px 6px", border:"1px solid #fed7aa" }}>Below 70 mg/dL</td><td style={{ padding:"2px 6px", border:"1px solid #fed7aa", fontWeight:700, color:"#dc2626" }}>🚨 STOP — call doctor</td></tr>
                            </tbody>
                          </table>
                        </div>
                      )}
                      <div style={{ background:"#fef2f2", borderRadius:6, padding:8, border:"2px solid #dc2626", marginBottom:6 }}>
                        <div style={{ fontSize:11, fontWeight:800, color:"#dc2626", marginBottom:3 }}>🚨 LOW SUGAR EMERGENCY (Below 70 mg/dL)</div>
                        <div style={{ fontSize:11, lineHeight:1.8 }}>
                          <div>1️⃣ <strong>Eat 3 glucose tablets</strong> or 1 tablespoon sugar in water</div>
                          <div>2️⃣ <strong>Wait 15 minutes</strong>, recheck sugar</div>
                          <div>3️⃣ If still below 70 → <strong>repeat step 1</strong></div>
                          <div>4️⃣ Once above 70 → <strong>eat a snack</strong> (biscuits + milk)</div>
                          <div style={{ marginTop:4, fontWeight:700, color:"#dc2626" }}>⚠️ Always carry glucose tablets with you!</div>
                        </div>
                      </div>
                      <div style={{ display:"flex", gap:8, fontSize:10, color:"#64748b" }}>
                        <span>🧊 <strong>Storage:</strong> {conData.insulin_education.storage || "Keep in fridge, room temp vial valid 28 days"}</span>
                        <span>🗑️ <strong>Needles:</strong> {conData.insulin_education.needle_disposal || "Use sharps container, never reuse"}</span>
                      </div>
                    </div>
                  </div>
                </PlanBlock>}

                {/* Follow Up */}
                {conData?.follow_up && <PlanBlock id="followup" title="📅 Follow Up" color="#1e293b" hidden={planHidden.has("followup")} onToggle={()=>toggleBlock("followup")}>
                  <div style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                    <div style={{ background:"#f8fafc", border:"2px solid #1e293b", borderRadius:6, padding:"6px 14px", textAlign:"center" }}>
                      <div style={{ fontSize:8, color:"#64748b" }}>NEXT VISIT</div>
                      <div style={{ fontSize:18, fontWeight:800 }}><EditText value={getPlan("followup_dur", conData.follow_up.duration?.toUpperCase()||conData.follow_up.date||"")} onChange={v=>editPlan("followup_dur",v)} style={{ fontSize:18, fontWeight:800 }} /></div>
                    </div>
                    <div style={{ flex:1 }}>
                      {(conData.follow_up.tests_to_bring||conData.investigations_ordered||conData.investigations_to_order||[]).length > 0 && (
                        <div><div style={{ fontSize:11, fontWeight:600, marginBottom:2 }}>Please bring these reports:</div><div style={{ display:"flex", flexWrap:"wrap", gap:2 }}>{(conData.follow_up.tests_to_bring||conData.investigations_ordered||conData.investigations_to_order||[]).map((t,i) => <span key={i} style={{ background:"white", border:"1px solid #e2e8f0", borderRadius:3, padding:"1px 5px", fontSize:10, fontWeight:600 }}>{t}</span>)}</div></div>
                      )}
                    </div>
                  </div>
                </PlanBlock>}

                {/* Future Plan */}
                {planFuture.length>0 && <PlanBlock id="future" title="📋 Future Plan" color="#7c3aed" hidden={planHidden.has("future")} onToggle={()=>toggleBlock("future")}>
                  {planFuture.map((fp,i) => {
                    const origIdx = sa(conData,"future_plan").indexOf(fp);
                    return <div key={i} style={{ fontSize:11, padding:"2px 0", display:"flex", alignItems:"center", gap:4 }}>
                      <div style={{ flex:1 }}><strong>If</strong> {fp.condition} → {fp.action}</div>
                      <RemoveBtn onClick={()=>removeFuture(origIdx)} />
                    </div>;
                  })}
                </PlanBlock>}

                {/* Footer */}
                <div style={{ borderTop:"2px solid #1e293b", paddingTop:6, display:"flex", justifyContent:"space-between", fontSize:10, color:"#94a3b8" }}>
                  <div>{conName} | MO: {moName} | 📞 0172-4120100</div>
                  <div>Gini Clinical Scribe v1</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}} @media print{button,.no-print{display:none!important}} .editable-hover:hover{border-bottom-color:#3b82f6!important;background:#eff6ff}`}</style>

      {/* ===== HISTORY ENTRY ===== */}
      {tab==="history" && (
        <div>
          {!dbPatientId ? (
            <div style={{ textAlign:"center", padding:30, color:"#94a3b8" }}>
              <div style={{ fontSize:28, marginBottom:8 }}>📜</div>
              <div style={{ fontSize:13, fontWeight:600 }}>Load a patient from the database first</div>
              <div style={{ fontSize:11, marginTop:4 }}>Use 🔍 Find to search and select a patient, or save a consultation first</div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize:14, fontWeight:700, marginBottom:8, color:"#1e293b" }}>📜 Add Past Record — {patient.name}</div>

              {/* Past consultations list */}
              {historyList.length > 0 && (
                <div style={{ marginBottom:10, background:"#f8fafc", borderRadius:8, padding:8, border:"1px solid #e2e8f0" }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#64748b", marginBottom:4 }}>VISIT HISTORY ({historyList.length})</div>
                  {historyList.slice(0,20).map((c,i) => (
                    <div key={i} style={{ display:"flex", gap:8, padding:"3px 0", fontSize:10, borderBottom:i<Math.min(historyList.length,20)-1?"1px solid #f1f5f9":"none" }}>
                      <span style={{ fontWeight:600, color:"#2563eb", minWidth:70 }}>{(()=>{const s=String(c.visit_date||"");const dt=s.length>=10?new Date(s.slice(0,10)+"T12:00:00"):new Date(s);return dt.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});})()}</span>
                      <span style={{ color:"#64748b" }}>{c.visit_type||"OPD"}</span>
                      <span style={{ color:"#374151" }}>{c.con_name||c.mo_name||""}</span>
                      <span style={{ marginLeft:"auto", fontSize:8, color:c.status==="completed"?"#059669":c.status==="historical"?"#64748b":"#f59e0b", fontWeight:600 }}>{c.status}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Mode tabs */}
              <div style={{ display:"flex", gap:0, marginBottom:8, borderRadius:6, overflow:"hidden", border:"1px solid #e2e8f0" }}>
                {[["rx","📝 Prescription"],["report","🧪 Reports"],["manual","📋 Manual"]].map(([id,label]) => (
                  <button key={id} onClick={()=>setHxMode(id)} style={{ flex:1, padding:"6px", fontSize:10, fontWeight:700, border:"none", cursor:"pointer",
                    background:hxMode===id?"#2563eb":"white", color:hxMode===id?"white":"#64748b" }}>{label}</button>
                ))}
              </div>

              {/* Visit Info — always visible */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:4, marginBottom:8 }}>
                <div>
                  <label style={{ fontSize:8, fontWeight:600, color:"#64748b" }}>Date *</label>
                  <input type="date" value={historyForm.visit_date} onChange={e=>setHistoryForm(p=>({...p,visit_date:e.target.value}))}
                    style={{ width:"100%", padding:"3px 5px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:10, boxSizing:"border-box" }} />
                </div>
                <div>
                  <label style={{ fontSize:8, fontWeight:600, color:"#64748b" }}>Type</label>
                  <select value={historyForm.visit_type} onChange={e=>setHistoryForm(p=>({...p,visit_type:e.target.value}))}
                    style={{ width:"100%", padding:"3px 5px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:10, boxSizing:"border-box" }}>
                    <option>OPD</option><option>IPD</option><option>Follow-up</option><option>Emergency</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize:8, fontWeight:600, color:"#64748b" }}>Specialty</label>
                  <select value={historyForm.specialty} onChange={e=>setHistoryForm(p=>({...p,specialty:e.target.value}))}
                    style={{ width:"100%", padding:"3px 5px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:10, boxSizing:"border-box" }}>
                    <option value="">Select...</option>
                    <option>Endocrinology</option><option>Cardiology</option><option>Nephrology</option><option>Neurology</option>
                    <option>General Medicine</option><option>Orthopedics</option><option>Ophthalmology</option><option>Pulmonology</option>
                    <option>Gastroenterology</option><option>Dermatology</option><option>Psychiatry</option><option>Gynecology</option>
                    <option>Urology</option><option>ENT</option><option>Surgery</option><option>Other</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize:8, fontWeight:600, color:"#64748b" }}>Doctor</label>
                  {doctorsList.length > 0 ? (
                    <select value={historyForm.doctor_name} onChange={e=>setHistoryForm(p=>({...p,doctor_name:e.target.value}))}
                      style={{ width:"100%", padding:"3px 5px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:10, boxSizing:"border-box", background:"white" }}>
                      <option value="">Select Doctor</option>
                      {doctorsList.map(d => <option key={d.id} value={d.short_name}>{d.name}</option>)}
                      <option value="_other">— Other/External —</option>
                    </select>
                  ) : (
                    <input value={historyForm.doctor_name} onChange={e=>setHistoryForm(p=>({...p,doctor_name:e.target.value}))} placeholder="Dr. Name"
                      style={{ width:"100%", padding:"3px 5px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:10, boxSizing:"border-box" }} />
                  )}
                </div>
              </div>

              {/* ===== PRESCRIPTION MODE ===== */}
              {hxMode==="rx" && (
                <div style={{ background:"white", borderRadius:8, padding:10, border:"1px solid #e2e8f0" }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#2563eb", marginBottom:4 }}>📝 PASTE OR DICTATE OLD PRESCRIPTION</div>
                  <div style={{ fontSize:9, color:"#94a3b8", marginBottom:6 }}>Paste prescription text, type from the slip, or use voice recording. Claude will auto-extract diagnoses, medications, vitals.</div>
                  <AudioInput label="Dictate prescription" dgKey={dgKey} whisperKey={whisperKey} color="#2563eb" compact
                    onTranscript={t=>setRxText(prev => prev ? prev + "\n" + t : t)} />
                  <textarea value={rxText} onChange={e=>setRxText(e.target.value)} placeholder={"Paste prescription here...\n\nExample:\nDr. Sharma - Endocrinology\nDx: Type 2 DM (uncontrolled), HTN\nBP: 150/90, Wt: 78kg\nRx:\n1. Tab Metformin 500mg BD\n2. Tab Glimepiride 2mg OD before breakfast\n3. Tab Telmisartan 40mg OD morning\nAdv: HbA1c after 3 months\nF/U: 6 weeks"}
                    style={{ width:"100%", minHeight:120, padding:8, border:"1px solid #e2e8f0", borderRadius:6, fontSize:11, fontFamily:"monospace", resize:"vertical", marginTop:6, boxSizing:"border-box" }} />
                  <button onClick={extractPrescription} disabled={rxExtracting || !rxText.trim()}
                    style={{ marginTop:6, width:"100%", padding:"8px", background:rxExtracting?"#6b7280":rxExtracted?"#059669":"#2563eb", color:"white", border:"none", borderRadius:6, fontWeight:700, fontSize:12, cursor:rxExtracting?"wait":"pointer" }}>
                    {rxExtracting ? "🔬 Extracting..." : rxExtracted ? "✅ Extracted — Re-extract" : "🔬 Extract from Prescription"}
                  </button>

                  {/* Show extracted data */}
                  {rxExtracted && (
                    <div style={{ marginTop:8, background:"#f0fdf4", borderRadius:6, padding:8, border:"1px solid #bbf7d0" }}>
                      <div style={{ fontSize:9, fontWeight:700, color:"#059669", marginBottom:4 }}>✅ EXTRACTED — Review & edit below, then Save</div>
                    </div>
                  )}
                </div>
              )}

              {/* ===== REPORT MODE ===== */}
              {hxMode==="report" && (
                <div style={{ background:"white", borderRadius:8, padding:10, border:"1px solid #e2e8f0" }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#7c3aed", marginBottom:4 }}>🧪 UPLOAD TEST REPORTS</div>
                  <div style={{ fontSize:9, color:"#94a3b8", marginBottom:8 }}>Upload photos or PDFs of test reports. Claude will extract values automatically.</div>

                  {/* Upload area */}
                  <div style={{ display:"flex", gap:4, marginBottom:8, alignItems:"center" }}>
                    <select id="reportType" defaultValue="Blood Test" style={{ flex:1, padding:"6px 8px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:11, fontWeight:600 }}>
                      <option>Blood Test</option><option>HbA1c</option><option>Thyroid Panel</option><option>Lipid Profile</option>
                      <option>Kidney Function</option><option>Liver Function</option><option>CBC</option><option>Urine</option>
                      <option>X-Ray</option><option>Ultrasound</option><option>MRI</option><option>DEXA</option>
                      <option>ABI</option><option>VPT</option><option>ECG</option><option>Doppler</option><option>Retinopathy</option><option>Other</option>
                    </select>
                    <label style={{ display:"flex", alignItems:"center", gap:4, padding:"6px 12px", background:"#7c3aed", color:"white", borderRadius:6, cursor:"pointer", fontSize:11, fontWeight:700, whiteSpace:"nowrap" }}>
                      📷 Upload
                      <input type="file" accept="image/*,.pdf" style={{ display:"none" }} onChange={e=>handleReportFile(e, document.getElementById("reportType").value)} />
                    </label>
                  </div>

                  {/* Uploaded reports */}
                  {reports.map((r,i) => (
                    <div key={i} style={{ marginBottom:8, background:r.extracted?"#f0fdf4":"#f8fafc", borderRadius:6, padding:8, border:`1px solid ${r.extracted?"#bbf7d0":r.error?"#fecaca":"#e2e8f0"}` }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                        <div style={{ fontSize:11, fontWeight:700 }}>
                          <span style={{ background:"#7c3aed", color:"white", padding:"1px 6px", borderRadius:3, fontSize:9, marginRight:6 }}>{r.type}</span>
                          {r.fileName}
                        </div>
                        <div style={{ display:"flex", gap:4 }}>
                          {!r.extracted && !r.extracting && (
                            <button onClick={()=>extractReport(i)} style={{ fontSize:9, padding:"2px 8px", background:"#7c3aed", color:"white", border:"none", borderRadius:4, fontWeight:700, cursor:"pointer" }}>
                              🔬 Extract
                            </button>
                          )}
                          <button onClick={()=>removeReport(i)} style={{ fontSize:10, padding:"2px 6px", background:"none", border:"1px solid #fecaca", borderRadius:3, cursor:"pointer", color:"#dc2626" }}>×</button>
                        </div>
                      </div>
                      {r.extracting && <div style={{ fontSize:10, color:"#7c3aed", fontWeight:600 }}>🔬 Extracting values...</div>}
                      {r.error && <div style={{ fontSize:10, color:"#dc2626" }}>❌ {r.error}</div>}
                      {r.extracted && (
                        <div>
                          <div style={{ fontSize:9, color:"#059669", fontWeight:600, marginBottom:2 }}>
                            ✅ {r.extracted.tests?.length || 0} tests extracted
                            {r.extracted.report_date && ` • ${r.extracted.report_date}`}
                            {r.extracted.lab_name && ` • ${r.extracted.lab_name}`}
                          </div>
                          <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                            {(r.extracted.tests||[]).slice(0,12).map((t,ti) => (
                              <span key={ti} style={{ fontSize:8, padding:"1px 5px", borderRadius:3, fontWeight:600,
                                background:t.flag==="HIGH"?"#fef2f2":t.flag==="LOW"?"#eff6ff":"#f0fdf4",
                                color:t.flag==="HIGH"?"#dc2626":t.flag==="LOW"?"#2563eb":"#059669",
                                border:`1px solid ${t.flag==="HIGH"?"#fecaca":t.flag==="LOW"?"#bfdbfe":"#bbf7d0"}` }}>
                                {t.test_name}: {t.result}{t.unit} {t.flag||"✓"}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ===== EXTRACTED / MANUAL DATA ===== */}
              <div style={{ background:"white", borderRadius:8, padding:10, border:"1px solid #e2e8f0", marginTop:8 }}>
                <div style={{ fontSize:10, fontWeight:700, color:"#64748b", marginBottom:6 }}>
                  {hxMode==="manual" ? "📋 MANUAL ENTRY" : "📋 REVIEW EXTRACTED DATA"}
                </div>

                {/* Vitals */}
                <div style={{ fontSize:9, fontWeight:700, color:"#94a3b8", marginBottom:3 }}>VITALS</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr", gap:3, marginBottom:8 }}>
                  {[["bp_sys","BP Sys"],["bp_dia","BP Dia"],["pulse","Pulse"],["weight","Wt (kg)"],["height","Ht (cm)"]].map(([k,l]) => (
                    <div key={k}>
                      <label style={{ fontSize:7, color:"#94a3b8" }}>{l}</label>
                      <input value={historyForm.vitals[k]||""} onChange={e=>setHistoryForm(p=>({...p,vitals:{...p.vitals,[k]:e.target.value}}))}
                        style={{ width:"100%", padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:10, boxSizing:"border-box" }} />
                    </div>
                  ))}
                </div>

                {/* Diagnoses */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
                  <div style={{ fontSize:9, fontWeight:700, color:"#94a3b8" }}>DIAGNOSES</div>
                  <button onClick={()=>addHistoryRow("diagnoses")} style={{ fontSize:8, padding:"1px 5px", border:"1px solid #e2e8f0", borderRadius:3, cursor:"pointer", background:"white" }}>+</button>
                </div>
                {historyForm.diagnoses.map((d,i) => (
                  <div key={i} style={{ display:"grid", gridTemplateColumns:"70px 1fr 85px 20px", gap:3, marginBottom:2 }}>
                    <input value={d.id} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.diagnoses=[...n.diagnoses];n.diagnoses[i]={...n.diagnoses[i],id:v};return n;});}} placeholder="dm2"
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:9, boxSizing:"border-box" }} />
                    <input value={d.label} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.diagnoses=[...n.diagnoses];n.diagnoses[i]={...n.diagnoses[i],label:v};return n;});}} placeholder="Type 2 DM (since 2015)"
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:9, boxSizing:"border-box" }} />
                    <select value={d.status} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.diagnoses=[...n.diagnoses];n.diagnoses[i]={...n.diagnoses[i],status:v};return n;});}}
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:8, boxSizing:"border-box" }}>
                      <option>New</option><option>Controlled</option><option>Uncontrolled</option>
                    </select>
                    <button onClick={()=>removeHistoryRow("diagnoses",i)} style={{ fontSize:11, cursor:"pointer", border:"none", background:"none", color:"#dc2626", padding:0 }}>×</button>
                  </div>
                ))}

                {/* Medications */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3, marginTop:6 }}>
                  <div style={{ fontSize:9, fontWeight:700, color:"#94a3b8" }}>MEDICATIONS</div>
                  <button onClick={()=>addHistoryRow("medications")} style={{ fontSize:8, padding:"1px 5px", border:"1px solid #e2e8f0", borderRadius:3, cursor:"pointer", background:"white" }}>+</button>
                </div>
                {historyForm.medications.map((m,i) => (
                  <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr 60px 50px 70px 20px", gap:3, marginBottom:2 }}>
                    <input value={m.name} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.medications=[...n.medications];n.medications[i]={...n.medications[i],name:v};return n;});}} placeholder="THYRONORM 88MCG"
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:9, boxSizing:"border-box" }} />
                    <input value={m.dose} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.medications=[...n.medications];n.medications[i]={...n.medications[i],dose:v};return n;});}} placeholder="88mcg"
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:9, boxSizing:"border-box" }} />
                    <input value={m.frequency} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.medications=[...n.medications];n.medications[i]={...n.medications[i],frequency:v};return n;});}} placeholder="OD"
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:9, boxSizing:"border-box" }} />
                    <input value={m.timing} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.medications=[...n.medications];n.medications[i]={...n.medications[i],timing:v};return n;});}} placeholder="Morning"
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:9, boxSizing:"border-box" }} />
                    <button onClick={()=>removeHistoryRow("medications",i)} style={{ fontSize:11, cursor:"pointer", border:"none", background:"none", color:"#dc2626", padding:0 }}>×</button>
                  </div>
                ))}

                {/* Lab Results */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3, marginTop:6 }}>
                  <div style={{ fontSize:9, fontWeight:700, color:"#94a3b8" }}>LAB RESULTS</div>
                  <button onClick={()=>addHistoryRow("labs")} style={{ fontSize:8, padding:"1px 5px", border:"1px solid #e2e8f0", borderRadius:3, cursor:"pointer", background:"white" }}>+</button>
                </div>
                {historyForm.labs.map((l,i) => (
                  <div key={i} style={{ display:"grid", gridTemplateColumns:"1fr 55px 40px 45px 70px 20px", gap:3, marginBottom:2 }}>
                    <input value={l.test_name} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.labs=[...n.labs];n.labs[i]={...n.labs[i],test_name:v};return n;});}} placeholder="HbA1c"
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:9, boxSizing:"border-box" }} />
                    <input value={l.result} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.labs=[...n.labs];n.labs[i]={...n.labs[i],result:v};return n;});}} placeholder="8.2"
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:9, boxSizing:"border-box" }} />
                    <input value={l.unit} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.labs=[...n.labs];n.labs[i]={...n.labs[i],unit:v};return n;});}} placeholder="%"
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:9, boxSizing:"border-box" }} />
                    <select value={l.flag} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.labs=[...n.labs];n.labs[i]={...n.labs[i],flag:v};return n;});}}
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:8, boxSizing:"border-box" }}>
                      <option value="">OK</option><option>HIGH</option><option>LOW</option>
                    </select>
                    <input value={l.ref_range} onChange={e=>{const v=e.target.value;setHistoryForm(p=>{const n={...p};n.labs=[...n.labs];n.labs[i]={...n.labs[i],ref_range:v};return n;});}} placeholder="<6.5"
                      style={{ padding:"2px 4px", border:"1px solid #e2e8f0", borderRadius:3, fontSize:9, boxSizing:"border-box" }} />
                    <button onClick={()=>removeHistoryRow("labs",i)} style={{ fontSize:11, cursor:"pointer", border:"none", background:"none", color:"#dc2626", padding:0 }}>×</button>
                  </div>
                ))}
              </div>

              {/* Save button */}
              <button onClick={saveHistoryEntry} disabled={historySaving || !historyForm.visit_date}
                style={{ marginTop:8, width:"100%", padding:"10px", background:historyForm.visit_date?"#2563eb":"#e2e8f0", color:historyForm.visit_date?"white":"#94a3b8", border:"none", borderRadius:6, fontWeight:700, fontSize:13, cursor:historyForm.visit_date?"pointer":"default" }}>
                {historySaving ? "💾 Saving..." : "💾 Save Historical Visit"}
              </button>
            </div>
          )}
        </div>
      )}



      {/* ===== OUTCOMES ===== */}
      {tab==="outcomes" && (
        <div style={{ maxWidth:920, margin:"0 auto" }}>
          {!dbPatientId ? (
            <div style={{ textAlign:"center", padding:50, color:"#94a3b8" }}>
              <div style={{ fontSize:40, marginBottom:12 }}>📊</div>
              <div style={{ fontSize:15, fontWeight:600, color:"#64748b" }}>Load a patient first</div>
              <div style={{ fontSize:12, color:"#cbd5e1", marginTop:6 }}>Use 🔍 Find to search existing patients</div>
            </div>
          ) : outcomesLoading ? (
            <div style={{ textAlign:"center", padding:50 }}>
              <div style={{ fontSize:28, marginBottom:10 }}>⏳</div>
              <div style={{ fontSize:13, color:"#94a3b8" }}>Loading health data...</div>
            </div>
          ) : (
            <div>
              {/* ── HEADER ── */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                <div>
                  <div style={{ fontSize:20, fontWeight:800, color:"#0f172a", letterSpacing:"-0.5px" }}>Health Dashboard</div>
                  <div style={{ fontSize:12, color:"#64748b", marginTop:2 }}>{patient.name}{patient.age ? ` · ${patient.age}y` : ""}{patient.sex ? ` · ${patient.sex}` : ""}</div>
                </div>
                <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                  <div style={{ display:"flex", borderRadius:8, overflow:"hidden", border:"1px solid #e2e8f0" }}>
                    {[["3m","3M"],["6m","6M"],["1y","1Y"],["all","All"]].map(([v,l]) => (
                      <button key={v} onClick={()=>{setOutcomePeriod(v);fetchOutcomes(dbPatientId,v);}}
                        style={{ padding:"5px 12px", fontSize:11, fontWeight:700, border:"none", cursor:"pointer",
                          background:outcomePeriod===v?"#0f172a":"white", color:outcomePeriod===v?"white":"#64748b", transition:"all 0.15s" }}>{l}</button>
                    ))}
                  </div>
                  <button onClick={()=>fetchOutcomes(dbPatientId)} title="Refresh"
                    style={{ fontSize:14, padding:"4px 8px", border:"1px solid #e2e8f0", borderRadius:8, cursor:"pointer", background:"white", color:"#64748b" }}>↻</button>
                </div>
              </div>

              {/* ── SUMMARY CARDS ── */}
              {patientFullData && (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:10, marginBottom:20 }}>
                  {[
                    { label:"Visits", value:patientFullData.consultations?.length||0, icon:"📋", bg:"linear-gradient(135deg,#eff6ff,#dbeafe)", color:"#1d4ed8" },
                    { label:"Active Meds", value:(()=>{const seen=new Set();return(patientFullData.medications||[]).filter(m=>{if(!m.is_active)return false;const k=(m.name||"").toUpperCase();if(seen.has(k))return false;seen.add(k);return true}).length})(), icon:"💊", bg:"linear-gradient(135deg,#f0fdf4,#dcfce7)", color:"#059669" },
                    { label:"Diagnoses", value:(()=>{const seen=new Set();return(patientFullData.diagnoses||[]).filter(d=>{const k=d.diagnosis_id||d.label;if(seen.has(k))return false;seen.add(k);return true}).length})(), icon:"🩺", bg:"linear-gradient(135deg,#fffbeb,#fef3c7)", color:"#d97706" },
                    { label:"Lab Tests", value:patientFullData.lab_results?.length||0, icon:"🧪", bg:"linear-gradient(135deg,#fdf2f8,#fce7f3)", color:"#db2777" },
                  ].map((c,i) => (
                    <div key={i} style={{ background:c.bg, borderRadius:14, padding:"12px 14px", textAlign:"center" }}>
                      <div style={{ fontSize:9, color:"#64748b", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.6px" }}>{c.icon} {c.label}</div>
                      <div style={{ fontSize:24, fontWeight:900, color:c.color, marginTop:3 }}>{c.value}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── AI HEALTH SUMMARY ── */}
              <div style={{ background:"linear-gradient(135deg,#f0f9ff,#e0f2fe)", borderRadius:16, padding:16, marginBottom:20, border:"1px solid #bae6fd" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:healthSummary?10:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:16 }}>🤖</span>
                    <span style={{ fontSize:13, fontWeight:700, color:"#0c4a6e" }}>AI Health Summary</span>
                  </div>
                  <button onClick={generateHealthSummary} disabled={summaryLoading}
                    style={{ fontSize:11, padding:"5px 14px", border:"none", borderRadius:8, cursor:summaryLoading?"wait":"pointer",
                      background:summaryLoading?"#94a3b8":"#0369a1", color:"white", fontWeight:700 }}>
                    {summaryLoading ? "⏳ Analyzing..." : healthSummary ? "↻ Regenerate" : "✨ Generate Summary"}
                  </button>
                </div>
                {healthSummary && (
                  <div style={{ fontSize:13, lineHeight:"1.7", color:"#0c4a6e", marginTop:6, background:"white", borderRadius:10, padding:12 }}>{healthSummary}</div>
                )}
              </div>

              {/* ═══════════════════════════════════════════════ */}
              {/* ── BIOMARKER CHARTS (Clickable, Filtered Meds) */}
              {/* ═══════════════════════════════════════════════ */}
              {outcomesData && (() => {
                // Build per-visit context for drill-down
                const visitCtxByDate = {};
                (outcomesData.visits || []).forEach(v => {
                  const d = (v.visit_date||"").split("T")[0];
                  visitCtxByDate[d] = {
                    lifestyle: v.lifestyle || [],
                    compliance: v.compliance || "",
                    symptoms: (v.symptoms || v.chief_complaints || []).filter(s => !["no gmi","no hypoglycemia","no hypoglycaemia","routine follow-up","follow-up visit","no complaints"].some(x => String(s).toLowerCase().includes(x))),
                    summary: v.summary || "",
                    doctor: v.con_name || v.mo_name || "",
                    meds_confirmed: v.medications_confirmed || []
                  };
                });
                // Per-visit all meds (from med_timeline)
                const allMedsByDate = {};
                (outcomesData.med_timeline || []).forEach(m => {
                  const d = (m.visit_date||"").split("T")[0];
                  if (!allMedsByDate[d]) allMedsByDate[d] = [];
                  allMedsByDate[d].push(m);
                });

                const renderSection = (title, icon, color, charts) => {
                  const hasData = charts.some(c => c.data?.length > 0);
                  if (!hasData) return null;
                  return (
                    <div key={title} style={{ marginBottom:20 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
                        <span style={{ fontSize:14 }}>{icon}</span>
                        <span style={{ fontSize:12, fontWeight:800, color, textTransform:"uppercase", letterSpacing:"0.5px" }}>{title}</span>
                      </div>
                      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                        {charts.map((c, ci) => {
                          if (!c.data?.length) return null;
                          const bioKey = c.biomarkerKey || c.label.toLowerCase().replace(/[^a-z]/g,"");
                          const isExpanded = expandedBiomarker === `${title}-${ci}`;
                          return (
                            <div key={ci} style={{ gridColumn: isExpanded ? "1 / -1" : "auto",
                              background:"white", borderRadius:14, border: isExpanded ? "2px solid "+c.color : "1px solid #f1f5f9",
                              boxShadow: isExpanded ? "0 4px 12px rgba(0,0,0,0.08)" : "0 1px 3px rgba(0,0,0,0.04)",
                              overflow:"hidden", cursor:"pointer", transition:"all 0.2s" }}
                              onClick={()=>setExpandedBiomarker(isExpanded ? null : `${title}-${ci}`)}>
                              <div style={{ padding: isExpanded ? 14 : 0 }}>
                                <Sparkline data={c.data} label={c.label} unit={c.unit} color={c.color} target={c.target} valueKey={c.valueKey} lowerBetter={c.lowerBetter} />
                              </div>
                              {/* Expanded: filtered context per reading */}
                              {isExpanded && (
                                <div style={{ borderTop:"1px solid #f1f5f9", padding:14, background:"#fafbfc" }}
                                  onClick={e => e.stopPropagation()}>
                                  <div style={{ fontSize:11, fontWeight:700, color:"#475569", marginBottom:10 }}>📋 What was happening at each reading:</div>
                                  {c.data.slice().reverse().map((dp, di) => {
                                    const dateKey = (dp.test_date || dp.date || "").split("T")[0];
                                    const ctx = visitCtxByDate[dateKey] || {};
                                    const allMeds = allMedsByDate[dateKey] || [];
                                    // Filter to RELEVANT meds only
                                    const relevantMeds = getMedsForBiomarker(bioKey, allMeds.map(m=>m.pharmacy_match||m.name));
                                    // Filter lifestyle by helps array matching biomarker
                                    const relevantLifestyle = (Array.isArray(ctx.lifestyle) ? ctx.lifestyle : []).filter(l => {
                                      if (typeof l === "object" && l.helps) {
                                        const helpSet = (l.helps||[]).join(",").toLowerCase();
                                        if (bioKey === "hba1c" || bioKey === "fpg") return helpSet.includes("dm");
                                        if (bioKey === "bp") return helpSet.includes("htn");
                                        if (bioKey === "ldl" || bioKey === "triglycerides" || bioKey === "hdl") return helpSet.includes("dyslipidemia") || helpSet.includes("lipid");
                                        if (bioKey === "weight") return helpSet.includes("obesity") || helpSet.includes("dm");
                                        if (bioKey === "tsh") return helpSet.includes("hypo");
                                      }
                                      return true; // show string-type lifestyle items
                                    });
                                    const val = dp[c.valueKey||"result"];
                                    const s = String(dateKey||""); const fd = s.length>=10?new Date(s.slice(0,10)+"T12:00:00"):new Date(s);
                                    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                                    const dateStr = dateKey ? `${fd.getDate()} ${months[fd.getMonth()]} ${fd.getFullYear()}` : "";
                                    return (
                                      <div key={di} style={{ padding:"10px 0", borderBottom: di < c.data.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                                          <div style={{ display:"flex", alignItems:"baseline", gap:6 }}>
                                            <span style={{ fontSize:18, fontWeight:800, color:c.color }}>{val}{c.unit}</span>
                                            {ctx.doctor && <span style={{ fontSize:10, color:"#94a3b8" }}>👨‍⚕️ {ctx.doctor.startsWith("Dr")?ctx.doctor:"Dr. "+ctx.doctor}</span>}
                                          </div>
                                          <span style={{ fontSize:12, color:"#475569", fontWeight:700, background:"#f1f5f9", padding:"3px 10px", borderRadius:8 }}>{dateStr}</span>
                                        </div>
                                        {ctx.compliance && <div style={{ marginBottom:4 }}>
                                          <span style={{ padding:"2px 8px", borderRadius:10, fontWeight:700, fontSize:9,
                                            background:(ctx.compliance+"").startsWith("Good")?"#dcfce7":(ctx.compliance+"").startsWith("Poor")?"#fef2f2":"#fef3c7",
                                            color:(ctx.compliance+"").startsWith("Good")?"#059669":(ctx.compliance+"").startsWith("Poor")?"#dc2626":"#d97706" }}>
                                            {ctx.compliance}
                                          </span>
                                        </div>}
                                        {relevantMeds.length > 0 && (
                                          <div style={{ marginBottom:4 }}>
                                            <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600, marginBottom:2 }}>PROTOCOL:</div>
                                            <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                                              {relevantMeds.map((m,mi) => (
                                                <span key={mi} style={{ fontSize:9, padding:"2px 6px", borderRadius:8, background:"#f0fdf4", color:"#059669", border:"1px solid #bbf7d0", fontWeight:600 }}>💊 {m}</span>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                        {relevantLifestyle.length > 0 && (
                                          <div style={{ display:"flex", flexWrap:"wrap", gap:3, marginBottom:3 }}>
                                            {relevantLifestyle.map((l,li) => (
                                              <span key={li} style={{ fontSize:9, padding:"2px 6px", borderRadius:8, background:"#eff6ff", color:"#2563eb", fontWeight:600 }}>
                                                {typeof l === "object" ? l.advice : l}
                                              </span>
                                            ))}
                                          </div>
                                        )}
                                        {(ctx.symptoms||[]).length > 0 && (
                                          <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                                            {ctx.symptoms.map((s,si) => (
                                              <span key={si} style={{ fontSize:9, padding:"2px 6px", borderRadius:8, background:"#fef2f2", color:"#dc2626", fontWeight:600 }}>⚠️ {s}</span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                };

                return (
                  <>
                    {renderSection("Diabetes & Metabolic", "🩸", "#b91c1c", [
                      { data:outcomesData.hba1c, label:"HbA1c", unit:"%", color:"#dc2626", target:6.5, biomarkerKey:"hba1c" },
                      { data:outcomesData.fpg, label:"Fasting Glucose", unit:" mg/dl", color:"#ea580c", target:100, biomarkerKey:"fpg" },
                      { data:outcomesData.bp, label:"BP (Systolic)", unit:" mmHg", color:"#7c3aed", target:130, valueKey:"bp_sys", biomarkerKey:"bp" },
                      { data:outcomesData.weight, label:"Weight", unit:" kg", color:"#2563eb", valueKey:"weight", biomarkerKey:"weight" },
                    ])}
                    {renderSection("Lipids & Kidney", "💧", "#1d4ed8", [
                      { data:outcomesData.ldl, label:"LDL", unit:" mg/dl", color:"#d97706", target:100, biomarkerKey:"ldl" },
                      { data:outcomesData.triglycerides, label:"Triglycerides", unit:" mg/dl", color:"#b45309", target:150, biomarkerKey:"triglycerides" },
                      { data:outcomesData.hdl, label:"HDL", unit:" mg/dl", color:"#059669", target:40, lowerBetter:false, biomarkerKey:"hdl" },
                      { data:outcomesData.egfr, label:"eGFR", unit:" ml/min", color:"#0d9488", target:60, lowerBetter:false, biomarkerKey:"egfr" },
                      { data:outcomesData.creatinine, label:"Creatinine", unit:" mg/dl", color:"#6366f1", target:1.2, biomarkerKey:"creatinine" },
                      { data:outcomesData.uacr, label:"UACR", unit:" mg/g", color:"#be185d", target:30, biomarkerKey:"uacr" },
                      { data:outcomesData.tsh, label:"TSH", unit:" mIU/L", color:"#0891b2", biomarkerKey:"tsh" },
                    ])}
                    {(outcomesData.waist?.length > 0 || outcomesData.body_fat?.length > 0 || outcomesData.muscle_mass?.length > 0) &&
                      renderSection("Body Composition", "🏋️", "#059669", [
                        { data:outcomesData.waist, label:"Waist", unit:" cm", color:"#059669", valueKey:"waist", biomarkerKey:"waist" },
                        { data:outcomesData.body_fat, label:"Body Fat", unit:"%", color:"#d97706", valueKey:"body_fat", biomarkerKey:"body_fat" },
                        { data:outcomesData.muscle_mass, label:"Muscle Mass", unit:" kg", color:"#2563eb", lowerBetter:false, valueKey:"muscle_mass", biomarkerKey:"muscle_mass" },
                      ])
                    }
                    {(() => {
                      const missing = [];
                      if (!outcomesData.hba1c?.length) missing.push("HbA1c");
                      if (!outcomesData.fpg?.length) missing.push("Fasting Glucose");
                      if (!outcomesData.ldl?.length) missing.push("LDL");
                      if (!outcomesData.egfr?.length) missing.push("eGFR");
                      return missing.length > 0 ? (
                        <div style={{ background:"#fffbeb", borderRadius:12, padding:"10px 14px", border:"1px solid #fde68a", marginBottom:20 }}>
                          <div style={{ fontSize:11, fontWeight:700, color:"#92400e" }}>⚠️ Missing: {missing.join(", ")}</div>
                          <div style={{ fontSize:10, color:"#b45309", marginTop:3 }}>Add via 📜 Hx tab → Reports to see trends</div>
                        </div>
                      ) : null;
                    })()}
                  </>
                );
              })()}

              {/* ═══════════════════════════════════════════════ */}
              {/* ── HEALTH STORY (Date on TOP, filters, doctor) */}
              {/* ═══════════════════════════════════════════════ */}
              {outcomesData && (() => {
                const events = [];
                // Visit events
                const visitDiagChanges = {};
                (outcomesData.diagnosis_journey || []).forEach(d => {
                  const key = (d.visit_date || "").split("T")[0];
                  if (!visitDiagChanges[key]) visitDiagChanges[key] = [];
                  // Deduplicate by label+status
                  const exists = visitDiagChanges[key].find(x => x.label === d.label && x.status === d.status);
                  if (!exists) visitDiagChanges[key].push({ label: d.label, status: d.status });
                });
                const visitNewMeds = {};
                (outcomesData.med_timeline || []).forEach(m => {
                  if (!m.is_new) return;
                  const key = (m.visit_date || "").split("T")[0];
                  if (!visitNewMeds[key]) visitNewMeds[key] = [];
                  const name = m.pharmacy_match || m.name;
                  if (!visitNewMeds[key].includes(name)) visitNewMeds[key].push(name);
                });

                // Collect all doctors for filter
                const allDoctors = new Set();
                (outcomesData.visits || []).forEach(v => {
                  if (v.con_name) allDoctors.add(v.con_name);
                  if (v.mo_name) allDoctors.add(v.mo_name);

                  if (!v.visit_date) return;
                  const dateKey = v.visit_date.split("T")[0];
                  events.push({
                    date: dateKey, type:"visit", icon:"📋",
                    label: `${v.status === "historical" ? "Historical " : ""}${v.visit_type || "OPD"} Visit`,
                    doctor: v.con_name || v.mo_name || "",
                    summary: v.summary || "",
                    diagChanges: visitDiagChanges[dateKey] || [],
                    newMeds: (visitNewMeds[dateKey] || []).slice(0,6),
                    lifestyle: v.lifestyle || [],
                    compliance: v.compliance || "",
                    symptoms: (v.symptoms || v.chief_complaints || []).filter(s => !["no gmi","no hypoglycemia","no hypoglycaemia","routine follow-up","follow-up visit","no complaints"].some(x => String(s).toLowerCase().includes(x))),
                    color:"#0369a1", bg:"#f0f9ff"
                  });
                });

                // Diagnosis onset
                const diagGrouped = {};
                (outcomesData.diagnosis_journey || []).forEach(d => {
                  if (!diagGrouped[d.diagnosis_id]) diagGrouped[d.diagnosis_id] = { label: d.label };
                  diagGrouped[d.diagnosis_id].label = d.label;
                });
                Object.entries(diagGrouped).forEach(([id, info]) => {
                  const match = info.label.match(/\((?:since\s+)?(\d+)\s*(?:years?|yrs?)\)/i);
                  if (match) {
                    const onsetYear = new Date().getFullYear() - parseInt(match[1]);
                    events.push({ date:`${onsetYear}-06-01`, type:"diagnosis", icon:"🩺",
                      label:info.label.replace(/\s*\(.*?\)/, ""), detail:`Estimated onset ~${onsetYear}`,
                      color:"#dc2626", bg:"#fef2f2" });
                  }
                });

                // Complications + Past medical from current session MO data
                (moData?.complications || []).forEach(c => {
                  if (c?.name) events.push({ date:null, type:"complication", icon:"⚠️", label:c.name,
                    detail:`${c.status}${c.detail ? ` — ${c.detail}` : ""}`, color:"#dc2626", bg:"#fef2f2" });
                });
                if (moData?.history?.past_medical_surgical) {
                  const pms = moData.history.past_medical_surgical;
                  if (pms && pms !== "NIL" && pms.length > 3) {
                    pms.split(/[,;]/).forEach(item => {
                      const trimmed = item.trim();
                      if (trimmed.length > 2) {
                        const yearMatch = trimmed.match(/(19|20)\d{2}/);
                        events.push({ date: yearMatch ? `${yearMatch[0]}-06-01` : null,
                          type:"history", icon:"🏥", label:trimmed, detail:"Past medical/surgical",
                          color:"#7c3aed", bg:"#faf5ff" });
                      }
                    });
                  }
                }
                // Also pull history from stored visits (not just current session)
                (outcomesData.visits || []).forEach(v => {
                  if (v.complications && Array.isArray(v.complications)) {
                    v.complications.forEach(c => {
                      if (c?.name && !events.find(e => e.label === c.name && e.type === "complication")) {
                        events.push({ date:null, type:"complication", icon:"⚠️", label:c.name,
                          detail:`${c.status||""}${c.detail ? ` — ${c.detail}` : ""}`, color:"#dc2626", bg:"#fef2f2" });
                      }
                    });
                  }
                  if (v.history?.past_medical_surgical) {
                    const pms = v.history.past_medical_surgical;
                    if (pms && pms !== "NIL" && pms.length > 3) {
                      pms.split(/[,;]/).forEach(item => {
                        const trimmed = item.trim();
                        if (trimmed.length > 2 && !events.find(e => e.label === trimmed && e.type === "history")) {
                          const yearMatch = trimmed.match(/(19|20)\d{2}/);
                          events.push({ date: yearMatch ? `${yearMatch[0]}-06-01` : null,
                            type:"history", icon:"🏥", label:trimmed, detail:"Past medical/surgical",
                            color:"#7c3aed", bg:"#faf5ff" });
                        }
                      });
                    }
                  }
                });

                // Birth
                if (patient.dob) {
                  events.push({ date: patient.dob, type:"life", icon:"👶", label:"Born",
                    detail: fmtDate(patient.dob), color:"#6366f1", bg:"#eef2ff" });
                } else if (patient.age) {
                  const birthYear = new Date().getFullYear() - parseInt(patient.age);
                  events.push({ date:`${birthYear}-01-01`, type:"life", icon:"👶", label:"Born",
                    detail:`~${birthYear} (age ${patient.age})`, color:"#6366f1", bg:"#eef2ff" });
                }

                // Sort: most recent first, nulls above birth, birth always last
                events.sort((a, b) => {
                  if (a.type === "life") return 1;
                  if (b.type === "life") return -1;
                  if (!a.date && !b.date) return 0;
                  if (!a.date) return 1;
                  if (!b.date) return -1;
                  return new Date(b.date) - new Date(a.date);
                });

                // Deduplicate
                const seen = new Set();
                const unique = events.filter(e => {
                  const k = `${e.label}|${(e.date||"").split("T")[0]}`;
                  if (seen.has(k)) return false;
                  seen.add(k);
                  return true;
                });

                if (unique.length === 0) return null;

                // Filter tabs + doctor filter
                const filters = ["All","Visits","Diagnosis","Meds","Symptoms","History"];
                const doctorList = [...allDoctors];
                const applyTypeFilter = (e, f) => {
                  if (f === "All") return true;
                  if (f === "Visits") return e.type === "visit";
                  if (f === "Diagnosis") return e.type === "diagnosis" || (e.type === "visit" && e.diagChanges?.length > 0);
                  if (f === "Meds") return e.type === "visit" && e.newMeds?.length > 0;
                  if (f === "Symptoms") return (e.type === "visit" && e.symptoms?.length > 0) || e.type === "complication";
                  if (f === "History") return e.type === "history" || e.type === "complication" || e.type === "life";
                  return true;
                };
                const filtered = unique.filter(e => {
                  if (!applyTypeFilter(e, timelineFilter)) return false;
                  if (timelineDoctor && e.doctor && e.doctor !== timelineDoctor) return false;
                  return true;
                });

                const fmtDateNice = (dateStr) => {
                  if (!dateStr) return "—";
                  const s = String(dateStr);
                  const d = s.length === 10 ? new Date(s+"T12:00:00") : new Date(s);
                  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
                };

                return (
                  <div style={{ background:"white", borderRadius:16, padding:18, border:"1px solid #f1f5f9", marginBottom:20, boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                      <span style={{ fontSize:18 }}>📖</span>
                      <span style={{ fontSize:15, fontWeight:800, color:"#0f172a" }}>Health Story</span>
                    </div>

                    {/* Filter row */}
                    <div style={{ display:"flex", gap:4, marginBottom:6, flexWrap:"wrap", alignItems:"center" }}>
                      {filters.map(f => {
                        const count = unique.filter(e => applyTypeFilter(e, f)).length;
                        return (
                          <button key={f} onClick={()=>setTimelineFilter(f)}
                            style={{ padding:"4px 10px", fontSize:10, fontWeight:700, borderRadius:20, cursor:"pointer",
                              border: timelineFilter===f ? "none" : "1px solid #e2e8f0",
                              background: timelineFilter===f ? "#0f172a" : "white",
                              color: timelineFilter===f ? "white" : "#64748b" }}>
                            {f}{f!=="All" ? ` (${count})` : ""}
                          </button>
                        );
                      })}
                    </div>
                    {/* Doctor filter */}
                    {doctorList.length > 0 && (
                      <div style={{ display:"flex", gap:3, marginBottom:12, alignItems:"center" }}>
                        <span style={{ fontSize:9, color:"#94a3b8", fontWeight:600 }}>Doctor:</span>
                        <button onClick={()=>setTimelineDoctor("")}
                          style={{ padding:"2px 8px", fontSize:9, fontWeight:600, borderRadius:12, cursor:"pointer",
                            border: !timelineDoctor ? "none" : "1px solid #e2e8f0",
                            background: !timelineDoctor ? "#475569" : "white",
                            color: !timelineDoctor ? "white" : "#64748b" }}>All</button>
                        {doctorList.map(d => (
                          <button key={d} onClick={()=>setTimelineDoctor(timelineDoctor===d?"":d)}
                            style={{ padding:"2px 8px", fontSize:9, fontWeight:600, borderRadius:12, cursor:"pointer",
                              border: timelineDoctor===d ? "none" : "1px solid #e2e8f0",
                              background: timelineDoctor===d ? "#475569" : "white",
                              color: timelineDoctor===d ? "white" : "#64748b" }}>{d.startsWith("Dr")?d:"Dr. "+d}</button>
                        ))}
                      </div>
                    )}

                    {/* Timeline */}
                    <div style={{ position:"relative", paddingLeft:34 }}>
                      <div style={{ position:"absolute", left:13, top:8, bottom:8, width:2,
                        background:"linear-gradient(to bottom, #0ea5e9, #e2e8f0, #c4b5fd)", borderRadius:2 }} />

                      {filtered.map((ev, i) => {
                        const isVisit = ev.type === "visit";
                        return (
                          <div key={i} style={{ position:"relative", marginBottom: i < filtered.length - 1 ? (isVisit ? 18 : 12) : 0 }}>
                            {/* Node */}
                            <div style={{ position:"absolute", left:-28, top:3, width:24, height:24, borderRadius:"50%",
                              display:"flex", alignItems:"center", justifyContent:"center", fontSize:12,
                              background: ev.bg || "#f8fafc", border:`2px solid ${ev.color || "#94a3b8"}`,
                              boxShadow:"0 1px 3px rgba(0,0,0,0.08)", zIndex:1 }}>
                              {ev.icon}
                            </div>

                            {/* Content card */}
                            <div style={{ background: isVisit ? "#f8fafc" : "transparent", borderRadius:12,
                              padding: isVisit ? "12px 14px" : "4px 0", marginLeft:6,
                              border: isVisit ? "1px solid #e2e8f0" : "none" }}>

                              {/* DATE ON TOP */}
                              <div style={{ fontSize:11, fontWeight:700, color:"#475569", marginBottom:4,
                                background: isVisit ? "#e2e8f0" : "#f1f5f9", display:"inline-block",
                                padding:"2px 10px", borderRadius:8 }}>
                                {fmtDateNice(ev.date)}
                              </div>

                              {/* Title + Doctor */}
                              <div style={{ fontSize:14, fontWeight:700, color:"#0f172a" }}>{ev.label}</div>
                              {ev.doctor && <div style={{ fontSize:10, color:"#64748b", marginTop:1 }}>👨‍⚕️ {ev.doctor.startsWith("Dr")?ev.doctor:"Dr. "+ev.doctor}</div>}

                              {/* Summary */}
                              {isVisit && ev.summary && (
                                <div style={{ fontSize:11, color:"#475569", marginTop:6, lineHeight:"1.5", fontStyle:"italic",
                                  background:"white", borderRadius:8, padding:"6px 10px", border:"1px solid #f1f5f9" }}>
                                  {typeof ev.summary === "string" ? ev.summary.slice(0,200) + (ev.summary.length > 200 ? "..." : "") : ""}
                                </div>
                              )}

                              {/* Detail for non-visit */}
                              {!isVisit && ev.detail && (
                                <div style={{ fontSize:11, color:"#475569", marginTop:3 }}>{ev.detail}</div>
                              )}

                              {/* Compliance */}
                              {isVisit && ev.compliance && (
                                <div style={{ marginTop:6 }}>
                                  <span style={{ fontSize:9, fontWeight:700, padding:"2px 8px", borderRadius:10,
                                    background:(ev.compliance+"").startsWith("Good")?"#dcfce7":(ev.compliance+"").startsWith("Poor")?"#fef2f2":"#fef3c7",
                                    color:(ev.compliance+"").startsWith("Good")?"#059669":(ev.compliance+"").startsWith("Poor")?"#dc2626":"#d97706" }}>
                                    {ev.compliance}
                                  </span>
                                </div>
                              )}

                              {/* Diagnosis chips - DEDUPLICATED */}
                              {isVisit && ev.diagChanges?.length > 0 && (
                                <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginTop:6 }}>
                                  {ev.diagChanges.map((d, di) => (
                                    <span key={di} style={{ fontSize:10, fontWeight:600, padding:"2px 8px", borderRadius:20,
                                      background:d.status==="Controlled"?"#dcfce7":d.status==="Uncontrolled"?"#fef2f2":"#dbeafe",
                                      color:d.status==="Controlled"?"#059669":d.status==="Uncontrolled"?"#dc2626":"#2563eb" }}>
                                      {d.label.replace(/\s*\(.*?\)/, "")} — {d.status}
                                    </span>
                                  ))}
                                </div>
                              )}

                              {/* Symptoms */}
                              {isVisit && ev.symptoms?.length > 0 && (
                                <div style={{ display:"flex", flexWrap:"wrap", gap:3, marginTop:4 }}>
                                  {ev.symptoms.map((s, si) => (
                                    <span key={si} style={{ fontSize:9, fontWeight:600, padding:"2px 6px", borderRadius:8,
                                      background:"#fef2f2", color:"#dc2626", border:"1px solid #fecaca" }}>⚠️ {s}</span>
                                  ))}
                                </div>
                              )}

                              {/* Lifestyle */}
                              {isVisit && ev.lifestyle?.length > 0 && (
                                <div style={{ display:"flex", flexWrap:"wrap", gap:3, marginTop:4 }}>
                                  {(Array.isArray(ev.lifestyle)?ev.lifestyle:[]).slice(0,5).map((l, li) => (
                                    <span key={li} style={{ fontSize:9, fontWeight:600, padding:"2px 6px", borderRadius:8,
                                      background:"#f0fdf4", color:"#059669", border:"1px solid #bbf7d0" }}>
                                      {typeof l === "object" ? l.advice : l}
                                    </span>
                                  ))}
                                </div>
                              )}

                              {/* New meds */}
                              {isVisit && ev.newMeds?.length > 0 && (
                                <div style={{ display:"flex", flexWrap:"wrap", gap:3, marginTop:4 }}>
                                  {ev.newMeds.map((m, mi) => (
                                    <span key={mi} style={{ fontSize:9, fontWeight:600, padding:"2px 6px", borderRadius:8,
                                      background:"#faf5ff", color:"#7c3aed", border:"1px solid #e9d5ff" }}>💊 {m}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* ═══════════════════════════════════════════════ */}
              {/* ── DIAGNOSIS JOURNEY (Clickable, bigger dates) */}
              {/* ═══════════════════════════════════════════════ */}
              {outcomesData?.diagnosis_journey?.length > 0 && (() => {
                const grouped = {};
                outcomesData.diagnosis_journey.forEach(d => {
                  if (!grouped[d.diagnosis_id]) grouped[d.diagnosis_id] = { label: d.label, history: [] };
                  // Deduplicate by date+status
                  const dateKey = (d.visit_date||"").split("T")[0];
                  if (!grouped[d.diagnosis_id].history.find(h => h.date.split("T")[0] === dateKey && h.status === d.status)) {
                    grouped[d.diagnosis_id].history.push({ status: d.status, date: d.visit_date, doctor: d.con_name || d.mo_name });
                  }
                  grouped[d.diagnosis_id].label = d.label;
                });

                return (
                  <div style={{ background:"white", borderRadius:16, padding:16, border:"1px solid #f1f5f9", marginBottom:20, boxShadow:"0 1px 3px rgba(0,0,0,0.04)" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
                      <span style={{ fontSize:16 }}>📈</span>
                      <span style={{ fontSize:14, fontWeight:800, color:"#0f172a" }}>Diagnosis Journey</span>
                      <span style={{ fontSize:10, color:"#94a3b8", marginLeft:"auto" }}>Click to expand</span>
                    </div>
                    {Object.entries(grouped).map(([id, info], gi) => {
                      const latest = info.history[info.history.length - 1];
                      const sc = latest.status === "Controlled" ? "#059669" : latest.status === "Uncontrolled" ? "#dc2626" : "#d97706";
                      const sb = latest.status === "Controlled" ? "#f0fdf4" : latest.status === "Uncontrolled" ? "#fef2f2" : "#fffbeb";
                      const isExpanded = expandedDiagnosis === id;

                      // Map diagnosis to relevant biomarkers
                      const diagBiomarkers = {
                        dm2:["hba1c","fpg"], dm1:["hba1c","fpg"], htn:["bp"], hypo:["tsh"],
                        dyslipidemia:["ldl","triglycerides","hdl"], ckd:["egfr","creatinine","uacr"],
                        nephropathy:["egfr","creatinine","uacr"], obesity:["weight"],
                      };
                      const relevantKeys = diagBiomarkers[id] || [];
                      const relevantData = relevantKeys.map(k => {
                        const d = outcomesData[k];
                        if (!d || !d.length) return null;
                        const latest = d[d.length - 1];
                        const first = d[0];
                        const val = latest.result || latest.bp_sys || latest.weight || latest[k];
                        const firstVal = first.result || first.bp_sys || first.weight || first[k];
                        return { key:k, label: k.toUpperCase().replace("_"," "), latest:val, first:firstVal, count:d.length };
                      }).filter(Boolean);

                      return (
                        <div key={id} style={{ padding:"10px 0", borderBottom: gi < Object.keys(grouped).length - 1 ? "1px solid #f1f5f9" : "none",
                          cursor:"pointer" }} onClick={()=>setExpandedDiagnosis(isExpanded ? null : id)}>
                          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                              <span style={{ fontSize:13, fontWeight:700, color:"#1e293b" }}>{info.label}</span>
                              <span style={{ fontSize:10, color:"#94a3b8" }}>{isExpanded ? "▼" : "▶"}</span>
                            </div>
                            <span style={{ fontSize:11, fontWeight:700, color:sc, background:sb, padding:"3px 12px", borderRadius:20 }}>{latest.status}</span>
                          </div>
                          {/* Status timeline with BIGGER dates */}
                          <div style={{ display:"flex", gap:6, marginTop:8, flexWrap:"wrap", alignItems:"center" }}>
                            {info.history.map((h, i) => {
                              const hs = String(h.date||""); const hd = hs.length>=10?new Date(hs.slice(0,10)+"T12:00:00"):new Date(hs);
                              const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                              return (
                                <div key={i} style={{ display:"flex", alignItems:"center", gap:4 }}>
                                  <div style={{ textAlign:"center" }}>
                                    <div style={{ fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:14,
                                      background:h.status==="Controlled"?"#dcfce7":h.status==="Uncontrolled"?"#fef2f2":"#fef3c7",
                                      color:h.status==="Controlled"?"#059669":h.status==="Uncontrolled"?"#dc2626":"#d97706" }}>
                                      {h.status==="Controlled"?"C":h.status==="Uncontrolled"?"U":"N"}
                                    </div>
                                    <div style={{ fontSize:10, color:"#64748b", marginTop:2, fontWeight:600 }}>
                                      {hd.getDate()} {months[hd.getMonth()]} {String(hd.getFullYear()).slice(2)}
                                    </div>
                                  </div>
                                  {i < info.history.length - 1 && <span style={{ fontSize:14, color:"#cbd5e1" }}>→</span>}
                                </div>
                              );
                            })}
                          </div>

                          {/* EXPANDED: relevant biomarkers + meds */}
                          {isExpanded && (
                            <div style={{ marginTop:10, padding:12, background:"#fafbfc", borderRadius:10, border:"1px solid #f1f5f9" }}
                              onClick={e => e.stopPropagation()}>
                              {/* Biomarker trends */}
                              {relevantData.length > 0 && (
                                <div style={{ marginBottom:8 }}>
                                  <div style={{ fontSize:10, fontWeight:700, color:"#475569", marginBottom:6 }}>📊 Key Biomarkers:</div>
                                  <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                                    {relevantData.map((rd, ri) => {
                                      const improving = rd.key === "egfr" || rd.key === "hdl" ? rd.latest > rd.first : rd.latest < rd.first;
                                      return (
                                        <div key={ri} style={{ background:"white", borderRadius:10, padding:"8px 12px", border:"1px solid #f1f5f9", minWidth:110 }}>
                                          <div style={{ fontSize:9, color:"#94a3b8", fontWeight:600 }}>{rd.label}</div>
                                          <div style={{ fontSize:16, fontWeight:800, color: improving ? "#059669" : "#dc2626" }}>{rd.latest}</div>
                                          {rd.count > 1 && <div style={{ fontSize:9, color: improving ? "#059669" : "#dc2626" }}>
                                            {improving ? "↓" : "↑"} from {rd.first} ({rd.count} readings)
                                          </div>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                              {/* Relevant meds */}
                              {(() => {
                                const diagMeds = (outcomesData.med_timeline || []).filter(m => {
                                  const name = (m.pharmacy_match || m.name || "").toString();
                                  for (const [cls, info] of Object.entries(DRUG_BIOMARKER_MAP)) {
                                    if (relevantKeys.some(k => info.biomarkers.includes(k)) && info.patterns.test(name)) return true;
                                  }
                                  return false;
                                });
                                const uniqueMeds = {};
                                diagMeds.forEach(m => {
                                  const k = (m.pharmacy_match||m.name).toUpperCase();
                                  if (!uniqueMeds[k]) uniqueMeds[k] = m;
                                  else if (m.is_active) uniqueMeds[k] = m;
                                });
                                const medList = Object.values(uniqueMeds);
                                if (medList.length === 0) return null;
                                return (
                                  <div>
                                    <div style={{ fontSize:10, fontWeight:700, color:"#475569", marginBottom:4 }}>💊 Current Protocol:</div>
                                    <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                                      {medList.map((m,mi) => (
                                        <span key={mi} style={{ fontSize:9, padding:"2px 8px", borderRadius:8,
                                          background: m.is_active ? "#f0fdf4" : "#f8fafc",
                                          color: m.is_active ? "#059669" : "#94a3b8",
                                          border: `1px solid ${m.is_active ? "#bbf7d0" : "#e2e8f0"}`,
                                          fontWeight:600, textDecoration: m.is_active ? "none" : "line-through" }}>
                                          {m.pharmacy_match||m.name} {m.dose} {m.frequency}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* ── MEDICATIONS ── */}
              {outcomesData?.med_timeline?.length > 0 && (() => {
                const grouped = {};
                outcomesData.med_timeline.forEach(m => {
                  const key = (m.pharmacy_match || m.name).toUpperCase();
                  if (!grouped[key]) grouped[key] = { name: m.pharmacy_match || m.name, entries: [] };
                  grouped[key].entries.push(m);
                });
                Object.values(grouped).forEach(g => {
                  const seen = new Set();
                  g.entries = g.entries.filter(e => { const k = `${e.dose}|${e.frequency}|${e.visit_date}`; if (seen.has(k)) return false; seen.add(k); return true; });
                });
                const activeMeds = Object.values(grouped).filter(m => m.entries[m.entries.length-1]?.is_active);
                const stoppedMeds = Object.values(grouped).filter(m => !m.entries[m.entries.length-1]?.is_active);
                const fmtD = (d) => { if(!d)return""; const x=new Date(d); const m=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; return `${x.getDate()} ${m[x.getMonth()]} ${x.getFullYear()}`; };
                return (
                  <div style={{ background:"white", borderRadius:16, padding:16, border:"1px solid #f1f5f9", marginBottom:20, boxShadow:"0 1px 3px rgba(0,0,0,0.04)" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
                      <span style={{ fontSize:16 }}>💊</span>
                      <span style={{ fontSize:14, fontWeight:800, color:"#0f172a" }}>Medications</span>
                      <span style={{ fontSize:10, color:"#94a3b8", marginLeft:"auto" }}>{activeMeds.length} active{stoppedMeds.length>0?` · ${stoppedMeds.length} stopped`:""}</span>
                    </div>
                    {activeMeds.map((med, mi) => {
                      const latest = med.entries[med.entries.length - 1];
                      const first = med.entries[0];
                      const doseChanged = latest.dose !== first.dose && med.entries.length > 1;
                      return (
                        <div key={mi} style={{ display:"flex", gap:10, padding:"8px 0", borderBottom: mi < activeMeds.length - 1 ? "1px solid #f8fafc" : "none", alignItems:"center" }}>
                          <div style={{ width:4, height:28, borderRadius:2, background:"#059669", flexShrink:0 }} />
                          <div style={{ flex:1 }}>
                            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                              <span style={{ fontSize:12, fontWeight:700, color:"#1e293b" }}>{med.name}</span>
                              {doseChanged && <span style={{ fontSize:8, padding:"1px 6px", background:"#fef3c7", color:"#d97706", borderRadius:10, fontWeight:700 }}>dose changed</span>}
                            </div>
                            <div style={{ fontSize:10, color:"#64748b", marginTop:1 }}>
                              {latest.dose} · {latest.frequency}{latest.timing ? ` · ${latest.timing}` : ""} · <span style={{ color:"#94a3b8" }}>since {fmtD(first.started_date||first.visit_date)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {stoppedMeds.length > 0 && (
                      <div style={{ marginTop:8, paddingTop:8, borderTop:"1px dashed #e2e8f0" }}>
                        <div style={{ fontSize:10, color:"#94a3b8", fontWeight:700, marginBottom:4, textTransform:"uppercase", letterSpacing:"0.5px" }}>Stopped</div>
                        {stoppedMeds.map((med, mi) => (
                          <div key={mi} style={{ display:"flex", gap:10, padding:"4px 0", alignItems:"center" }}>
                            <div style={{ width:4, height:20, borderRadius:2, background:"#e2e8f0", flexShrink:0 }} />
                            <span style={{ fontSize:11, color:"#94a3b8", textDecoration:"line-through" }}>{med.name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── RECENT LABS ── */}
              {patientFullData?.lab_results?.length > 0 && (
                <div style={{ background:"white", borderRadius:16, padding:16, border:"1px solid #f1f5f9", boxShadow:"0 1px 3px rgba(0,0,0,0.04)", marginBottom:20 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
                    <span style={{ fontSize:16 }}>🧪</span>
                    <span style={{ fontSize:14, fontWeight:800, color:"#0f172a" }}>Recent Lab Results</span>
                  </div>
                  {(() => {
                    const labs = patientFullData.lab_results || [];
                    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                    const fmtD = (dt) => { const s=String(dt||""); const d=s.length>=10?new Date(s.slice(0,10)+"T12:00:00"):new Date(s); return `${d.getDate()} ${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`; };
                    const dateKey = (dt) => String(dt||"").slice(0,10);
                    // Get unique dates sorted
                    const allDates = [...new Set(labs.map(l=>dateKey(l.test_date)))].filter(Boolean).sort();
                    // Get unique test names in order of first appearance
                    const seen = new Set(); const testNames = [];
                    labs.forEach(l => { if (!seen.has(l.test_name)) { seen.add(l.test_name); testNames.push(l.test_name); } });
                    // Build lookup: test_name -> {date -> {result, flag, unit, ref}}
                    const lookup = {};
                    labs.forEach(l => { if (!lookup[l.test_name]) lookup[l.test_name] = {}; lookup[l.test_name][dateKey(l.test_date)] = l; });
                    const showDates = allDates.slice(-6); // last 6 dates max
                    return (
                      <div style={{ overflowX:"auto" }}>
                        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                          <thead><tr style={{ borderBottom:"2px solid #e2e8f0" }}>
                            <th style={{ textAlign:"left", padding:"6px 8px", fontSize:10, color:"#94a3b8", fontWeight:700, position:"sticky", left:0, background:"white", minWidth:100 }}>Test</th>
                            <th style={{ padding:"6px 4px", fontSize:9, color:"#94a3b8", fontWeight:600, minWidth:40 }}>Ref</th>
                            {showDates.map(dt => <th key={dt} style={{ padding:"6px 6px", fontSize:9, color:"#475569", fontWeight:700, minWidth:55, textAlign:"center" }}>{fmtD(dt)}</th>)}
                          </tr></thead>
                          <tbody>
                            {testNames.map((tn, i) => (
                              <tr key={tn} style={{ borderBottom:"1px solid #f1f5f9", background:i%2?"#fafbfc":"white" }}>
                                <td style={{ padding:"5px 8px", fontWeight:600, color:"#334155", position:"sticky", left:0, background:i%2?"#fafbfc":"white" }}>{tn}</td>
                                <td style={{ padding:"5px 4px", fontSize:9, color:"#94a3b8", textAlign:"center" }}>{lookup[tn][Object.keys(lookup[tn])[0]]?.ref_range||""}</td>
                                {showDates.map(dt => {
                                  const v = lookup[tn]?.[dt];
                                  return <td key={dt} style={{ padding:"5px 6px", textAlign:"center", fontWeight:v?700:400,
                                    color:!v?"#e2e8f0":v.flag==="H"||v.flag==="HIGH"?"#dc2626":v.flag==="L"||v.flag==="LOW"?"#2563eb":"#374151" }}>
                                    {v ? <>{v.result}<span style={{ fontSize:8, fontWeight:400, color:"#94a3b8", marginLeft:1 }}>{v.unit}</span></> : "—"}
                                  </td>;
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══ AI CHAT TAB ═══ */}
      {tab==="ai" && (
        <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 120px)" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
            <div style={{ fontSize:15, fontWeight:800, color:"#7c2d12" }}>🤖 Gini AI — Clinical Assistant</div>
            <div style={{ flex:1 }} />
            {patient.name && <span style={{ fontSize:10, background:"#f0fdf4", color:"#059669", padding:"2px 8px", borderRadius:10, fontWeight:600 }}>Context: {patient.name}</span>}
            <button onClick={()=>setAiMessages([])} style={{ fontSize:10, background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"3px 8px", borderRadius:4, cursor:"pointer", color:"#64748b" }}>Clear Chat</button>
          </div>

          {aiMessages.length === 0 && (
            <div style={{ textAlign:"center", padding:"30px 20px", background:"#faf5ff", borderRadius:12, marginBottom:10 }}>
              <div style={{ fontSize:28, marginBottom:8 }}>🤖</div>
              <div style={{ fontSize:13, fontWeight:700, color:"#6b21a8", marginBottom:6 }}>Ask me anything about this patient</div>
              <div style={{ fontSize:11, color:"#7c3aed", lineHeight:1.8 }}>
                Try: "What are the latest ADA guidelines for this HbA1c level?"<br/>
                "Any drug interactions between current medications?"<br/>
                "Suggest investigations for diabetic foot assessment"<br/>
                "What's the target eGFR for this patient's CKD stage?"<br/>
                "Draft a referral note for ophthalmology"
              </div>
              <div style={{ marginTop:12, display:"flex", flexWrap:"wrap", gap:6, justifyContent:"center" }}>
                {["Drug interactions check","ADA guidelines for this patient","Suggest next investigations","Diabetic foot protocol","Explain latest lab trends","Referral letter for specialist"].map(q => (
                  <button key={q} onClick={()=>{setAiInput(q);}} style={{ fontSize:10, background:"white", border:"1px solid #d8b4fe", padding:"4px 10px", borderRadius:20, cursor:"pointer", color:"#7c3aed", fontWeight:600 }}>{q}</button>
                ))}
              </div>
            </div>
          )}

          {/* Chat messages */}
          <div ref={aiChatRef} style={{ flex:1, overflow:"auto", marginBottom:8, display:"flex", flexDirection:"column", gap:8 }}>
            {aiMessages.map((msg, i) => (
              <div key={i} style={{ display:"flex", justifyContent:msg.role==="user"?"flex-end":"flex-start" }}>
                <div style={{
                  maxWidth:"85%", padding:"10px 14px", borderRadius:msg.role==="user"?"14px 14px 4px 14px":"14px 14px 14px 4px",
                  background:msg.role==="user"?"#1e293b":"#f8fafc",
                  color:msg.role==="user"?"white":"#1e293b",
                  border:msg.role==="user"?"none":"1px solid #e2e8f0",
                  fontSize:12, lineHeight:1.7, whiteSpace:"pre-wrap"
                }}>
                  {msg.role==="assistant" && <div style={{ fontSize:9, fontWeight:700, color:"#7c3aed", marginBottom:4 }}>🤖 GINI AI</div>}
                  {msg.content}
                </div>
              </div>
            ))}
            {aiLoading && (
              <div style={{ display:"flex", justifyContent:"flex-start" }}>
                <div style={{ padding:"10px 14px", background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:"14px 14px 14px 4px" }}>
                  <div style={{ fontSize:12, color:"#94a3b8" }}>⏳ Thinking...</div>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div style={{ display:"flex", gap:6, padding:"8px 0", borderTop:"2px solid #e2e8f0" }}>
            <input value={aiInput} onChange={e=>setAiInput(e.target.value)} placeholder="Ask about patient, medications, guidelines, protocols..."
              onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendAiMessage()}
              style={{ flex:1, padding:"10px 14px", border:"1px solid #e2e8f0", borderRadius:10, fontSize:13, outline:"none" }} />
            <button onClick={sendAiMessage} disabled={aiLoading||!aiInput.trim()}
              style={{ padding:"10px 20px", background:aiLoading?"#94a3b8":"#7c2d12", color:"white", border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:aiLoading?"wait":"pointer" }}>
              {aiLoading?"⏳":"Send →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
