// ── Prescription PDF/image extractor using Claude vision ─────────────────────
// Uses the SAME unified clinical-extraction prompt as the HealthRay text parser
// (see parser.js) so an uploaded prescription and a HealthRay-synced clinical
// note produce identical schemas: diagnoses, symptoms, medications,
// previous_medications, labs, vitals, follow_up, advice, investigations, etc.

import { createLogger } from "../logger.js";
import { CLINICAL_EXTRACTION_PROMPT, repairAndParseJSON } from "./parser.js";
const { error } = createLogger("PrescriptionExtract");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Detect actual file format from magic bytes — S3 Content-Type is unreliable
function detectMediaType(buffer) {
  const b = new Uint8Array(buffer.slice(0, 8));

  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "image/webp";

  return "image/jpeg";
}

function buildClaudeBlock(base64Data, buffer) {
  const mediaType = detectMediaType(buffer);

  if (mediaType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64Data },
    };
  }
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };
}

export async function downloadFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  if (contentType.startsWith("text/") || contentType.includes("xml")) {
    throw new Error(`URL returned non-file content (${contentType}) — URL may have expired`);
  }

  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return { base64, buffer };
}

export async function extractFromFile(base64, buffer) {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not configured");

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 24000,
      temperature: 0,
      system: CLINICAL_EXTRACTION_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            buildClaudeBlock(base64, buffer),
            {
              type: "text",
              text: "Parse the clinical content of this prescription into the unified JSON schema described in the system prompt. Treat the prescription image/PDF as the clinical note — apply all the same section/date/diagnosis/medication rules.",
            },
          ],
        },
      ],
    }),
  });

  if (!claudeRes.ok) {
    const body = await claudeRes.json().catch(() => ({}));
    throw new Error(`Claude ${claudeRes.status}: ${body.error?.message || "unknown error"}`);
  }

  const data = await claudeRes.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude returned no JSON");

  const parsed = repairAndParseJSON(jsonMatch[0]);
  if (!parsed) throw new Error("Claude returned unparseable JSON");
  return parsed;
}

export async function extractPrescription(fileUrl) {
  const { base64, buffer } = await downloadFile(fileUrl);
  return extractFromFile(base64, buffer);
}
