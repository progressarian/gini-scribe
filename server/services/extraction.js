// Server-side document extraction helper. Used by the /retry-extract
// endpoint to re-run Claude vision extraction from scratch with real
// reliability guarantees:
//   • AbortController with 180s timeout per call (large PDFs need it)
//   • 3 attempts with 2s / 5s / 10s backoff
//   • Retries on network errors, 5xx, 429, parse failures
//   • Fails fast on 4xx (auth / bad request)
// The prompts mirror src/config/prompts.js — we keep them here too so
// the server doesn't reach across the monorepo into client code, same
// pattern already used by server/routes/visit.js:844.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const BACKOFF_MS = [2000, 5000, 10_000];
const TIMEOUT_MS = 180_000;

export const LAB_PROMPT = `Extract ALL test results from this lab report image. Return ONLY valid JSON, no backticks.
{"lab_name":"name of laboratory/hospital that performed tests","report_date":"YYYY-MM-DD","collection_date":"YYYY-MM-DD or null","patient_on_report":{"name":"","age":"","sex":"","patient_id":""},"panels":[{"panel_name":"Panel","tests":[{"test_name":"","result":0.0,"result_text":null,"unit":"","flag":null,"ref_range":""}]}]}
CRITICAL RULES:
- Extract EVERY test result on the report without exception, even if there are more than 50 tests. Do not skip or truncate.
- report_date: MUST extract the date tests were performed/collected/reported. Look for "Date:", "Report Date:", "Sample Date:", "Collection Date:" in the header. Format as YYYY-MM-DD.
- lab_name: Extract the laboratory/hospital name from the report header.
- test_name: Use SHORT STANDARD names. Map to these canonical names when applicable:
  HbA1c, FBS, PPBS, Fasting Insulin, C-Peptide, Mean Plasma Glucose, RBS, Fructosamine,
  Total Cholesterol, LDL, HDL, Triglycerides, VLDL, Non-HDL,
  Creatinine, BUN, Uric Acid, eGFR, UACR, Sodium, Potassium, Calcium, Phosphorus,
  TSH, T3, T4, Free T3, Free T4,
  SGPT (ALT), SGOT (AST), ALP, GGT, Total Bilirubin, Direct Bilirubin, Indirect Bilirubin, Albumin, Total Protein,
  Hemoglobin, WBC, RBC, Platelets, MCV, MCH, MCHC, PCV, ESR, CRP, hs-CRP,
  Vitamin D, Vitamin B12, Ferritin, Iron, TIBC, Folate,
  Total Testosterone, Free Testosterone, Cortisol, LH, FSH, Prolactin, AMH, Estradiol, Progesterone, DHEAS, IGF-1,
  Homocysteine, Lipoprotein(a), D-Dimer, Procalcitonin,
  PSA, Urine Routine, Microalbumin
  Example: "Glycated Hemoglobin" → "HbA1c", "Fasting Blood Sugar" → "FBS", "Fasting Plasma Glucose" → "FBS", "Post Prandial Blood Sugar" → "PPBS"
- flag: "H" high, "L" low, null normal.
- ref_range: extract reference range as shown (e.g. "4.0-6.5").
- result: numeric value. result_text: only if result is non-numeric (e.g. "Positive", "Reactive").`;

