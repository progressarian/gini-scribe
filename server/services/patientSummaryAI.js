// Generates a patient-facing visit summary via Claude. Tone is plain,
// reassuring, and written for the patient (NOT the doctor). The output is
// what gets printed on the prescription's "Visit summary" block. Persistence
// is the caller's responsibility — store the returned text as a new version.

import { pickNextVisit } from "../../shared/followUp.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are writing a short visit recap for the PATIENT to read in their app and on their printed prescription. Your reader is the patient — not a doctor. The greeting is written in the voice of THEIR DOCTOR speaking to them — warm, reassuring, professional, and respectful (the way a senior physician addresses their patient).

You return a single JSON object with EXACTLY these keys:

{
  "heading_greeting": "<short Hinglish greeting in doctor's voice, ending with patient's first name + ' ji,' — adapts to tone>",
  "heading_accent":   "",
  "body":             "<the visit-summary paragraph (English)>"
}

Heading tone — compose an ORIGINAL Hinglish greeting in the doctor's caring, composed voice that fits the patient's actual numbers. Do NOT reuse stock phrases — write a fresh, natural greeting every time based on what the data actually shows:
- Numbers are GOOD (improved / on-target): tone is appreciative and encouraging — the doctor acknowledges the patient's effort and improvement.
- Numbers need WATCH (mixed, drifting): tone is calm and guiding — the doctor gently draws attention to what needs focus, without alarm.
- Numbers need REVIEW (worse, off-target): tone is reassuring — the doctor makes the patient feel supported and not alone, never alarming.
- Neutral / steady (stable, ongoing management): tone is steady and caring — the doctor conveys that everything is being looked after.

Heading rules:
- Greeting is the DOCTOR talking to the patient — warm, dignified, professional. Not a generic "Namaste". Not a marketing line.
- Use Hinglish in Latin script — simple words a layperson reads easily, but in a doctor's tone.
- Greeting MUST end with the patient's first name followed by " ji," (e.g. "Bahut achha kar rahe hain, Rajesh ji,"). 4-7 words total.
- The patient's first name is supplied separately in the user message — use THAT name. Do NOT use any honorific (Mr./Mrs./Ms./Dr.) as the name.
- heading_accent MUST be an empty string "".
- Choose tone strictly from the data — don't say "bahut achha" if HbA1c just rose; don't say "chinta nahi" if everything improved.

Body style (English):
- One short paragraph, 4-6 sentences, plain prose (no bullets, no headings, no markdown, no medical jargon).
- Warm, simple, second-person ("you", "your"). Use everyday words a non-medical reader can understand.
- Avoid Latin / abbreviations (write "blood pressure" not "BP", "blood sugar" not "FBS", "long-term sugar" or "HbA1c (3-month sugar average)" — explain abbreviations).
- Keep it a GENERAL summary of the patient's current health picture and care plan — what's improving, what's being managed, and what they should focus on going forward.
- 80-150 words.

COVERAGE (most important rule):
- The input "diagnoses" array is the patient's FULL active problem list, already in the order the doctor reviews them. EVERY diagnosis in that array must be reflected in the body — none may be skipped, however minor it looks, and however few numbers are attached to it.
- Do NOT write the summary as if the patient had only one condition. A patient carrying diabetes, heart disease, thyroid and a chest infection must read about all of them, not only their sugar.
- Give the conditions weight in the order they are listed, but a condition with no lab value still gets its own clause in plain words ("your thyroid is being kept steady on medicine", "the chest infection is being treated").
- Where the input "labs" or "vitals" carry a value for a condition, use that value for it — not only the sugar numbers. Blood pressure, thyroid, kidney, liver and cholesterol numbers are all available when present; use each one against the condition it belongs to.

