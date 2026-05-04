import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { runSummaryRules } from "../services/summaryRules.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";
import { extractDiagnosisGrade } from "../utils/diagnosisGrade.js";
import { buildVisitLabContext } from "../services/visitLabContext.js";

const router = Router();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// In-memory single-flight: while a summary is being generated for a given
// (patient, appointment) key, concurrent requests await the same promise
// instead of each kicking off its own Anthropic call.
const inFlight = new Map();

// Add cache columns if not present
pool
  .query(
    `
  ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS ai_summary JSONB,
    ADD COLUMN IF NOT EXISTS ai_summary_generated_at TIMESTAMPTZ
`,
  )
  .catch(() => {});

// ── AI brief generation (server-side, same logic as patientBrief.js) ──────────

const SYSTEM_PROMPT = `You are a junior endocrinology resident giving a verbal pre-visit handoff to your senior consultant just before they walk in to see the patient. Speak the way a junior doctor actually briefs a senior — flowing clinical prose, respectful, concise.

OUTPUT FORMAT — NON-NEGOTIABLE:
Your entire response must be a single valid JSON object and nothing else. No prose before it, no prose after it, no markdown fences. The JSON must have exactly these four fields: { "narrative": string, "red_alerts": string[], "amber_alerts": string[], "green_notes": string[] }. Every value must be properly escaped JSON. Newlines inside the narrative string must be encoded as \\n. Do not break the JSON.

THE FIRST WORDS OF THE "narrative" FIELD MUST BE THE PATIENT'S FULL NAME, taken verbatim from the input ("Patient full name" line). The brief must open with the full name. If you do not start with the patient's full name, the brief is wrong. Never start the narrative with "Sir", "Ma'am", "This patient", "The patient", "She is", "He is", or any pronoun.

Required opening pattern for the narrative (exact shape, only swap in real values):
"<Full Name> is a <age>-year-old <woman|man>, here today for her/his <Nth> visit; she/he has been with us on the Gini programme for <Xy Ym> and is currently in <Care Phase>."

Always state the time on programme using EXACTLY the pre-formatted value supplied to you on the "Time on Gini programme:" line of the input — do not reformat it. Acceptable forms are "Xy Ym" (e.g. "2y 5m"), "Nm" (e.g. "6m"), "Nd" (e.g. "12d") for less than a month, or the literal phrase "new patient (first visit today)". Never write "X months", "X years", or "X days" — always the compact form. Never invent or recompute the number; copy the supplied value verbatim.

If the supplied time-on-programme is "new patient (first visit today)", REPLACE the standard opener entirely with:
"<Full Name> is a <age>-year-old <woman|man>, here today for her/his first visit on the Gini programme; she/he is currently in <Care Phase>."
Do NOT mention any duration, "0m", "0d", or "for 0 ..." — the patient is brand new today.

After that opener, the narrative must continue as 130–180 words of flowing prose split into THREE short paragraphs separated by a blank line ("\\n\\n"):

Paragraph 1 — Identity (one or two sentences, MUST start with the full name using the required opening pattern). Identify name → age → sex → visit number → time on Gini programme → care phase. Nothing clinical yet.

Paragraph 2 — Active conditions, each paired with its supporting vital/biomarker. Walk through each active diagnosis in order of clinical priority (most acute first). For every condition, weave in the specific supporting number(s) and trend direction from the data — never a diagnosis without a value. Example flow: "Her type 2 diabetes is poorly controlled today, with HbA1c at 7.7% (up from 6.8%) and FBS at 271 mg/dL. Her hypertension remains uncontrolled at 160/80 despite dual therapy. Her CKD has progressed, with eGFR down to 39 mL/min/1.73m² from 77, and creatinine now 1.58 mg/dL. Her dyslipidaemia is well-controlled, with LDL at 83 mg/dL."

Paragraph 3 — Current medications and what to flag. State explicitly what the patient is currently on, by drug name and dose, in one fluent sentence — e.g. "She is currently on metformin 1g BD, telmisartan 40 mg OD, atorvastatin 20 mg HS, and dapagliflozin 10 mg OD." If the active-medications list is empty, say so plainly — e.g. "She is currently on no active medications." — and STOP. Do NOT enumerate, name, or list the discontinued drugs as a substitute, even if that is the only medication context available. Then close with one short sentence flagging the single most acute issue you'd want the senior to address today. If — and only if — a specific recent stop is the direct cause of a measured biomarker change, you may refer to it generically by drug class ("after antidiabetic therapy was held two days ago"), but never by drug name, never as a list, and never to fill space.

Voice & style for the narrative:
- First-person plural resident voice: "we", "her last labs showed...", "she is currently on...".
- Plain narrative prose only — no headings, no bullets, no markdown, no emojis, no section labels, no colon-lists.
- Present tense for current status; past tense for what has happened.
- Use only CURRENT-VISIT active medications by name (the "Active medications — CURRENT VISIT" list in the input). NEVER name stopped, discontinued, or previous-visit drugs in the narrative — not in the current-meds sentence, not as a parenthetical, not as a list, not anywhere.
- "Previous-visit medications" in the input are drugs still flagged active in the chart but NOT re-prescribed at today's visit. They are CONTEXT ONLY — do NOT include them in the "currently on …" sentence, do NOT merge them with the current-visit list, do NOT enumerate them. If the current-visit list is non-empty, the "currently on …" sentence must contain ONLY those drugs and nothing from the previous-visit bucket. If the current-visit list is empty, say "no medications were prescribed at today's visit" and STOP — do NOT fall back to listing previous-visit drugs.
- Stopped meds may only appear as anonymous class-level reasoning ("antihypertensive therapy was held"), and only when needed to explain a specific biomarker shift. If you find yourself listing more than zero stopped or previous-visit drug names in the narrative, you have made an error — rewrite it.
- Use exact numbers, units, drug names, and doses from the input. Do not invent data.

DIAGNOSIS FORMAT STANDARD (applies to EVERY diagnosis you mention — primary, comorbid, complication, or incidental — in narrative AND alerts):
- ABSOLUTE GRADE/STAGE/SEVERITY RULE (highest priority — failure to follow this invalidates the entire brief): If the input line for a diagnosis carries a "grade/marker:", "severity:", or "stage" value (e.g. "grade/marker: moderate NPDR", "severity: Grade 2", "Stage 3"), that exact grade/stage/severity token MUST appear attached to the diagnosis name in BOTH the narrative AND any alert mentioning it — verbatim, in the same mention, never separated, never dropped, never paraphrased. Examples: input "diabetic retinopathy · grade/marker: moderate NPDR" → must say "moderate NPDR" or "diabetic retinopathy (moderate NPDR)", never bare "retinopathy". Input "fatty liver · grade/marker: Grade 2" → "Grade 2 fatty liver", never bare "fatty liver". Input "CKD · grade/marker: Stage 3 (G3a/A2)" → "CKD Stage 3 (G3a/A2)", never bare "CKD" or "kidney disease". If you write a complication or condition name without its grade when the grade is in the input, the brief is wrong — rewrite it.
- NEVER lump two graded complications into a single phrase ("neuropathy and retinopathy as complications"). Each complication must be named separately with its own grade/severity/marker attached, even if it makes the sentence longer.
- Never name a condition by its bare label when the input carries ANY of the following qualifiers: grade, stage, severity, class, type, marker, duration, since-year, age-of-onset (AOO), status, or trend. Always inline EVERY qualifier present in the input, verbatim, immediately attached to the diagnosis name.
- Specifically: if the input shows "since 2015", "Duration: Since 2015", "since 2008", or an AOO value, you MUST state it (e.g. "type 2 diabetes since 2015 (AOO 44)", "hypertension since 2008"). Do NOT drop "since <year>" or AOO — these are part of the diagnosis label.
- Acceptable shapes: "type 2 diabetes since 2015 (AOO 44), well-controlled", "hypertension since 2008, controlled", "CKD Stage 3 (G3a/A2)", "moderate NPDR", "NYHA II heart failure", "Grade 2 fatty liver", "MASLD (no liver enzymes on file)", "diabetic neuropathy", "diabetic nephropathy (A2, microalbuminuria)".
- If multiple qualifiers exist (since + AOO, stage + class, severity + type, etc.) state ALL of them in the same mention — do not pick one and drop the rest.
- Do not paraphrase qualifiers into vague words (never reduce "Stage 3 CKD" to "kidney disease"; never reduce "G3a/A2" to "mixed signals"; never drop "since 2015" because it feels like clutter). Qualifiers from the input must appear verbatim, in the same mention as the diagnosis.
- This applies to comorbidities and incidental diagnoses too — if "MASLD", "anxiety spells", "post CK arthralgia", "sinusitis", "dual adiposity" appear in the input, list each by name in the active-problem walk-through. Do not collapse them into a vague phrase like "and other comorbidities".

NUMBER FORMAT STANDARD (applies to every biomarker, vital, or lab value you cite, in narrative AND alerts):
- Always cite a value WITH its unit (e.g. "7.7%", "124 mg/dL", "143/96 mmHg", "108 mL/min/1.73m²", "10.4 g/dL"). Never a bare number.
- Whenever a previous value is available in the input, state the current value AND the previous value in the form "<current> <unit> from <previous> <unit>" (e.g. "HbA1c 7.7% from 5.1%", "FBS 124 mg/dL from 88 mg/dL", "haemoglobin 10.4 g/dL from 13.4 g/dL", "eGFR 108 mL/min/1.73m² from 92"). The unit may be omitted on the "from" half only when it is identical and obvious.
- Use this same "X from Y" shape for every value with a prior — do not mix "up to 7.7% from 5.1%", "down to 39 from 77", and "now 1.58, previously 1.4" within the same brief. One shape, applied uniformly across the narrative and all alert lines.
- If no previous value exists, state the current value alone with its unit and do not invent a prior.
- Every diagnosis mentioned in the narrative must be paired with at least one supporting number in this format.

red_alerts, amber_alerts, green_notes are arrays of single-sentence items (max 3 each).

Use BOTH the rule-engine alerts AND the lab panel below as source material.
When a lab has a prior value, compare: note direction (↑/↓), magnitude, and whether it crossed into/out of target range.
Prefer lab-grounded observations (with exact numbers, units, and delta vs. previous) over generic rule restatements.
Do not hallucinate — only use numbers that appear in the data below.

Handling stopped medications:
- Never lump different drug classes into one sentence like "multiple medications discontinued". Each stopped drug of a high-weight class (thyroid, antihypertensive, antidiabetic, statin, antiplatelet, anticoagulant) gets its own specific red_alert naming the drug, days since stop, and the class-specific consequence.
- When a stop coincides with a corroborating lab/vital change (BP up after an antihypertensive stop, TSH up after thyroid stop, LDL up after statin stop, FBS up after antidiabetic stop), state the link explicitly with exact numbers from the data.
- Supplements and symptomatic drugs (already flagged [AMBER] by the rule engine) belong in amber_alerts, never red_alerts. Do not promote them.
- If there are more high-weight stops than red slots, keep the ones with visible clinical consequence first, then longest gap, then most critical class. Drop the lowest-priority stop entirely rather than merging it into a generic bullet.`;