export const IMAGING_PROMPT = `Extract findings from this medical imaging/diagnostic report. Return ONLY valid JSON, no backticks.
{
  "report_type":"DEXA|X-Ray|MRI|Ultrasound|ABI|VPT|Fundus|ECG|Echo|CT|PFT|NCS",
  "patient_on_report":{"name":"","age":"","sex":"","patient_id":""},
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

export const RX_EXTRACT_PROMPT = `You are a medical record parser. Extract structured data from this old prescription/consultation note.
Return ONLY valid JSON, no backticks.
{
  "visit_date":"YYYY-MM-DD or null",
  "doctor_name":"string or null",
  "specialty":"string or null",
  "patient_on_report":{"name":"","age":"","sex":""},
  "diagnoses":[{"id":"dm2","label":"Type 2 DM (since 2015)","status":"Controlled"}],
  "medications":[{"name":"MEDICINE NAME","dose":"dose","frequency":"OD/BD/TDS","timing":"Morning/Night","status":"active"}],
  "stopped_medications":[{"name":"MEDICINE NAME","reason":"reason if mentioned"}],
  "vitals":{"bp_sys":null,"bp_dia":null,"weight":null,"height":null,"pulse":null},
  "advice":["string"],
  "follow_up":"string or null"
}
RULES:
- patient_on_report.name: extract the patient/recipient name written on the prescription (English/Roman script). Used to detect a name-mismatch when patients upload someone else's prescription by mistake. Leave empty string if not visible.
- Diagnosis IDs: dm2,dm1,htn,cad,ckd,hypo,obesity,dyslipidemia,asthma,copd,pcos,oa,ra,liver,stroke,epilepsy,depression,anxiety,gerd,ibs
- Status: "Controlled","Uncontrolled","New" based on context
- MEDICINE: Use EXACT brand names from prescription, capitalize properly
- Extract ALL medicines even if partially readable
- stopped_medications: medicines marked as stopped/omit/discontinue/band karo/tapering off
- Parse Hindi/Punjabi terms: "sugar ki dawai"=diabetes medication, "BP ki goli"=antihypertensive, "band karo"=stop
- visit_date: ONLY extract if an explicit specific date is clearly written (e.g. 12/03/2024, 12-Mar-2024). Do NOT infer, assume, or use today's date. If no specific date is written or only vague terms like "today" are used, set visit_date to null AND return empty arrays for medications, diagnoses, stopped_medications, advice and null for all vitals and follow_up — do not extract any data without a confirmed written date.
- Name must be in English/Roman script`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Claude can return valid JSON where nearly every field is empty — most
// often when a long PDF runs past the output-token budget or a page didn't
// render. We treat those skinny results as failures so the retry loop
// tries again rather than persisting "few details only" as if it were
// a successful extraction.
function isExtractionUsable(data, docType) {
  if (!data || typeof data !== "object") return false;
  if (docType === "prescription") {
    if (!data.visit_date) return false;
    return (data.medications?.length || 0) > 0 || (data.diagnoses?.length || 0) > 0;
  }
  if (docType === "imaging" || docType === "radiology") {
    return (data.findings?.length || 0) > 0 || !!data.impression;
  }
  const testCount = (data.panels || []).reduce((a, p) => a + (p?.tests?.length || 0), 0);
  return testCount > 0;
}

// Best-effort JSON repair for slightly-malformed Claude output. Same
// strategy as the client parseVisionResponse: strip code fences, drop
// trailing commas, then balance braces.
export function parseClaudeJson(text) {
  if (!text) return { data: null, error: "Empty response" };
  let clean = text
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  try {
    return { data: JSON.parse(clean), error: null };
  } catch {
    clean = clean.replace(/,\s*([}\]])/g, "$1");
    const ob = (clean.match(/{/g) || []).length;
    const cb = (clean.match(/}/g) || []).length;
    for (let i = 0; i < ob - cb; i++) clean += "}";
    try {
      return { data: JSON.parse(clean), error: null };
    } catch {
      return { data: null, error: "Parse failed" };
    }
  }
}

// Magic-byte sniff. S3 Content-Type is often wrong for user-uploaded
// files so we detect from the first bytes instead.
export function detectMediaType(buffer) {
  const b = new Uint8Array(buffer.slice(0, 8));
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "image/webp";
  return "image/jpeg";
}

export async function downloadFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  if (contentType.startsWith("text/") || contentType.includes("xml")) {
    throw new Error(`URL returned non-file content (${contentType}) — file URL may have expired`);
  }
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return { base64, buffer };
}

// Call Claude Messages API once. On failure throws an Error with
// `status` / `retryable` so the outer loop can decide to retry.
async function callClaudeOnce({ base64, mediaType, prompt, maxTokens, signal }) {
  if (!ANTHROPIC_KEY) {
    const err = new Error("ANTHROPIC_API_KEY not configured on server");
    err.retryable = false;
    throw err;
  }

  const block =
    mediaType === "application/pdf"
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
  };
  if (mediaType === "application/pdf") headers["anthropic-beta"] = "pdfs-2024-09-25";

  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: [block, { type: "text", text: prompt }] }],
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    const err = new Error(`Anthropic ${resp.status}: ${txt.slice(0, 200)}`);
    err.status = resp.status;
    err.retryable = RETRYABLE_HTTP.has(resp.status);
    throw err;
  }

  const data = await resp.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  const parsed = parseClaudeJson(text);
  if (parsed.error) {
    const err = new Error(`Parse failed: ${parsed.error}`);
    err.retryable = true;
    throw err;
  }
  return parsed.data;
}

// Run callClaudeOnce with timeout + up to 3 attempts + backoff.
// Returns { data, attempts } on success; throws with an explanatory
// message (and `.attempts`) on final failure. Callers are expected to
// catch and persist the failure to the doc's extracted_data.
export async function extractWithRetry({ base64, mediaType, docType, attempts = 3 }) {
  const prompt = pickPrompt(docType);
  const maxTokens = docType === "prescription" ? 3000 : 16_000;

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const data = await callClaudeOnce({
        base64,
        mediaType,
        prompt,
        maxTokens,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!isExtractionUsable(data, docType)) {
        const err = new Error(
          "Claude returned incomplete data — too few fields to trust, retrying",
        );
        err.retryable = true;
        err.thinResult = true;
        throw err;
      }
      return { data, attempts: i + 1 };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const retryable = e.name === "AbortError" || e.retryable !== false;
      if (!retryable || i === attempts - 1) break;
      await sleep(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
    }
  }
  const msg =
    lastErr?.name === "AbortError"
      ? `Claude timeout after ${Math.round(TIMEOUT_MS / 1000)}s`
      : lastErr?.thinResult
        ? "Claude returned incomplete data after 3 attempts — try re-uploading a clearer scan"
        : lastErr?.message || "Extraction failed";
  const outErr = new Error(msg);
  outErr.attempts = attempts;
  throw outErr;
}

function pickPrompt(docType) {
  if (!docType) return LAB_PROMPT;
  if (docType === "prescription") return RX_EXTRACT_PROMPT;
  if (docType === "imaging" || docType === "radiology") return IMAGING_PROMPT;
  return LAB_PROMPT;
}
