import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import pool from "../../config/db.js";
import { formulaAsNames, formulaInputs } from "../../../shared/labFormula.js";
import { assertFormulaFits, formulaFieldsOf } from "./write.js";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;
const MAX_TEXT = 500;

const Answer = z.object({
  formula: z.string(),
  problem: z.string(),
});

const SYSTEM = `You turn a lab technician's description of a calculated lab value into a formula for a hospital lab system.

Write the formula with ONLY these pieces, separated by spaces:
- a field of this report, written as #<id> using the ids listed (never a name, never an id that is not listed)
- @age (patient's age in years), @female (1 for a woman, 0 for a man), @weight (today's weight in kg)
- numbers such as 100 or 0.9 (a leading minus is allowed)
- + - * / ^ ( ) and the functions min( a , b ) and max( a , b )

Rules, all strict:
- Use the fields the description names. Match a name loosely ("TLC", "total count" and "Total Leucocyte Count" are the same field), but if a value the description needs is not in the list, return an empty formula and say which value is missing in "problem".
- Use a published equation (for example Friedewald LDL or CKD-EPI 2021) only when the description names it, and write it in full with its own constants.
- Never add a step, constant or unit conversion the description does not ask for or the named equation does not contain.
- If the description is unclear or is not a calculation, return an empty formula and say what to write instead in "problem", in one short plain sentence.
- When the formula is fine, "problem" is "".`;

const fail = (status, message) => Object.assign(new Error(message), { status });

export async function formulaFromText(
  reportId,
  { text, fieldId = null },
  db = pool,
  ai = anthropic,
) {
  const wanted = String(text || "").trim();
  if (!wanted) throw fail(400, "Write the formula in words first");
  if (wanted.length > MAX_TEXT) throw fail(400, `Keep it under ${MAX_TEXT} characters`);
  if (!ai) throw fail(503, "AI is not set up on this server — build the formula with the buttons");

  const fields = (await formulaFieldsOf(reportId, db)).filter(
    (f) => String(f.id) !== String(fieldId),
  );
  if (!fields.length) throw fail(400, "This report has no number fields to calculate from");
  const list = fields.map((f) => `#${f.id}  ${f.name}${f.unit ? ` (${f.unit})` : ""}`).join("\n");

  let response;
  try {
    response = await ai.messages.parse(
      {
        model: "claude-opus-5-5",
        max_tokens: 4000,
        system: SYSTEM,
        output_config: { effort: "medium", format: zodOutputFormat(Answer) },
        messages: [
          {
            role: "user",
            content: `FIELDS OF THIS REPORT:\n${list}\n\nDESCRIPTION:\n${wanted}`,
          },
        ],
      },
      { timeout: 60_000 },
    );
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError)
      throw fail(503, "The AI is busy — try again in a minute");
    if (e instanceof Anthropic.APIError) throw fail(502, "The AI could not be reached — try again");
    throw e;
  }
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw fail(422, "The AI could not read that — try other words or use the buttons");
  }

  const { formula, problem } = response.parsed_output;
  const cleaned = formula.trim();
  if (!cleaned) throw fail(422, problem || "The AI could not turn that into a formula");

  try {
    await assertFormulaFits({ reportId, fieldId, formula: cleaned }, db);
  } catch (e) {
    throw fail(422, `The AI's attempt did not pass the checks (${e.message}) — try other words`);
  }

  const names = new Map(fields.map((f) => [String(f.id), f.name]));
  return {
    formula: cleaned,
    readsAs: formulaAsNames(cleaned, (key) => names.get(String(key))),
    inputs: formulaInputs(cleaned).map(String),
  };
}
