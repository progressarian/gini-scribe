import api from "./api.js";
import { LAB_PROMPT, IMAGING_PROMPT, RX_EXTRACT_PROMPT } from "../config/prompts.js";

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

export async function extractLab(base64, mediaType) {
  try {
    const block =
      mediaType === "application/pdf"
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          }
        : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
    const { data: d } = await api.post("/api/ai/complete", {
      messages: [{ role: "user", content: [block, { type: "text", text: LAB_PROMPT }] }],
      model: "sonnet",
      maxTokens: 8000,
    });
    if (d.error) return { data: null, error: d.error };
    return parseVisionResponse(d.text);
  } catch (e) {
    return { data: null, error: e.response?.data?.error || e.message };
  }
}

export async function extractImaging(base64, mediaType) {
  try {
    const block =
      mediaType === "application/pdf"
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          }
        : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
    const { data: d } = await api.post("/api/ai/complete", {
      messages: [{ role: "user", content: [block, { type: "text", text: IMAGING_PROMPT }] }],
      model: "sonnet",
      maxTokens: 8000,
    });
    if (d.error) return { data: null, error: d.error };
    return parseVisionResponse(d.text);
  } catch (e) {
    return { data: null, error: e.response?.data?.error || e.message };
  }
}

export async function extractRx(base64, mediaType) {
  try {
    const block =
      mediaType === "application/pdf"
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          }
        : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
    const { data: d } = await api.post("/api/ai/complete", {
      messages: [{ role: "user", content: [block, { type: "text", text: RX_EXTRACT_PROMPT }] }],
      model: "sonnet",
      maxTokens: 3000,
    });
    if (d.error) return { data: null, error: d.error };
    return parseVisionResponse(d.text);
  } catch (e) {
    return { data: null, error: e.response?.data?.error || e.message };
  }
}