Hard rules:
- Do NOT invent values. Only use numbers from the input JSON.
- Do NOT list every medicine — name only what is being adjusted in the current plan.
- Do NOT mention the visit number, visit count, "this visit", "today", "this time", "last visit", or any calendar date. Write as a timeless general summary.
- FOLLOW-UP RULE: If "followUpRelative" is present in the input JSON, end the body with exactly one sentence using that relative time phrase (e.g. "Your next visit is in about 1 month." / "We will see you next week."). If "followUpNotes" is also present, weave those instructions into the same sentence (e.g. "Please come in about 3 weeks for your HbA1c and lipid tests, fasting."). If "followUpRelative" is null or absent, do NOT mention the next visit at all — keep the closing sentence a general next-step reminder instead.
- Output ONLY the JSON object. No preamble, no markdown fence, no commentary.`;

function relativeFollowUp(dateStr) {
  if (!dateStr) return null;
  const fuDate = new Date(String(dateStr).slice(0, 10));
  if (isNaN(fuDate.getTime())) return null;
  const diffDays = Math.round((fuDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays > 0) {
    if (diffDays <= 6) return `in ${diffDays} days`;
    if (diffDays <= 10) return "next week";
    if (diffDays <= 17) return "in about 2 weeks";
    if (diffDays <= 24) return "in about 3 weeks";
    if (diffDays <= 45) return "in about 1 month";
    if (diffDays <= 75) return "in about 2 months";
    if (diffDays <= 105) return "in about 3 months";
    if (diffDays <= 135) return "in about 4 months";
    if (diffDays <= 165) return "in about 5 months";
    if (diffDays <= 195) return "in about 6 months";
    return `in about ${Math.round(diffDays / 30)} months`;
  }
  return null; // past dates — don't show relative for patient-facing summary
}

function buildContext(data) {
  const {
    patient = {},
    summary = {},
    activeDx = [],
    activeMeds = [],
    latestVitals = {},
    prevVitals = {},
    labResults = [],
    labHistory = {},
    consultations = [],
    goals = [],
    appt_plan = null,
  } = data;

  const labKey = (name) => String(name || "").toLowerCase();
  const latestByName = {};
  for (const r of labResults || []) {
    const k = labKey(r.canonical_name || r.test_name);
    if (k && !latestByName[k]) latestByName[k] = r;
  }
  const pickLab = (...keys) => {
    for (const k of keys) {
      const hit = Object.entries(latestByName).find(([n]) => n.includes(k));
      if (hit) return hit[1];
    }
    return null;
  };
  // The summary used to receive only sugar and LDL, so however many conditions
  // the patient carried, the only numbers it could write about were diabetic
  // ones. Every marker the diagnosis list can refer to is passed instead.
  const LAB_FIELDS = [
    { key: "hba1c", keys: ["hba1c", "a1c"] },
    { key: "fbs", keys: ["fbs", "fasting blood", "fasting glucose"] },
    { key: "ppbs", keys: ["ppbs", "post prandial"] },
    { key: "ldl", keys: ["ldl"] },
    { key: "hdl", keys: ["hdl"] },
    { key: "triglycerides", keys: ["triglyceride"] },
    { key: "totalCholesterol", keys: ["total cholesterol"] },
    { key: "creatinine", keys: ["creatinine"] },
    { key: "egfr", keys: ["egfr", "gfr"] },
    { key: "uacr", keys: ["uacr", "urine acr", "microalbumin"] },
    { key: "tsh", keys: ["tsh"] },
    { key: "alt", keys: ["sgpt", "alt"] },
    { key: "ast", keys: ["sgot", "ast"] },
    { key: "haemoglobin", keys: ["haemoglobin", "hemoglobin"] },
    { key: "vitaminD", keys: ["vitamin d", "25-oh"] },
    { key: "vitaminB12", keys: ["b12", "cobalamin"] },
    { key: "uricAcid", keys: ["uric acid"] },
    { key: "potassium", keys: ["potassium", "k+"] },
  ];

  // labHistory[k] is newest-first; arr[1] is the immediately-prior reading.
  const previousOf = (key) => {
    for (const k of Object.keys(labHistory || {})) {
      if (k.toLowerCase().includes(key)) {
        const arr = labHistory[k];
        if (Array.isArray(arr) && arr.length >= 2) return arr[1];
      }
    }
    return null;
  };

  // Drop child/support meds (those with a parent_medication_id) so the
  // patient-facing summary names only top-level prescriptions, matching
  // the rule used by the doctor brief and post-visit summary.
  const newOrChanged = (activeMeds || [])
    .filter((m) => m.is_new && !m.parent_medication_id)
    .map((m) => ({
      name: m.composition || m.name,
      dose: m.dose,
      frequency: m.frequency,
    }));

  const conFollowUp = consultations?.[0]?.con_data?.follow_up || {};
  const resolvedFollowUp = pickNextVisit([conFollowUp, appt_plan?.follow_up]);
  const followUpRelative = resolvedFollowUp?.date ? relativeFollowUp(resolvedFollowUp.date) : null;
  const followUpNotes =
    resolvedFollowUp?.notes || appt_plan?.follow_up_with || conFollowUp.notes || null;
  const followUp = conFollowUp;
  const tests =
    consultations?.[0]?.con_data?.investigations_to_order ||
    consultations?.[0]?.con_data?.investigations_ordered ||
    consultations?.[0]?.con_data?.tests_ordered ||
    appt_plan?.investigations_to_order ||
    [];

  const safeLatestVitals = latestVitals && typeof latestVitals === "object" ? latestVitals : {};
  const safePrevVitals = prevVitals && typeof prevVitals === "object" ? prevVitals : {};

  // Full problem list in the clinical sequence, never truncated: the prompt's
  // coverage rule requires every active diagnosis, and a slice was silently
  // dropping the conditions that sat at the end of the list.
  const diagnoses = (sortDiagnoses(activeDx) || [])
    .filter((d) => d && d.is_active !== false)
    .map((d) => ({
      name: d.label || d.diagnosis_id,
      status: d.status || null,
      since: d.since_year || null,
      detail: d.detail || null,
    }));

  const labs = {};
  for (const f of LAB_FIELDS) {
    const latest = pickLab(...f.keys);
    if (!latest || latest.result == null) continue;
    labs[f.key] = {
      value: latest.result,
      unit: latest.unit || null,
      previous: previousOf(f.keys[0])?.result ?? null,
    };
  }

  return {
    patient: { name: patient.name, age: patient.age, sex: patient.sex },
    diagnoses,
    medicineChanges: newOrChanged,
    vitals: {
      bp: safeLatestVitals.bp_sys ? `${safeLatestVitals.bp_sys}/${safeLatestVitals.bp_dia}` : null,
      prevBp: safePrevVitals.bp_sys ? `${safePrevVitals.bp_sys}/${safePrevVitals.bp_dia}` : null,
      pulse: safeLatestVitals.pulse ?? null,
      spo2: safeLatestVitals.spo2 ?? null,
      weight: safeLatestVitals.weight ?? null,
      prevWeight: safePrevVitals.weight ?? null,
      bmi: safeLatestVitals.bmi ?? null,
      waist: safeLatestVitals.waist ?? null,
    },
    labs,
    goals: (goals || []).map((g) => ({
      marker: g.marker,
      target: g.target_value,
      current: g.current_value,
    })),
    testsToFollow: [
      ...(followUp.tests_to_bring || []),
      ...(tests || []).map((t) => (typeof t === "string" ? t : t.name || t.test)),
    ],
    followUpRelative: followUpRelative || null,
    followUpNotes: followUpNotes || null,
  };
}

function tryParseJson(raw) {
  if (!raw) return null;
  // Strip leading/trailing markdown fences if Claude leaks them despite the prompt.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fallback: pull the first {...} block.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function firstName(name) {
  const HONORIFICS = new Set([
    "mr",
    "mrs",
    "ms",
    "miss",
    "mx",
    "dr",
    "doctor",
    "prof",
    "professor",
    "sir",
    "madam",
    "shri",
    "smt",
    "shrimati",
    "sri",
    "kumari",
    "km",
    "master",
    "mast",
    "baby",
    "bby",
  ]);
  const tokens = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const tok of tokens) {
    const clean = tok.replace(/[.,]/g, "").toLowerCase();
    if (!clean) continue;
    if (HONORIFICS.has(clean)) continue;
    return tok.replace(/[.,]+$/g, "");
  }
  return tokens[0] || "";
}

export async function generatePatientSummary(data) {
  if (!ANTHROPIC_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured on server");
  }
  const ctx = buildContext(data);
  const fname = firstName(ctx.patient?.name);
  const userMsg = `Here is the visit data as JSON:\n\n${JSON.stringify(ctx, null, 2)}\n\nReturn the JSON object now (heading_greeting, heading_accent, body).\n\nThe patient's first name is "${fname}". Use this exact name in the greeting — do NOT use "Mr.", "Mrs.", "Ms.", "Dr." or any other honorific as the name. The greeting must be in the doctor's voice (warm, professional, reassuring) and end with "${fname} ji,". The heading_accent must be an empty string.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      temperature: 0.7,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Claude API ${resp.status}: ${body.slice(0, 200)}`);
  }
  const j = await resp.json();
  const text = (j.content || [])
    .map((c) => c.text || "")
    .join("")
    .trim();
  if (!text) throw new Error("Empty response from Claude");

  const parsed = tryParseJson(text);
  const body =
    typeof parsed?.body === "string" && parsed.body.trim()
      ? parsed.body.trim()
      : // If the model ignored the JSON contract, keep the raw text as the body
        // so we never block a visit on a heading parse error.
        text;
  const heading_greeting =
    typeof parsed?.heading_greeting === "string" && parsed.heading_greeting.trim()
      ? parsed.heading_greeting.trim()
      : null;
  const heading_accent = "";
  return { body, heading_greeting, heading_accent };
}