// Returns a string like "2y 5m" / "6m" / "12d" / "new patient (first visit today)".
// `totalDays` is the precise day count since first visit; preferred when months=0.
function fmtDuration(totalMonths, totalDays = null) {
  if (totalMonths == null || isNaN(totalMonths)) return "?";
  const m = Math.max(0, Math.floor(Number(totalMonths)));
  const y = Math.floor(m / 12);
  const rem = m % 12;
  if (m === 0) {
    const d = totalDays == null ? null : Math.max(0, Math.floor(Number(totalDays)));
    if (d == null) return "0m";
    if (d === 0) return "new patient (first visit today)";
    return `${d}d`;
  }
  if (y === 0) return `${rem}m`;
  if (rem === 0) return `${y}y`;
  return `${y}y ${rem}m`;
}

function formatAlerts(alerts) {
  const lines = [];
  for (const a of alerts.red) lines.push(`[RED]   ${a.title}${a.detail ? " — " + a.detail : ""}`);
  for (const a of alerts.amber) lines.push(`[AMBER] ${a.title}${a.detail ? " — " + a.detail : ""}`);
  for (const a of alerts.green) lines.push(`[GREEN] ${a.title}${a.detail ? " — " + a.detail : ""}`);
  return lines.join("\n");
}

// Format labHistory as a compact table with latest + previous values for comparison.
// labHistory: { [testName]: [{ result, unit, flag, date }, ...] }  (newest-first)
function formatLabs(labHistory) {
  if (!labHistory || typeof labHistory !== "object") return "No labs available.";
  const entries = Object.entries(labHistory);
  if (entries.length === 0) return "No labs available.";

  const fmtDate = (d) => {
    if (!d) return "?";
    try {
      return new Date(d).toISOString().slice(0, 10);
    } catch {
      return String(d);
    }
  };
  const numeric = (v) => {
    if (v == null) return null;
    const m = String(v).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };

  // Sort by recency of latest value, keep up to 25 tests to bound prompt size.
  const ranked = entries
    .map(([name, hist]) => ({ name, hist: Array.isArray(hist) ? hist : [] }))
    .filter((e) => e.hist.length > 0)
    .sort((a, b) => new Date(b.hist[0].date || 0) - new Date(a.hist[0].date || 0))
    .slice(0, 25);

  const lines = ranked.map(({ name, hist }) => {
    const latest = hist[0];
    const prev = hist[1];
    const unit = latest.unit || "";
    const flag = latest.flag ? ` [${latest.flag}]` : "";
    let line = `${name}: ${latest.result ?? "?"} ${unit}${flag} (${fmtDate(latest.date)})`;
    if (prev) {
      const ln = numeric(latest.result);
      const pn = numeric(prev.result);
      let delta = "";
      if (ln != null && pn != null) {
        const diff = ln - pn;
        const pct = pn !== 0 ? ((diff / pn) * 100).toFixed(1) : null;
        const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
        delta = ` ${arrow} ${diff > 0 ? "+" : ""}${diff.toFixed(2)}${pct != null ? ` (${pct}%)` : ""}`;
      }
      line += ` | prev ${prev.result ?? "?"} ${prev.unit || ""}${prev.flag ? ` [${prev.flag}]` : ""} on ${fmtDate(prev.date)}${delta}`;
    } else {
      line += ` | no prior value`;
    }
    return line;
  });
  return lines.join("\n");
}

