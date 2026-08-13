// Content-based document classifier.
//
// Why this exists: HealthRay files a lot of reports under record_type "Other"
// and *generates the filename from the record type* — e.g.
// "other_beant_kaur_12_08_2026_11_08_AM_4kbvaakby.pdf". mapRecordType() only
// sees record_type + file_name, so for those rows there is literally no signal
// to work with and everything lands in the Labs tab's "Other" bucket, even
// when the PDF is plainly an ABI Doppler or a Biothesiometry (VPT) study.
//
// The only thing that can tell them apart is the file itself, so this reads
// the first page with Claude and maps it to one of the Labs tab's report
// types. It is deliberately a *classification* call, not an extraction call:
// short prompt, tiny output, no panel/finding parsing. Full extraction
// (server/services/extraction.js) picks the wrong prompt for these docs
// anyway — pickPrompt() sends anything that isn't "prescription"/"imaging"
// down the LAB_PROMPT path, which returns zero panels for an ABI report and
// then burns three retries failing the usable-result check.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TIMEOUT_MS = 60_000;
const BACKOFF_MS = [2000, 5000];
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

// Cheap by design — this is a one-page "what kind of report is this" call, and
// the backfill runs it over thousands of documents. Override with
// DOC_CLASSIFIER_MODEL if you want a stronger model.
const MODEL = process.env.DOC_CLASSIFIER_MODEL || "claude-haiku-4-5";

// Must stay in sync with REPORT_TYPES in src/OPD.jsx — these are the ids the
// Labs tab groups documents by. "prescription" is included so a misfiled Rx
// gets routed to ComplianceTab instead of sitting in the Labs tab.
export const CLASSIFIER_TYPES = [
  "blood",
  "abi",
  "vpt",
  "xray",
  "ultrasound",
  "mri",
  "ecg",
  "echo",
  "tmt",
  "eye",
  "prescription",
  "other",
];

const CLASSIFY_PROMPT = `You are classifying a single medical document for a diabetes/vascular clinic's records system. Look at the document and decide which category it belongs to.

Return ONLY valid JSON (no backticks, no markdown, no commentary):
{"doc_type":"<one of the categories below>","confidence":0.0-1.0,"rationale":"one short sentence"}

CATEGORIES — pick exactly one:
- blood: any laboratory report with test results and reference ranges (CBC, HbA1c, lipid profile, KFT, LFT, thyroid, urine routine, UACR, cultures, etc.)
- abi: Ankle Brachial Index / ABI Doppler / arterial Doppler of the limbs, reporting an ankle-to-brachial pressure ratio
- vpt: Vibration Perception Threshold / Biothesiometry / Biothesiometer study, reporting voltage readings per site
- xray: plain radiographs of any body part
- ultrasound: ultrasound / USG / sonography reports (abdomen, KUB, thyroid, obstetric, carotid Doppler etc.)
- mri: MRI or CT scan reports
- ecg: ECG / EKG (resting 12-lead) reports
- echo: Echocardiography / 2D Echo / Doppler echocardiogram reports
- tmt: Treadmill Test / TMT / stress test / exercise ECG reports
- eye: retinal / fundus imaging and diabetic eye screening — fundus photographs, diabetic retinopathy (DR) or diabetic macular edema (DME) grading reports, OCT, visual acuity / eye examination reports
- prescription: a doctor's prescription or consultation note (Rx symbol, drug names with doses/frequencies, follow-up advice)
- other: anything that fits none of the above — e.g. nerve conduction studies, DEXA, PFT, invoices, bills, receipts, consent forms, discharge summaries, vaccination cards, ID documents

RULES:
- Judge by the document's own title and content, NOT by its filename — filenames here are auto-generated and carry no information.
- ABI and VPT are frequently mislabelled as generic reports. If you see an ankle-brachial pressure ratio, classify as abi. If you see biothesiometry voltages, classify as vpt.
- A limb arterial Doppler that reports an ABI ratio is "abi", not "ultrasound".
- A carotid or abdominal Doppler with no ABI ratio is "ultrasound".
- If the document is genuinely ambiguous or fits none of the categories, return "other" with low confidence. Do not guess.`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // Strip code fences if the model wrapped the JSON despite instructions.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callOnce({ base64, mediaType, signal }) {
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

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: [block, { type: "text", text: CLASSIFY_PROMPT }] }],
    }),
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
  const parsed = parseJson(text);
  if (!parsed) {
    const err = new Error(`Classification parse failed. Raw: ${String(text).slice(0, 200)}`);
    err.retryable = true;
    throw err;
  }
  return parsed;
}

/**
 * Classify a document file into one of CLASSIFIER_TYPES.
 * Returns { data: { doc_type, confidence, rationale }, error: null } or
 * { data: null, error: "..." }. Never throws.
 */
export async function classifyDocumentFile({ base64, mediaType, attempts = 3 }) {
  if (!ANTHROPIC_KEY) return { data: null, error: "ANTHROPIC_API_KEY not configured on server" };
  if (!base64) return { data: null, error: "No file content to classify" };

  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const parsed = await callOnce({
        base64,
        mediaType: mediaType || "application/pdf",
        signal: controller.signal,
      });
      clearTimeout(timer);

      const docType = String(parsed.doc_type || "")
        .toLowerCase()
        .trim();
      if (!CLASSIFIER_TYPES.includes(docType)) {
        const err = new Error(`Unknown doc_type "${parsed.doc_type}"`);
        err.retryable = true;
        throw err;
      }
      return {
        data: {
          doc_type: docType,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
          rationale: String(parsed.rationale || "").slice(0, 300),
        },
        error: null,
      };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const retryable = e.name === "AbortError" || e.retryable !== false;
      if (!retryable || i === attempts - 1) break;
      await sleep(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
    }
  }

  return {
    data: null,
    error:
      lastErr?.name === "AbortError"
        ? `Classifier timeout after ${Math.round(TIMEOUT_MS / 1000)}s`
        : lastErr?.message || "Classification failed",
  };
}
