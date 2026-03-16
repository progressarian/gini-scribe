import api from "./api.js";
import { AI_CHAT_SYSTEM } from "../config/prompts.js";

export async function aiChat(messages, patientContext) {
  try {
    const systemPrompt =
      AI_CHAT_SYSTEM +
      (patientContext ? `\n\nPATIENT DATA:\n${patientContext}` : "\n\nNo patient loaded.");
    const { data: d } = await api.post("/api/ai/complete", {
      messages,
      system: systemPrompt,
      model: "sonnet",
      maxTokens: 4000,
    });
    if (d.error) return { text: null, error: d.error };
    return { text: d.text, error: null };
  } catch (e) {
    return { text: null, error: e.response?.data?.error || e.message };
  }
}
