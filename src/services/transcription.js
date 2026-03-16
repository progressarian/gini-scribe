import api from "./api.js";
import { CLEANUP_PROMPT } from "../config/prompts.js";

// Convert blob to base64
async function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

// ============ DEEPGRAM (batch via server) ============
export async function transcribeDeepgram(audioBlob, apiKey, language) {
  const audio = await blobToBase64(audioBlob);
  const { data: d } = await api.post("/api/ai/transcribe", {
    audio,
    engine: "deepgram",
    language,
    mimeType: audioBlob.type || "audio/webm",
  });
  if (d.error) throw new Error(d.error);
  return d.text || "";
}

// ============ WHISPER (via server) ============
export async function transcribeWhisper(audioBlob, apiKey, language) {
  const audio = await blobToBase64(audioBlob);
  const { data: d } = await api.post("/api/ai/transcribe", {
    audio,
    engine: "whisper",
    language,
    mimeType: audioBlob.type || "audio/webm",
  });
  if (d.error) throw new Error(d.error);
  return d.text || "";
}

// ============ CLEANUP (via server) ============
export async function cleanupTranscript(text) {
  if (!text || text.length < 10) return text;
  try {
    const { data: d } = await api.post("/api/ai/complete", {
      messages: [{ role: "user", content: `${CLEANUP_PROMPT}\n\nTEXT:\n${text}` }],
      model: "haiku",
      maxTokens: 2000,
    });
    return d.text?.trim() || text;
  } catch {
    return text;
  }
}

// ============ DEEPGRAM STREAMING KEY ============
export async function getDeepgramKey() {
  try {
    const { data: d } = await api.get("/api/ai/deepgram-key");
    return d.key || null;
  } catch {
    return null;
  }
}