function fmtMedList(meds, label) {
  if (!meds || meds.length === 0) return `${label}: (none)`;
  const lines = meds.map((m) => {
    const bits = [m.name];
    if (m.dose) bits.push(m.dose);
    if (m.frequency) bits.push(m.frequency);
    if (m.timing) bits.push(`(${m.timing})`);
    if (m.started_date) bits.push(`started ${String(m.started_date).slice(0, 10)}`);
    if (m.stopped_date) bits.push(`stopped ${String(m.stopped_date).slice(0, 10)}`);
    if (m.stop_reason) bits.push(`reason: ${m.stop_reason}`);
    return `  - ${bits.join(" · ")}`;
  });
  return `${label}:\n${lines.join("\n")}`;
}

function fmtVitals(vitals) {
  if (!vitals || vitals.length === 0) return "Vitals: (none recorded)";
  const lines = vitals.slice(0, 5).map((v) => {
    const parts = [];
    if (v.bp_sys || v.bp_dia) parts.push(`BP ${v.bp_sys || "?"}/${v.bp_dia || "?"}`);
    if (v.pulse) parts.push(`HR ${v.pulse}`);
    if (v.spo2) parts.push(`SpO2 ${v.spo2}%`);
    if (v.temp) parts.push(`Temp ${v.temp}`);
    if (v.weight) parts.push(`Wt ${v.weight}kg`);
    if (v.bmi) parts.push(`BMI ${v.bmi}`);
    if (v.waist) parts.push(`Waist ${v.waist}`);
    const date = v.recorded_at ? String(v.recorded_at).slice(0, 10) : "";
    return `  - ${date} · ${parts.join(", ")}`;
  });
  return `Vitals (most recent first, up to 5):\n${lines.join("\n")}`;
}

