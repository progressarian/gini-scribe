import api from "./api.js";
import { LAB_PROMPT, IMAGING_PROMPT, RX_EXTRACT_PROMPT } from "../config/prompts.js";
import { compressBase64Image } from "./imageCompress.js";

// Convert HEIC/HEIF to JPEG via server (sharp)
export async function convertHeicToJpeg(file) {
  const raw = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.readAsDataURL(file);
  });
  const { data } = await api.post("/api/convert-heic", { base64: raw });
  return data;
}

export function isHeic(file) {
  return (
    file.name?.toLowerCase().endsWith(".heic") ||
    file.name?.toLowerCase().endsWith(".heif") ||
    file.type === "image/heic" ||
    file.type === "image/heif"
  );
}

export function parseVisionResponse(text) {
  if (!text) return { data: null, error: "Empty response" };
  let clean = text
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  try {
    return { data: JSON.parse(clean), error: null };
  } catch {
    clean = clean.replace(/,\s*([}\]])/g, "$1");
    const ob = (clean.match(/{/g) || []).length,
      cb = (clean.match(/}/g) || []).length;
    for (let i = 0; i < ob - cb; i++) clean += "}";
    try {
      return { data: JSON.parse(clean), error: null };
    } catch {
      return { data: null, error: "Parse failed" };
    }
  }
}

// ── Retry policy ────────────────────────────────────────────────────
// Claude calls on large PDFs (15-20 pages) routinely take 60-120s.
// Without a timeout the axios/fetch promise can hang forever if the
// upstream stalls, leaving the doc stuck on "⏳ Extracting…". We wrap
// each call in an AbortController, retry up to 3× on transient failures
// (network errors, 5xx, 429, parse failures from truncated JSON), and
// back off 2s → 5s → 10s. Non-retryable (auth/validation) fails fast.
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const BACKOFF_MS = [2000, 5000, 10_000];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Claude sometimes emits a syntactically-valid JSON shell where most fields
// are blank — usually because a large PDF pushed it past the output token
// budget, or the page it was looking at hadn't finished rendering. That's
// the exact "extracts only a few details" symptom the user reported on
// P_106360. We treat such skinny results as a failure so the retry loop
// tries again (and the UI eventually shows a real Retry button) instead
// of silently accepting a near-empty extraction.
function isExtractionUsable(data, kind) {
  if (!data || typeof data !== "object") return false;
  if (kind === "rx") {
    return (data.medications?.length || 0) > 0 || (data.diagnoses?.length || 0) > 0;
  }
  if (kind === "imaging") {
    return (data.findings?.length || 0) > 0 || !!data.impression;
  }
  // labs
  const testCount = (data.panels || []).reduce((a, p) => a + (p?.tests?.length || 0), 0);
  return testCount > 0;
}

function isRetryable(err) {
  if (!err) return false;
  if (err.name === "AbortError" || err.name === "CanceledError") return true;
  if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") return true;
  if (!err.response) return true; // network error / no response
  return RETRYABLE_HTTP.has(err.response.status);
}

// Estimate raw bytes from base64 length (3 bytes per 4 chars, minus padding).
function base64Bytes(b64) {
  if (!b64) return 0;
  return Math.floor((b64.length * 3) / 4);
}

// Pick a timeout + token budget tailored to the file. Images and short
// PDFs get the default; 15-20 page scans or multi-MB payloads get the
// longer window so Claude has enough time to emit a full JSON tree.
function budgetFor(base64, mediaType) {
  const bytes = base64Bytes(base64);
  const isPdf = mediaType === "application/pdf";
  const large = isPdf && bytes > 5 * 1024 * 1024;
  return {
    timeoutMs: large ? 180_000 : 120_000,
    maxTokens: large ? 16_000 : 8000,
  };
}

async function runWithRetry(label, buildRequest, { timeoutMs, attempts = 3, kind } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { data: d } = await api.post("/api/ai/complete", buildRequest(), {
        signal: controller.signal,
        timeout: timeoutMs + 5000,
      });
      clearTimeout(timer);
      if (d.error) {
        const err = new Error(d.error);
        err.response = { status: 502 };
        throw err;
      }
      const parsed = parseVisionResponse(d.text);
      if (parsed.error) {
        const err = new Error(parsed.error);
        err.parseFailed = true;
        throw err;
      }
      if (kind && !isExtractionUsable(parsed.data, kind)) {
        const err = new Error(`${label} returned too few fields — treating as failure so we retry`);
        err.thinResult = true;
        throw err;
      }
      return { data: parsed.data, error: null, attempts: i + 1 };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const canRetry = isRetryable(e) || e.parseFailed || e.thinResult;
      if (!canRetry || i === attempts - 1) break;
      await sleep(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
    }
  }
  const msg =
    lastErr?.name === "CanceledError" || lastErr?.name === "AbortError"
      ? `${label} timed out after ${Math.round(timeoutMs / 1000)}s`
      : lastErr?.thinResult
        ? `${label} returned incomplete data — try again or re-upload a clearer scan`
        : lastErr?.response?.data?.error || lastErr?.message || "Extraction failed";
  return { data: null, error: msg, attempts };
}

function buildBlock(base64, mediaType) {
  return mediaType === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
}

export async function extractLab(base64, mediaType) {
  ({ base64, mediaType } = await compressBase64Image(base64, mediaType));
  const { timeoutMs, maxTokens } = budgetFor(base64, mediaType);
  return runWithRetry(
    "Lab extraction",
    () => ({
      messages: [
        {
          role: "user",
          content: [buildBlock(base64, mediaType), { type: "text", text: LAB_PROMPT }],
        },
      ],
      model: "sonnet",
      maxTokens,
    }),
    { timeoutMs, kind: "lab" },
  );
}

export async function extractImaging(base64, mediaType) {
  ({ base64, mediaType } = await compressBase64Image(base64, mediaType));
  const { timeoutMs, maxTokens } = budgetFor(base64, mediaType);
  return runWithRetry(
    "Imaging extraction",
    () => ({
      messages: [
        {
          role: "user",
          content: [buildBlock(base64, mediaType), { type: "text", text: IMAGING_PROMPT }],
        },
      ],
      model: "sonnet",
      maxTokens,
    }),
    { timeoutMs, kind: "imaging" },
  );
}

export async function extractRx(base64, mediaType) {
  ({ base64, mediaType } = await compressBase64Image(base64, mediaType));
  const { timeoutMs } = budgetFor(base64, mediaType);
  // Rx prompt stays at 3000 output tokens — prescriptions are short.
  // Large scans still get the longer timeout.
  return runWithRetry(
    "Prescription extraction",
    () => ({
      messages: [
        {
          role: "user",
          content: [buildBlock(base64, mediaType), { type: "text", text: RX_EXTRACT_PROMPT }],
        },
      ],
      model: "sonnet",
      maxTokens: 3000,
    }),
    { timeoutMs, kind: "rx" },
  );
}
