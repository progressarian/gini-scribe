// ── Generate common_side_effects for a single medication using Claude ──────
//
// Used when a doctor adds a medicine manually (outside the AI prescription
// extractor in services/healthray/parser.js, which already populates this
// field). The shape and rules MUST match the parser's COMMON SIDE EFFECTS
// contract so the patient app renders both sources identically:
//   - JSONB array, at most 3 entries
//   - { name, desc, severity: "common" | "uncommon" | "warn" }
//   - At most one "warn" entry, ordered most-common-first
//   - desc kept under ~90 characters, patient-friendly
//
// Runs in the background (fire-and-forget) so the add-medicine response is
// not delayed. Updates the row only if it still has an empty
// common_side_effects array, so we never overwrite values that were set by
// the AI extractor or by a later edit.

import pool from "../../config/db.js";
import { createLogger } from "../logger.js";

const { log: info, error } = createLogger("CommonSideEffectsAI");
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// NOTE — keep this rule wording identical to the COMMON SIDE EFFECTS bullet
// in services/healthray/parser.js (CLINICAL_EXTRACTION_PROMPT) so the manual
// add path and the AI extractor produce identical-shaped, identically-toned
// output for the patient app. If you change one, change the other.
const SYSTEM_PROMPT = `You are a clinical pharmacology assistant. You will be given a single medication (brand name and optional composition). Return its common side effects by calling the "report_common_side_effects" tool exactly once.

COMMON SIDE EFFECTS — populate the "common_side_effects" array with at MOST 3 entries describing the most clinically relevant common side effects of that drug (use general medical knowledge of the drug — these are the well-known common side effects the patient should be aware of). Each entry has: name (short label, e.g. "Stomach upset / loose stools"), desc (one short patient-friendly line, e.g. "Take with food. Extended-release form helps."), severity ("common" for the typical mild ones, "uncommon" for less frequent, "warn" for rare-but-serious things the patient should seek help for — at most one "warn" entry). Order by importance: most common first. If the drug is a generic supplement / multivitamin / non-pharmacological item with no notable side effects, return []. Do NOT exceed 3 entries. Keep desc under 90 characters.

Do not produce any text output — only the tool call.`;

// Anthropic tool definition. We use forced tool use as Claude's structured-
// output mechanism: the model must emit a tool_use block whose `input`
// matches this JSON schema, so we don't need to text-parse JSON out of
// freeform completion content.
const SIDE_EFFECTS_TOOL = {
  name: "report_common_side_effects",
  description:
    "Report up to 3 common side effects for the given medication, in patient-friendly language.",
  input_schema: {
    type: "object",
    properties: {
      common_side_effects: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short side-effect label." },
            desc: {
              type: "string",
              description: "One short patient-friendly tip, under 90 characters.",
            },
            severity: {
              type: "string",
              enum: ["common", "uncommon", "warn"],
              description:
                "common = typical mild, uncommon = less frequent, warn = rare-but-serious (max one warn entry).",
            },
          },
          required: ["name", "desc", "severity"],
          additionalProperties: false,
        },
      },
    },
    required: ["common_side_effects"],
    additionalProperties: false,
  },
};

function buildUserMessage({ name, composition }) {
  const parts = [`Medication: ${name}`];
  if (composition && String(composition).trim()) {
    parts.push(`Composition: ${composition}`);
  }
  return parts.join("\n");
}

function sanitizeEntries(arr) {
  if (!Array.isArray(arr)) return [];
  const allowed = new Set(["common", "uncommon", "warn"]);
  let warnSeen = false;
  const out = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const name = String(raw.name || "")
      .trim()
      .slice(0, 120);
    const desc = String(raw.desc || "")
      .trim()
      .slice(0, 200);
    let severity = String(raw.severity || "")
      .trim()
      .toLowerCase();
    if (!allowed.has(severity)) severity = "common";
    if (severity === "warn") {
      if (warnSeen) severity = "uncommon";
      else warnSeen = true;
    }
    if (!name || !desc) continue;
    out.push({ name, desc, severity });
    if (out.length >= 3) break;
  }
  return out;
}

// ── Call Claude to generate side effects for one medication ─────────────────
export async function generateCommonSideEffects({ name, composition } = {}) {
  if (!ANTHROPIC_KEY) return null;
  if (!name || !String(name).trim()) return null;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        temperature: 0,
        system: SYSTEM_PROMPT,
        tools: [SIDE_EFFECTS_TOOL],
        tool_choice: { type: "tool", name: SIDE_EFFECTS_TOOL.name },
        messages: [{ role: "user", content: buildUserMessage({ name, composition }) }],
      }),
    });

    if (!resp.ok) {
      error("generate", `Claude API error: ${resp.status}`);
      return null;
    }

    const data = await resp.json();
    const toolUse = (data.content || []).find(
      (c) => c.type === "tool_use" && c.name === SIDE_EFFECTS_TOOL.name,
    );
    if (!toolUse || !toolUse.input) return null;
    return sanitizeEntries(toolUse.input.common_side_effects);
  } catch (e) {
    error("generate", "failed:", e.message);
    return null;
  }
}

// ── Background fill: generate + persist for a medication row, but only if
// the row still has no common_side_effects (so we don't clobber values the
// extractor or a manual edit already wrote). Safe to fire-and-forget.
export async function backfillCommonSideEffectsForMed(medicationId) {
  const id = Number(medicationId);
  if (!Number.isFinite(id) || id <= 0) return;

  try {
    const cur = await pool.query(
      `SELECT id, name, composition, common_side_effects
         FROM medications
        WHERE id = $1`,
      [id],
    );
    const row = cur.rows[0];
    if (!row) return;
    const existing = Array.isArray(row.common_side_effects) ? row.common_side_effects : [];
    if (existing.length > 0) return;

    const effects = await generateCommonSideEffects({
      name: row.name,
      composition: row.composition,
    });
    if (!Array.isArray(effects) || effects.length === 0) return;

    await pool.query(
      `UPDATE medications
          SET common_side_effects = $1::jsonb,
              updated_at = NOW()
        WHERE id = $2
          AND jsonb_array_length(COALESCE(common_side_effects, '[]'::jsonb)) = 0`,
      [JSON.stringify(effects), id],
    );
    info("backfill", `filled ${effects.length} side effects for med #${id} (${row.name})`);
  } catch (e) {
    error("backfill", "failed:", e.message);
  }
}