function fmtPrep(prep) {
  if (!prep) return "Compliance & symptoms (since last visit): (not recorded)";
  const out = [];
  out.push(`  Reported compliance: ${prep.medPct != null ? prep.medPct + "%" : "not recorded"}`);
  if (prep.missed) {
    const missed = Array.isArray(prep.missed) ? prep.missed.join(", ") : String(prep.missed);
    if (missed) out.push(`  Missed doses: ${missed}`);
  }
  if (prep.symptoms && prep.symptoms.length) {
    const syms = prep.symptoms
      .map((s) => (typeof s === "string" ? s : s?.label || s?.name || s?.text))
      .filter(Boolean)
      .join(", ");
    if (syms) out.push(`  Symptoms reported: ${syms}`);
  }
  return `Compliance & symptoms (since last visit):\n${out.join("\n")}`;
}

function fmtDiagnoses(diagnoses) {
  if (!diagnoses || diagnoses.length === 0) return "Diagnoses: (none recorded)";
  const lines = diagnoses.slice(0, 15).map((d) => {
    const baseLabel = d.label || d.name || "Unknown";
    const grade = extractDiagnosisGrade(d);
    const labelWithGrade = grade ? `${baseLabel} (${grade})` : baseLabel;
    const bits = [labelWithGrade];
    if (d.since || d.since_year) bits.push(`since ${d.since || d.since_year}`);
    if (d.age_of_onset) bits.push(`AOO ${d.age_of_onset}`);
    if (d.duration) bits.push(`duration: ${d.duration}`);
    if (d.complication_type) bits.push(`type: ${d.complication_type}`);
    if (grade) bits.push(`MUST-INCLUDE grade/marker verbatim in narrative: ${grade}`);
    if (d.status) bits.push(`status: ${d.status}`);
    if (d.trend) bits.push(`trend: ${d.trend}`);
    if (d.is_active === false) bits.push("(inactive)");
    return `  - ${bits.join(" · ")}`;
  });
  return `Diagnoses (full list — include grade/stage/severity verbatim when present):\n${lines.join("\n")}`;
}

async function generateAiBrief(patient, diagnoses, alerts, labHistory, ctx = {}) {
  if (!ANTHROPIC_KEY) {
    console.warn("[summary AI] ANTHROPIC_API_KEY not set — skipping narrative");
    return { error: "ANTHROPIC_API_KEY not configured on server" };
  }
  const total = alerts.red.length + alerts.amber.length + alerts.green.length;
  const isFirstVisit = (ctx.totalVisits ?? 0) <= 1;
  if (total === 0 && !isFirstVisit) {
    console.warn("[summary AI] no rule alerts — skipping narrative");
    return { error: "No rule-engine alerts produced for this patient — narrative skipped" };
  }
  if (total === 0 && isFirstVisit) {
    console.log("[summary AI] no rule alerts but first visit — generating basic intro narrative");
  }
  // First attempt; on null/empty narrative, retry with backoff (transient API
  // or model-format hiccups are common; one retry hides most of them).
  let result = await _generateAiBriefInner(patient, diagnoses, alerts, labHistory, ctx, "1");
  if (!result || !result.narrative) {
    const firstError = result?.error || "unknown failure";
    console.warn(
      `[summary AI] first attempt produced no narrative (${firstError}) — retrying once after backoff`,
    );
    await new Promise((r) => setTimeout(r, 1500));
    const retry = await _generateAiBriefInner(patient, diagnoses, alerts, labHistory, ctx, "2");
    if (retry && retry.narrative) return retry;
    const finalError = retry?.error || firstError;
    console.error(`[summary AI] both attempts failed — reason: ${finalError}`);
    return { error: finalError };
  }
  return result;
}

