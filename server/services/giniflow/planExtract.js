import pool from "../../config/db.js";
import { parseClaudeJson } from "../extraction.js";
import { getTestPanels } from "./moStation.js";

// Reads the plan the MO already typed and points at the controls underneath it.
//
// docs/gini-flow/08-MO-SD-STATION-PLAN.md — the Plan textarea sits directly above
// "Suggest to the doctor" (four fields) and "Tests to order" (six panels and
// twenty-five chips). An MO who has written "start Vit D, recheck TSH and B12
// next visit" then hunts three chips out of twenty-five and fills a form with
// what they just said. The sentence already holds the answer.
//
// THIS EXTRACTS, IT DOES NOT AUTHOR. It is given the MO's own words and returns
// only what those words name — never a test the plan does not mention, never a
// dose the plan does not state. Nothing here reaches the database: the endpoint
// returns a proposal, the chips light up, and the MO confirms. That is the whole
// safety property, and it is why this is a separate module from anything that
// writes.
//
// Model: Haiku. This is a matching task against a fixed catalogue, not clinical
// reasoning, and the MO is watching the chips light up as they read the answer.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM = `You are a parser for a hospital's OPD software. You are given a medical officer's own free-text plan for one patient, a catalogue of orderable tests, and that patient's active medicines.

Return ONLY valid JSON, no backticks, no prose:
{
  "tests": ["exact catalogue name", ...],
  "urgency": "today" | "tomorrow" | "next_visit" | null,
  "proposals": [{"medicineName": "...", "fromDose": "...", "toDose": "...", "reason": "..."}],
  "unmatched": ["a test the plan asks for that is not in the catalogue", ...]
}

Rules, all of them strict:
- Extract ONLY what the plan explicitly asks for. Never add a test, medicine or dose the plan does not name, however clinically sensible it would be. If the plan names nothing, return empty arrays.
- "tests" must use the EXACT catalogue names given. If the plan names a test that is not in the catalogue, put the MO's own wording in "unmatched" instead — never substitute a near-match.
- A panel name in the plan ("lipid panel", "kidney panel") expands to that panel's tests.
- "urgency" only when the plan says when: "today"/"now"/"stat" -> today; "tomorrow" -> tomorrow; "next visit"/"in 3 months"/"at follow-up" -> next_visit. Otherwise null.
- "proposals" are medicine CHANGES the plan suggests. "fromDose" must be the patient's current dose from the active-medicine list, or "" if the medicine is new to them. "toDose" is what the plan asks for. "reason" is the MO's own stated reason, quoted or closely paraphrased — never invented. If the plan gives no reason, use "".
- Stopping a medicine is a proposal with toDose "stop".
- Ignore anything that is observation rather than instruction. "BP was high today" is not a test order.`;

// The MO writes prose, not a form, so a short plan is normal and a long one is
// a paste. Both are cheap; the cap is a runaway guard, not a limit anyone meets.
const MAX_PLAN_CHARS = 6000;

export async function extractPlan(visitId, planText, db = pool) {
  const plan = String(planText || "").trim();
  if (!plan) {
    throw Object.assign(new Error("Write the plan first — there is nothing to read yet"), {
      status: 400,
    });
  }
  if (!ANTHROPIC_KEY) {
    throw Object.assign(new Error("AI is not configured on this server"), { status: 503 });
  }

  const [{ panels, tests }, { rows: meds }] = await Promise.all([
    getTestPanels(db),
    db.query(
      `SELECT m.name, m.dose, m.frequency
         FROM medications m
         JOIN giniflow_visits v ON v.patient_id = m.patient_id
        WHERE v.id = $1 AND m.is_active = true
        ORDER BY m.name`,
      [visitId],
    ),
  ]);

  const catalogue = tests.map((t) => t.name);
  const panelLines = panels.map((p) => `${p.label}: ${(p.tests || []).join(", ")}`);
  const medLines = meds.map((m) => `${m.name} — ${m.dose || "?"} ${m.frequency || ""}`.trim());

  const userText = [
    `CATALOGUE (use these exact names):\n${catalogue.join(", ")}`,
    `PANELS:\n${panelLines.join("\n")}`,
    `PATIENT'S ACTIVE MEDICINES:\n${medLines.length ? medLines.join("\n") : "(none on record)"}`,
    `THE MEDICAL OFFICER'S PLAN:\n${plan.slice(0, MAX_PLAN_CHARS)}`,
  ].join("\n\n");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{ role: "user", content: userText }],
    }),
    // A model that never answers must not hold the MO's screen. The button
    // fails and they carry on tapping chips by hand, which still works.
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => {
    throw Object.assign(new Error(`Could not reach the AI service: ${e.message}`), { status: 502 });
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw Object.assign(new Error(`AI request failed (${resp.status}): ${body.slice(0, 160)}`), {
      status: 502,
    });
  }

  const json = await resp.json();
  const { data, error } = parseClaudeJson(json?.content?.[0]?.text || "");
  if (error || !data) {
    throw Object.assign(new Error("Could not read the AI's answer — try again"), { status: 502 });
  }

  // The catalogue is the authority, not the model. A name that is not in it is
  // dropped rather than passed to the order, which would fail at the price
  // lookup or, worse, order a test nobody stocks.
  const known = new Map(catalogue.map((n) => [n.toLowerCase(), n]));
  const matched = [];
  const unmatched = [...new Set((data.unmatched || []).map(String))];
  for (const raw of data.tests || []) {
    const hit = known.get(String(raw).trim().toLowerCase());
    if (hit) matched.push(hit);
    else unmatched.push(String(raw));
  }

  const URGENCIES = ["today", "tomorrow", "next_visit"];
  return {
    tests: [...new Set(matched)],
    urgency: URGENCIES.includes(data.urgency) ? data.urgency : null,
    proposals: (data.proposals || [])
      .filter((p) => p && String(p.medicineName || "").trim())
      .slice(0, 6)
      .map((p) => ({
        medicineName: String(p.medicineName).trim(),
        fromDose: String(p.fromDose || "").trim(),
        toDose: String(p.toDose || "").trim(),
        reason: String(p.reason || "").trim(),
      })),
    unmatched: [...new Set(unmatched)],
  };
}
