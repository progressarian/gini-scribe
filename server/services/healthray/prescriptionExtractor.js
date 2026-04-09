// ── Prescription PDF/image extractor using Claude vision ─────────────────────

import { createLogger } from "../logger.js";
const { error } = createLogger("PrescriptionExtract");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const EXTRACT_PROMPT = `Extract all prescription data from this file. Return JSON only:
{
  "visit_date": "YYYY-MM-DD or null",
  "medications": [{"name": "...", "dose": "...", "frequency": "OD/BD/TDS/QID", "timing": "before food/after food/empty stomach", "route": "Oral"}],
  "stopped_medications": [{"name": "...", "reason": "..."}]
}
Rules:
- Extract ALL medicines with name, dose, frequency, timing, route
- stopped_medications: only medicines explicitly marked stopped/discontinued/crossed out
- Return ONLY valid JSON, no markdown`;

// Detect actual file format from magic bytes — S3 Content-Type is unreliable
function detectMediaType(buffer) {
  const b = new Uint8Array(buffer.slice(0, 8));

  // PDF: starts with %PDF (25 50 44 46)
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  // GIF: GIF8
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  // WebP: RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "image/webp";

  // Unknown — default to JPEG (most common for prescription scans)
  return "image/jpeg";
}

// Build Claude content block from buffer using magic-byte detection
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

// Download file from URL and return { base64, buffer }
export async function downloadFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  // S3 error pages come back as text/xml or text/html with status 200 — reject them
  if (contentType.startsWith("text/") || contentType.includes("xml")) {
    throw new Error(`URL returned non-file content (${contentType}) — URL may have expired`);
  }

  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return { base64, buffer };
}

// Send file to Claude and return parsed extracted_data or throw
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
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [buildClaudeBlock(base64, buffer), { type: "text", text: EXTRACT_PROMPT }],
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

  return JSON.parse(jsonMatch[0]);
}

// Full pipeline: download → detect format → extract → return parsed data
export async function extractPrescription(fileUrl) {
  const { base64, buffer } = await downloadFile(fileUrl);
  return extractFromFile(base64, buffer);
}