async function _generateAiBriefInner(
  patient,
  diagnoses,
  alerts,
  labHistory,
  ctx,
  attemptLabel = "1",
) {
  const fullName = (patient?.name || "").trim() || "Patient";
  const totalAlerts = alerts.red.length + alerts.amber.length + alerts.green.length;
  const isFirstVisit = (ctx.totalVisits ?? 0) <= 1;
  const basicMode = totalAlerts === 0 && isFirstVisit;
  const sexWord =
    patient?.sex && /^m/i.test(patient.sex)
      ? "man"
      : patient?.sex && /^f/i.test(patient.sex)
        ? "woman"
        : "patient";
  const userContent = [
    `Patient full name (USE THIS VERBATIM as the very first words of the narrative): ${fullName}`,
    `Patient: ${patient?.name || "Unknown"}, ${patient?.age ?? "?"}y${patient?.sex ? ", " + patient.sex : ""}`,
    `Sex word (use in narrative opener): ${sexWord}`,
    `Phone: ${patient?.phone || "—"}`,
    `Patient ID / file: ${patient?.file_no || patient?.id || "—"}`,
    `Visit number: ${ctx.totalVisits ?? "?"}`,
    `Time on Gini programme: ${fmtDuration(ctx.monthsWithGini, ctx.daysWithGini)} (raw months: ${ctx.monthsWithGini ?? "?"}, raw days: ${ctx.daysWithGini ?? "?"})`,
    `Use the exact format above verbatim when stating duration in the narrative. If the value is "new patient (first visit today)", do NOT mention any time-on-programme phrase at all — instead frame the opener as a brand-new patient (e.g. "Shivani is a 43-year-old woman, here today for her first visit on the Gini programme."). Otherwise use "Xy Ym" / "Nm" / "Nd" exactly as given.`,
    `Care phase: ${ctx.carePhase ?? "?"}`,
    `Active medications count: ${ctx.activeMedsCount ?? "?"}`,
    ``,
    fmtDiagnoses(diagnoses),
    ``,
    fmtMedList(
      ctx.activeMeds || [],
      "Active medications — CURRENT VISIT (re-prescribed today; THESE are the only drugs the patient is 'currently on' — name these in the current-meds sentence)",
    ),
    ``,
    fmtMedList(
      ctx.prevVisitMeds || [],
      "Previous-visit medications (still flagged active in the chart but NOT re-prescribed at today's visit — context only; do NOT name these in the 'currently on …' sentence, do NOT list them as active drugs, do NOT mix them with the current-visit list)",
    ),
    ``,
    fmtMedList(ctx.stoppedMeds || [], "Recently stopped (last 60 days)"),
    ``,
    fmtVitals(ctx.vitals || []),
    ``,
    fmtPrep(ctx.prep),
    ``,
    `Rule engine alerts:`,
    formatAlerts(alerts),
    ``,
    `Lab panel (latest vs. previous, newest tests first):`,
    formatLabs(labHistory),
    ``,
    basicMode
      ? `BASIC INTRO MODE — this is a brand-new patient on their first visit with no rule-engine alerts and likely minimal clinical data. Do NOT follow the full 130–180 word three-paragraph structure. Instead, produce a SHORT 2–4 sentence intro narrative (60–100 words, single paragraph, no blank lines) that:
         (1) opens with the required first-visit opener: "${fullName} is a <age>-year-old <woman|man>, here today for her/his first visit on the Gini programme; she/he is currently in <Care Phase>.",
         (2) briefly notes any diagnoses present in the input (with grades/qualifiers verbatim) — if none, say "no prior diagnoses on file",
         (3) briefly notes current active medications by name & dose — if none, say "no active medications on file",
         (4) closes by stating this is an initial visit and a baseline workup / history-taking is what's needed today.
         Do NOT invent labs, vitals, or biomarker values. Do NOT fabricate diagnoses. Return red_alerts: [], amber_alerts: [], green_notes: [] as empty arrays. Return only valid JSON with fields narrative, red_alerts, amber_alerts, green_notes.`
      : `Generate the clinical briefing as described in the system prompt. Return only valid JSON with fields narrative, red_alerts, amber_alerts, green_notes. The "narrative" string MUST begin with the patient's full name "${fullName}" — start the narrative literally with: "${fullName} is a ...". When labs or vitals have changed meaningfully vs. previous, surface that in the narrative and the appropriate zone with exact numbers and delta. Cross-reference active medications against diagnoses to flag protocol gaps (e.g. nephropathy without ACE/ARB, CAD without statin/aspirin) and stopped high-weight drugs against their corresponding biomarker trends.`,
  ].join("\n");

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
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const reason = `Anthropic API ${resp.status}: ${body.slice(0, 200)}`;
      console.error(`[summary AI attempt=${attemptLabel}] ${reason}`);
      return { error: reason };
    }
    const data = await resp.json();
    const stopReason = data.stop_reason || "";
    let text = (data.content || []).map((c) => c.text || "").join("");
    text = text
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    // Extract the first {...} block in case the model added stray prose around it
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
    const parsed = safeParseJson(text);
    if (parsed) {
      const narrative = typeof parsed.narrative === "string" ? parsed.narrative.trim() : null;
      if (!narrative) {
        const reason = `Parsed JSON but "narrative" field was empty or non-string`;
        console.error(`[summary AI attempt=${attemptLabel}] ${reason}`);
        return { error: reason };
      }
      return {
        narrative,
        red: (parsed.red_alerts || []).slice(0, 3),
        amber: (parsed.amber_alerts || []).slice(0, 3),
        green: (parsed.green_notes || []).slice(0, 3),
      };
    }
    // ── Last-resort recovery ──
    // Strict JSON parse failed (almost always: the model emitted an unescaped
    // double-quote or control char inside the "narrative" string). The
    // narrative is the only field we actually need (alerts come from the rule
    // engine), so pull it out by regex from the raw text. This converts most
    // "Model returned malformed JSON" failures into a successful response.
    const recovered = recoverNarrativeFromRaw(text);
    if (recovered) {
      console.warn(
        `[summary AI attempt=${attemptLabel}] strict JSON parse failed; recovered narrative via regex (stop_reason=${stopReason || "unknown"})`,
      );
      return { narrative: recovered, red: [], amber: [], green: [] };
    }
    const reason =
      stopReason === "max_tokens"
        ? `Model output truncated at max_tokens — JSON incomplete`
        : `Model returned malformed JSON (stop_reason=${stopReason || "unknown"})`;
    console.error(`[summary AI attempt=${attemptLabel}] ${reason}`);
    console.error(`[summary AI attempt=${attemptLabel}] raw text:`, text.slice(0, 600));
    return { error: reason };
  } catch (err) {
    const reason = `Network/runtime error: ${err?.message || String(err)}`;
    console.error(`[summary AI attempt=${attemptLabel}] ${reason}`);
    return { error: reason };
  }
}

