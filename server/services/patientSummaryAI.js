// Generates a patient-facing visit summary via Claude. Tone is plain,
// reassuring, and written for the patient (NOT the doctor). The output is
// what gets printed on the prescription's "Visit summary" block. Persistence
// is the caller's responsibility — store the returned text as a new version.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `You are writing a short visit recap for the PATIENT to read in their app and on their printed prescription. Your reader is the patient — not a doctor. The greeting is written in the voice of THEIR DOCTOR speaking to them — warm, reassuring, professional, and respectful (the way a senior physician addresses their patient).

You return a single JSON object with EXACTLY these keys:

{
  "heading_greeting": "<short Hinglish greeting in doctor's voice, ending with patient's first name + ' ji,' — adapts to tone>",
  "heading_accent":   "",
  "body":             "<the visit-summary paragraph (English)>"
}

Heading tone — pick the greeting in a doctor's caring, composed voice so it fits the patient's actual numbers:
- Numbers are GOOD (improved / on-target) — appreciative, encouraging:
    e.g. "Bahut achha kar rahe hain, <Name> ji,", "Aapki mehnat dikh rahi hai, <Name> ji,", "Progress badhiya hai, <Name> ji,"
- Numbers need WATCH (mixed, drifting) — calm, guiding:
    e.g. "Thoda dhyaan dena hoga, <Name> ji,", "Saath milkar sambhalte hain, <Name> ji,", "Routine par focus rakhein, <Name> ji,"
- Numbers need REVIEW (worse, off-target) — reassuring, never alarming:
    e.g. "Chinta ki baat nahi, <Name> ji,", "Hum aapke saath hain, <Name> ji,", "Milkar theek karenge, <Name> ji,"
- Neutral / steady (stable, ongoing management):
    e.g. "Aapki sehat dhyaan mein hai, <Name> ji,", "Hum nazar bana ke rakh rahe hain, <Name> ji,", "Sab kuch sambhal raha hai, <Name> ji,"

Heading rules:
- Greeting is the DOCTOR talking to the patient — warm, dignified, professional. Not a generic "Namaste". Not a marketing line.
- Use Hinglish in Latin script — simple words a layperson reads easily, but in a doctor's tone.
- Greeting MUST end with the patient's first name followed by " ji," (e.g. "Bahut achha kar rahe hain, Rajesh ji,"). 4-7 words total.
- The patient's first name is supplied separately in the user message — use THAT name. Do NOT use any honorific (Mr./Mrs./Ms./Dr.) as the name.
- heading_accent MUST be an empty string "".
- Choose tone strictly from the data — don't say "bahut achha" if HbA1c just rose; don't say "chinta nahi" if everything improved.

Body style (English):
- One short paragraph, 3-5 sentences, plain prose (no bullets, no headings, no markdown, no medical jargon).
- Warm, simple, second-person ("you", "your"). Use everyday words a non-medical reader can understand.
- Avoid Latin / abbreviations (write "blood pressure" not "BP", "blood sugar" not "FBS", "long-term sugar" or "HbA1c (3-month sugar average)" — explain abbreviations).
- Keep it a GENERAL summary of the patient's current health picture and care plan — what's improving, what's being managed, and what they should focus on going forward.
- End with one clear, general next step (a lifestyle reminder, what to keep tracking, or what tests to keep up with).
- 60-110 words.

Hard rules:
- Do NOT invent values. Only use numbers from the input JSON.
- Do NOT list every medicine — name only what is being adjusted in the current plan.
- Do NOT mention the visit number, visit count, "this visit", "today", "this time", "last visit", dates, or any time-specific reference. Write as a timeless general summary.
- Do NOT reference the next appointment date or "next visit" — keep next steps general.
- Output ONLY the JSON object. No preamble, no markdown fence, no commentary.`;

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
  const hba1cLatest = pickLab("hba1c", "a1c");
  const fbsLatest = pickLab("fbs", "fasting");
  const ldlLatest = pickLab("ldl");

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

  const followUp = consultations?.[0]?.con_data?.follow_up || {};
  const tests =
    consultations?.[0]?.con_data?.investigations_to_order ||
    consultations?.[0]?.con_data?.tests_ordered ||
    [];

  return {
    patient: { name: patient.name, age: patient.age, sex: patient.sex },
    diagnoses: activeDx.slice(0, 4).map((d) => ({
      name: d.label || d.diagnosis_id,
      status: d.status,
    })),
    medicineChanges: newOrChanged,
    vitals: {
      bp: latestVitals.bp_sys ? `${latestVitals.bp_sys}/${latestVitals.bp_dia}` : null,
      weight: latestVitals.weight,
      prevWeight: prevVitals.weight,
    },
    labs: {
      hba1c: hba1cLatest && {
        value: hba1cLatest.result,
        unit: hba1cLatest.unit,
        previous: previousOf("hba1c")?.result,
      },
      fbs: fbsLatest && {
        value: fbsLatest.result,
        unit: fbsLatest.unit,
      },
      ldl: ldlLatest && {
        value: ldlLatest.result,
        unit: ldlLatest.unit,
      },
    },
    goals: (goals || []).map((g) => ({
      marker: g.marker,
      target: g.target_value,
      current: g.current_value,
    })),
    testsToFollow: [
      ...(followUp.tests_to_bring || []),
      ...(tests || []).map((t) => (typeof t === "string" ? t : t.name || t.test)),
    ],
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
      temperature: 0.4,
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
