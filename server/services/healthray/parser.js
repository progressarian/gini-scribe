// ── Clinical notes parsing — extract text, AI parse, JSON repair ────────────

import { createLogger } from "../logger.js";
const { error } = createLogger("HealthRay Sync");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Extract all filled text from clinical notes API response ────────────────
// Handles both formats:
//   1. medical_clinical_notes: categories → topics.selected[]
//   2. get_previous_appt_data: menus[] → categories → topics[] (flat array)
export function extractClinicalText(clinicalData) {
  const sections = {};
  for (const menu of clinicalData) {
    const texts = [];
    for (const cat of menu.categories || []) {
      // Format 1: topics.selected (from medical_clinical_notes)
      const selectedTopics = cat.topics?.selected || [];
      // Format 2: topics as flat array (from get_previous_appt_data)
      const flatTopics = Array.isArray(cat.topics) ? cat.topics : [];
      const allTopics = selectedTopics.length > 0 ? selectedTopics : flatTopics;

      for (const topic of allTopics) {
        texts.push(topic.name);
        for (const ans of topic.dynamic_answers || []) {
          if (ans.answer) texts.push(ans.answer);
        }
      }
    }
    if (texts.length) sections[menu.name] = texts.join("\n");
  }
  return sections;
}

// ── Repair truncated/malformed JSON from AI ─────────────────────────────────
export function repairAndParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {}

  let s = raw;

  // Fix unescaped newlines/tabs inside string values
  s = s.replace(/"([^"]*?)"/g, (_match, content) => {
    const fixed = content.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return `"${fixed}"`;
  });
  s = s.replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(s);
  } catch {}

  // Close unclosed strings
  const quotes = (s.match(/"/g) || []).length;
  if (quotes % 2 !== 0) s += '"';
  s = s.replace(/,\s*([}\]])/g, "$1");

  // Close unclosed arrays and objects
  const opens = { "{": 0, "[": 0 };
  for (const ch of s) {
    if (ch === "{") opens["{"]++;
    if (ch === "}") opens["{"]--;
    if (ch === "[") opens["["]++;
    if (ch === "]") opens["["]--;
  }
  if (opens["["] > 0 || opens["{"] > 0) {
    s = s.replace(/,\s*(?:"[^"]*"?\s*:?\s*(?:"[^"]*"?|[^,}\]]*)?)?$/m, "");
  }
  for (let i = 0; i < opens["["]; i++) s += "]";
  for (let i = 0; i < opens["{"]; i++) s += "}";

  try {
    return JSON.parse(s);
  } catch {}

  // Last resort: extract each key separately
  try {
    const partial = {};
    const keys = [
      "diagnoses",
      "labs",
      "medications",
      "previous_medications",
      "vitals",
      "lifestyle",
      "advice",
    ];
    for (const key of keys) {
      const re = new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\}|"[^"]*")`);
      const m = s.match(re);
      if (m)
        try {
          partial[key] = JSON.parse(m[1]);
        } catch {}
    }
    if (Object.keys(partial).length > 0) return partial;
  } catch {}

  error("Parser", "JSON repair failed — could not recover");
  return null;
}

// ── Use Claude to parse clinical text into structured data ──────────────────
export async function parseClinicalWithAI(rawText) {
  if (!ANTHROPIC_KEY || !rawText || rawText.trim().length < 10) return null;

  const prompt = `Parse this clinical note into structured JSON. Extract ONLY data present in the text.

Return JSON with these keys:
{
  "diagnoses": [{"name": "...", "details": "...", "since": "..."}],
  "labs": [{"test": "...", "value": "...", "unit": "...", "date": "..."}],
  "medications": [{"name": "...", "dose": "...", "frequency": "...", "timing": "...", "route": "Oral", "is_new": false}],
  "previous_medications": [{"name": "...", "dose": "...", "frequency": "...", "status": "stopped/changed", "reason": "..."}],
  "vitals": {"height": null, "weight": null, "bmi": null, "bpSys": null, "bpDia": null, "waist": null, "bodyFat": null},
  "lifestyle": {"diet": null, "exercise": null, "smoking": null, "alcohol": null, "stress": null},
  "advice": "..."
}

STRICT Rules:
- NEVER invent or assume data. If a field is not explicitly mentioned in the text, set it to null. Do NOT fill fields with unrelated data.
- For labs: extract ALL lab values with test name, numeric value, unit. Include HbA1c, FBG, PPBG, LDL, TG, TSH, T3, T4, Creatinine, eGFR, UACR, Hb, Iron, Ferritin, OT/SGOT, PT/SGPT, ALP, Calcium, Albumin, etc.
- For medications: parse CURRENT/TREATMENT medications with name, dose, frequency (OD/BD/TDS etc), timing (before/after food etc), route (Oral/SC/IV/IM etc). Set is_new=true if it's a new addition
- For previous_medications: extract medications from "PREVIOUS MEDICATION" section that were stopped/changed. Include reason if mentioned (e.g. side effect, replaced, discontinued)
- For diagnoses: extract each condition separately
- For vitals: extract HT/WT/BMI/BP/WC/BF if mentioned
- For lifestyle: SPLIT into separate fields. Set to null if not found — do NOT put medication instructions, monitoring instructions, or follow-up advice here:
  - diet: ONLY calorie/protein/food plan (e.g. "1400 kcal with 60g protein"). Must mention kcal/calories/protein/food. Null if not found
  - exercise: ONLY physical activity like steps, walking, gym (e.g. "10,000 steps daily"). Must mention steps/walk/exercise. Null if not found
  - smoking: ONLY if explicitly mentioned. Null if not found
  - alcohol: ONLY if explicitly mentioned. Null if not found
  - stress: ONLY if explicitly mentioned. Null if not found
- For advice: glucose monitoring instructions, TSH targets, medication holds, insulin dose adjustments, other clinical instructions. Null if not found
- Only include the LATEST follow-up data if multiple follow-ups exist
- Return ONLY valid JSON, no markdown`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        messages: [{ role: "user", content: rawText }],
        system: prompt,
      }),
    });

    if (!resp.ok) {
      error("Parser", `Claude API error: ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    const text = (data.content || []).map((c) => c.text || "").join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return repairAndParseJSON(jsonMatch[0]);
  } catch (e) {
    error("Parser", "Parse error:", e.message);
    return null;
  }
}