// Tolerant JSON parser: tries strict parse first, then strips control chars
// (raw newlines/tabs/etc inside string values are the most common cause of
// JSON.parse failures from LLM output) and tries once more.
// Pulls the value of the "narrative" JSON field out of a model response that
// failed strict parsing. Tolerates unescaped quotes inside the value by
// stopping at the next top-level field marker (`"red_alerts"`, `"amber_alerts"`,
// `"green_notes"`) or the closing `}` of the object.
function recoverNarrativeFromRaw(text) {
  if (!text || typeof text !== "string") return null;
  const startMatch = text.match(/"narrative"\s*:\s*"/);
  if (!startMatch) return null;
  const start = startMatch.index + startMatch[0].length;
  // Anchor on the next sibling field NAME (not the punctuation around it),
  // so a stray `}` or missing comma between fields can't fool us.
  const tail = text.slice(start);
  const sentinels = [/"red_alerts"\s*:/, /"amber_alerts"\s*:/, /"green_notes"\s*:/];
  let nextFieldAbs = -1;
  for (const re of sentinels) {
    const m = tail.match(re);
    if (m) {
      const idx = start + m.index;
      if (nextFieldAbs === -1 || idx < nextFieldAbs) nextFieldAbs = idx;
    }
  }
  // The narrative's true closing `"` is the LAST `"` that appears strictly
  // before the next sibling field (or before the end of the text).
  const searchUpTo = nextFieldAbs !== -1 ? nextFieldAbs : text.length;
  const window = text.slice(start, searchUpTo);
  const lastQuote = window.lastIndexOf('"');
  if (lastQuote <= 0) return null;
  let body = window.slice(0, lastQuote);
  body = body
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  return body.trim() || null;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Escape raw control chars that LLMs sometimes leak into string values
    // (literal newlines inside "narrative" are the #1 cause of parse failures).
    const sanitized = text
      .replace(/\r\n/g, "\\n")
      .replace(/(?<!\\)\n/g, "\\n")
      .replace(/(?<!\\)\r/g, "\\r")
      .replace(/(?<!\\)\t/g, "\\t")
      // Strip remaining ASCII control chars (U+0000-U+001F)
      .replace(/[\u0000-\u001F]/g, "");
    try {
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

// ── GET /api/patients/:id/summary ─────────────────────────────────────────────
// Query params:
//   appointmentId (optional) — if omitted, uses latest appointment
//   regenerate=true (optional) — bypass cache and write fresh
// Cache is valid until invalidated (no TTL); cleared by mutation routes via
// invalidatePatientSummaries() or by DELETE /api/patients/:id/summary/cache.

router.get("/patients/:id/summary", async (req, res) => {
  const pid = Number(req.params.id);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });

  let apptId = req.query.appointmentId ? Number(req.query.appointmentId) : null;
  const forceRegen = req.query.regenerate === "true" || req.query.regenerate === "1";

  // Hoisted so the catch block can reject the in-flight promise.
  let resolveFlight = null;
  let rejectFlight = null;

  try {
    // ── 0. Resolve the appointment ID up front. If the client sent one,
    // verify it actually belongs to this patient — otherwise we'd return
    // the cached summary for a different patient (cache is keyed by
    // appointmentId). If the client didn't send one (or sent a mismatched
    // one), fall back to the patient's latest appointment. ──
    if (apptId) {
      const ownerR = await pool.query(`SELECT patient_id FROM appointments WHERE id=$1`, [apptId]);
      const ownerPid = ownerR.rows[0]?.patient_id ?? null;
      if (ownerPid !== pid) {
        console.warn(
          `[summary] MISMATCH patient=${pid} sent appt=${apptId} which belongs to patient=${ownerPid ?? "none"} — ignoring and falling back to latest`,
        );
        apptId = null;
      }
    }
    if (!apptId) {
      const latestR = await pool.query(
        `SELECT id FROM appointments
          WHERE patient_id=$1
          ORDER BY appointment_date DESC NULLS LAST, id DESC
          LIMIT 1`,
        [pid],
      );
      apptId = latestR.rows[0]?.id || null;
    }

    // ── 1. Check cache (skip if regenerate=true) ──
    if (apptId && !forceRegen) {
      const cacheR = await pool.query(`SELECT ai_summary FROM appointments WHERE id=$1`, [apptId]);
      const row = cacheR.rows[0];
      const cached = row?.ai_summary;
      const cachedAiOk = !!(cached && cached.ai && cached.ai.narrative);
      if (cached && cachedAiOk) {
        console.log(`[summary] HIT  patient=${pid} appt=${apptId} (cached)`);
        return res.json({ ...cached, cached: true });
      }
      if (cached && !cachedAiOk) {
        // Stale broken cache (ai=null from a previous failed run). Discard so
        // we regenerate cleanly this turn.
        console.warn(
          `[summary] STALE-NULL patient=${pid} appt=${apptId} — discarding broken cached row, regenerating`,
        );
        await pool
          .query(
            `UPDATE appointments SET ai_summary=NULL, ai_summary_generated_at=NULL WHERE id=$1`,
            [apptId],
          )
          .catch(() => {});
      } else {
        console.log(`[summary] MISS patient=${pid} appt=${apptId} — generating`);
      }
    } else if (forceRegen) {
      console.log(`[summary] REGEN patient=${pid} appt=${apptId} — bypassing cache`);
    } else {
      console.log(`[summary] NO-APPT patient=${pid} — cannot cache`);
    }

    // Single-flight: collapse parallel cold-cache requests for the same
    // (patient, appointment) into one generation. The first request runs the
    // pipeline below; concurrent ones await it and serve the same payload.
    const flightKey = `pre:${pid}:${apptId || "latest"}`;
    if (!forceRegen && inFlight.has(flightKey)) {
      const payload = await inFlight.get(flightKey);
      return res.json({ ...payload, cached: true });
    }
    const flightPromise = new Promise((r, j) => {
      resolveFlight = r;
      rejectFlight = j;
    });
    inFlight.set(flightKey, flightPromise);
    flightPromise
      .catch(() => {})
      .finally(() => {
        if (inFlight.get(flightKey) === flightPromise) inFlight.delete(flightKey);
      });

    // ── 2. Fetch data needed for the rule engine ──
    // Lab + vitals data comes from the shared helper so this brief sees the
    // same labLatest/labHistory/vitals as the /visit page UI (including
    // appointments.biomarkers JSONB and patient_vitals_log app readings).
    const labCtxPromise = buildVisitLabContext(pool, pid);
    const [patientR, diagnosesR, apptR, latestReportR, activeMedsR, stoppedMedsR] =
      await Promise.all([
        pool.query("SELECT * FROM patients WHERE id=$1", [pid]),

        pool.query(
          `SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
           WHERE patient_id=$1 ORDER BY diagnosis_id, is_active DESC, updated_at DESC`,
          [pid],
        ),

        // Prep from latest appointment (or specific appointment)
        apptId
          ? pool.query(`SELECT id, compliance, biomarkers FROM appointments WHERE id=$1`, [apptId])
          : pool.query(
              `SELECT id, compliance, biomarkers FROM appointments
               WHERE patient_id=$1 AND healthray_clinical_notes IS NOT NULL
               ORDER BY appointment_date DESC LIMIT 1`,
              [pid],
            ),

        // Latest report that has extracted lab results
        pool.query(
          `SELECT d.id, d.title, d.file_name, d.doc_date, d.created_at
           FROM documents d
           WHERE d.patient_id=$1
             AND EXISTS (SELECT 1 FROM lab_results lr WHERE lr.document_id=d.id AND lr.result IS NOT NULL)
           ORDER BY d.created_at DESC
           LIMIT 1`,
          [pid],
        ),

        // Active medications (for drug-interaction and protocol-gap rules).
        // visit_status = 'current' = re-prescribed at the most recent visit;
        // 'previous' = still active but carried over from an earlier visit.
        // The AI must only name current-visit meds in its "currently on …"
        // sentence — previous-visit meds are context only.
        pool.query(
          `SELECT id, name, dose, frequency, timing, started_date,
                  last_prescribed_date, visit_status, parent_medication_id
             FROM medications
            WHERE patient_id=$1 AND is_active=true`,
          [pid],
        ),

        // Recently stopped medications (for R4 rule — stopped within last 60 days)
        pool.query(
          `SELECT id, name, dose, stopped_date, stop_reason FROM medications
         WHERE patient_id=$1 AND is_active=false AND stopped_date > CURRENT_DATE - INTERVAL '60 days'`,
          [pid],
        ),
      ]);

    const patient = patientR.rows[0];
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    // ── 3. Pull lab + vitals context (same shape as /visit page) ──
    const { labHistory, vitals: mergedVitals, rawLabs } = await labCtxPromise;

    // ── 4. Build prep ──
    const apptRow = apptR.rows[0] || null;
    const resolvedApptId = apptId || apptRow?.id || null;
    const apptCompliance = apptRow?.compliance || {};
    const prep = {
      medPct: apptCompliance.medPct ?? null,
      missed: apptCompliance.missed || null,
      symptoms: apptCompliance.symptoms || [],
    };

    // ── 4b. Split active meds into current-visit vs previous-visit buckets
    // off the persisted `visit_status` column (stamped by scribe write paths
    // — see services/medication/visitStatus.js). Previous-visit meds must
    // NOT be named as "currently on" in the AI narrative. ──
    // Exclude child/support meds (those with a parent_medication_id) from the
    // brief — only top-level parents should be named in the narrative.
    const allActiveMeds = activeMedsR.rows.filter((m) => !m.parent_medication_id);
    const currentVisitMeds = allActiveMeds.filter((m) => m.visit_status !== "previous");
    const prevVisitMeds = allActiveMeds.filter((m) => m.visit_status === "previous");

    // ── 5. Run rule engine ──
    const sortedDiagnoses = sortDiagnoses(diagnosesR.rows);
    const rules = runSummaryRules({
      diagnoses: sortedDiagnoses,
      activeMeds: allActiveMeds,
      stoppedMeds: stoppedMedsR.rows,
      labResults: rawLabs,
      labHistory,
      vitals: mergedVitals,
      prep,
    });

    // ── 6. Compute visit context for narrative ──
    // EXACT same logic as /visit/:patientId so the AI's visit count agrees
    // with the UI strip's "N visits" badge: SQL union of consultations +
    // healthray-synced appointments (consultation wins per date), then JS
    // dedup by `visit_date|status` to collapse duplicate consultation rows.
    const consR = await pool.query(
      `WITH cons AS (
         SELECT id, visit_date, status, created_at FROM consultations WHERE patient_id = $1
       ),
       appts AS (
         SELECT id, appointment_date AS visit_date, status, created_at
           FROM appointments
          WHERE patient_id = $1 AND healthray_id IS NOT NULL AND appointment_date IS NOT NULL
       ),
       deduped AS (
         SELECT * FROM cons
         UNION ALL
         SELECT a.* FROM appts a
          WHERE NOT EXISTS (
            SELECT 1 FROM cons c WHERE c.visit_date::date = a.visit_date::date
          )
       )
       SELECT * FROM deduped
        ORDER BY visit_date DESC, created_at DESC
        LIMIT 200`,
      [pid],
    );
    const _seenVisits = new Set();
    const visitRows = consR.rows.filter((c) => {
      const key = `${c.visit_date}|${c.status}`;
      if (_seenVisits.has(key)) return false;
      _seenVisits.add(key);
      return true;
    });
    const totalVisits = visitRows.length;
    const firstVisitDate = visitRows.length ? visitRows[visitRows.length - 1].visit_date : null;
    let monthsWithGini = 0;
    let daysWithGini = 0;
    if (firstVisitDate) {
      const diffMs = Date.now() - new Date(firstVisitDate).getTime();
      daysWithGini = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      monthsWithGini = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30)));
    }
    let carePhase = "Phase 1 · Control";
    if (totalVisits >= 10) carePhase = "Phase 3 · Sustain";
    else if (totalVisits >= 4) carePhase = "Phase 2 · Stabilize";

    // ── 7. Generate AI brief (async, non-blocking for cache write) ──
    const ai = await generateAiBrief(patient, sortedDiagnoses, rules, labHistory, {
      totalVisits,
      monthsWithGini,
      daysWithGini,
      carePhase,
      activeMedsCount: currentVisitMeds.length,
      activeMeds: currentVisitMeds,
      prevVisitMeds,
      stoppedMeds: stoppedMedsR.rows,
      vitals: mergedVitals,
      prep,
    });

    const generatedAt = new Date().toISOString();
    const latestReport = latestReportR.rows[0] || null;
    // dataAsOf = the date of the most recent piece of data used by the rules
    const dataAsOf =
      latestReport?.doc_date || latestReport?.created_at || rawLabs[0]?.test_date || generatedAt;
    const aiNarrativeOk = !!(ai && ai.narrative);
    const payload = {
      rules,
      ai: aiNarrativeOk ? ai : null,
      aiError: aiNarrativeOk ? null : ai?.error || "AI narrative unavailable",
      generatedAt,
      dataAsOf,
      cached: false,
      latestReport,
      visitContext: { totalVisits, monthsWithGini, carePhase },
    };

    // ── 7. Store in cache (await so a fast follow-up request finds the row) ──
    // Only cache when the AI narrative succeeded. Caching a null AI would
    // freeze the broken state forever; without a cached row, the next request
    // naturally retries the Anthropic call.
    const aiOk = aiNarrativeOk;
    if (resolvedApptId && aiOk) {
      try {
        const updR = await pool.query(
          `UPDATE appointments
             SET ai_summary=$1, ai_summary_generated_at=$2
             WHERE id=$3`,
          [JSON.stringify(payload), generatedAt, resolvedApptId],
        );
        console.log(
          `[summary] SAVED patient=${pid} appt=${resolvedApptId} rowsUpdated=${updR.rowCount}`,
        );
      } catch (err) {
        console.error(
          `[summary] cache write FAILED patient=${pid} appt=${resolvedApptId}:`,
          err?.message || err,
        );
      }
    } else if (!resolvedApptId) {
      console.warn(`[summary] cache NOT WRITTEN patient=${pid} — no appointment row found`);
    } else {
      console.warn(
        `[summary] cache NOT WRITTEN patient=${pid} appt=${resolvedApptId} — AI failed (reason: ${ai?.error || "unknown"}); next request will retry`,
      );
    }

    if (resolveFlight) resolveFlight(payload);
    return res.json(payload);
  } catch (err) {
    if (rejectFlight) rejectFlight(err);
    handleError(res, err, "Failed to generate patient summary");
  }
});

// ── DELETE /api/patients/:id/summary/cache ────────────────────────────────────
// Invalidates the summary cache for a specific appointment (call after new data added)

router.delete("/patients/:id/summary/cache", async (req, res) => {
  const apptId = req.query.appointmentId ? Number(req.query.appointmentId) : null;
  if (!apptId) return res.status(400).json({ error: "appointmentId query param required" });
  try {
    await pool.query(
      `UPDATE appointments
       SET ai_summary=NULL, ai_summary_generated_at=NULL
       WHERE id=$1`,
      [apptId],
    );
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, "Failed to invalidate summary cache");
  }
});

export default router;
