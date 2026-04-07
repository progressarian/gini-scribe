import api from "./api.js";

const SYSTEM_PROMPT = `You are a clinical assistant briefing a doctor before they see a patient.
Be concise, specific, and clinical. Use exact numbers from the data provided.
Never be vague. Never use generic language.
Format output as JSON with three arrays: red_alerts, amber_alerts, green_notes.
Each item is a single sentence. Maximum 3 items per zone.
Do not hallucinate — only use information explicitly provided in the rule alerts.`;

// Converts rule alert objects to a plain text list for the prompt
function formatAlerts(alerts) {
  const lines = [];
  for (const a of alerts.red) lines.push(`[RED]   ${a.title}${a.detail ? " — " + a.detail : ""}`);
  for (const a of alerts.amber) lines.push(`[AMBER] ${a.title}${a.detail ? " — " + a.detail : ""}`);
  for (const a of alerts.green) lines.push(`[GREEN] ${a.title}${a.detail ? " — " + a.detail : ""}`);
  return lines.join("\n");
}

export async function generatePatientBrief({ patient, diagnoses = [], alerts }) {
  const total = alerts.red.length + alerts.amber.length + alerts.green.length;
  if (total === 0) return null;

  const dx =
    diagnoses
      .map((d) => d.label)
      .filter(Boolean)
      .join(", ") || "Not recorded";
  const userContent = [
    `Patient: ${patient?.name || "Unknown"}, ${patient?.age ?? "?"}y${patient?.sex ? ", " + patient.sex : ""}`,
    `Diagnoses: ${dx}`,
    ``,
    `Rule engine alerts:`,
    formatAlerts(alerts),
    ``,
    `Generate a clinical briefing. Return only valid JSON.`,
  ].join("\n");

  const { data } = await api.post("/api/ai/complete", {
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    model: "sonnet",
    maxTokens: 600,
  });

  if (data.error) throw new Error(data.error);

  // Strip markdown fences if present
  let text = (data.text || "")
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  const parsed = JSON.parse(text);

  return {
    red: (parsed.red_alerts || []).slice(0, 3),
    amber: (parsed.amber_alerts || []).slice(0, 3),
    green: (parsed.green_notes || []).slice(0, 3),
  };
}
