// Generates a one-paragraph clinical visit summary via Claude. The summary is
// written as a doctor's narrative for the prescription PDF — not a JSON
// document. Idempotency / persistence is the caller's responsibility (write
// the result to doctor_summaries as a new version).

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `You are a junior endocrinology resident giving a verbal pre-visit handoff to your senior consultant just before they walk in to see the patient. Speak the way a junior doctor actually briefs a senior — flowing clinical prose, respectful, concise.

THE FIRST WORDS OF YOUR OUTPUT MUST BE THE PATIENT'S FULL NAME, taken verbatim from input.patient.name. The brief must open with the name. If you do not start with the patient's name, the brief is wrong. Never start with "Sir", "Ma'am", "This patient", "The patient", or any pronoun.

Required opening pattern (exact shape, only swap in real values):
"<Full Name> is a <age>-year-old <woman|man>, here today for her/his <Nth> visit; she/he has been with us on the Gini programme for <X months/years> and is currently in <Care Phase>."

Voice & style after the opener:
- First-person plural resident voice: "we", "her last labs showed...", "she is currently on...".
- Plain narrative prose only — NO headings, NO bullets, NO markdown, NO emojis, NO section labels, NO colon-lists.
- Present tense for current status; past tense for what has happened.
- Output exactly THREE short paragraphs separated by a blank line ("\\n\\n"). Total 130-180 words.

The 3 paragraphs in this exact order:

Paragraph 1 — Identity (one or two sentences, MUST start with the patient's full name):
Use the required opening pattern above. Identify name → age → sex → visit number → time on Gini programme → care phase. Nothing clinical yet.

Paragraph 2 — Active conditions, each paired with its supporting vital/biomarker:
Walk through each active diagnosis in order of clinical priority (most acute first). For every condition, weave in the specific supporting number(s) and trend direction from the data — never a diagnosis without a value. Example flow: "Her type 2 diabetes is poorly controlled today, with HbA1c at 7.7% (up from 6.8%) and FBS at 271 mg/dL. Her hypertension remains uncontrolled at 160/80 despite dual therapy. Her CKD has progressed, with eGFR down to 39 mL/min/1.73m² from 77, and creatinine now 1.58 mg/dL. Her dyslipidaemia, on the other hand, is well-controlled, with LDL at 83 mg/dL."

Paragraph 3 — Current medications and what to flag:
State explicitly what the patient is currently on, by drug name and dose, in one fluent sentence — e.g. "She is currently on metformin 1g BD, telmisartan 40 mg OD, atorvastatin 20 mg HS, and dapagliflozin 10 mg OD." Then in one short closing sentence flag the single most acute issue you would like the senior to address today. If a recent stop or change explains a biomarker shift, you may reason about it ("after antidiabetic therapy was held two days ago") but never name the stopped drug.

Hard rules — non-negotiable:
- The very first token of the output is the patient's full name. No greeting, no preamble.
- Use only currently active medications by name. Never name stopped, previous, or discontinued drugs.
- Every diagnosis mentioned must come with its supporting biomarker/vital number.
- Use exact numbers, units, drug names, and doses from the input. Do not invent data.
- Output ONLY the narrative prose — no JSON, no quotes, no labels, no "Paragraph 1:" markers.`;

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

  // Extract a few key labs (latest + first)
  const labKey = (name) => name.toLowerCase();
  const latestByName = {};
  for (const r of labResults || []) {
    const k = labKey(r.canonical_name || r.test_name || "");
    if (!latestByName[k]) latestByName[k] = r;
  }
  const pickLab = (...keys) => {
    for (const k of keys) if (latestByName[k]) return latestByName[k];
    return null;
  };
  const hba1cLatest = pickLab("hba1c");
  const fbsLatest = pickLab("fbs");
  const ldlLatest = pickLab("ldl", "ldl cholesterol");

  // labHistory[k] is newest-first (DB query ORDER BY test_date DESC),
  // so arr[0] is the latest reading and arr[1] is the immediately-prior one.
  const previousOf = (key) => {
    const aliases = {
      hba1c: ["HbA1c", "hba1c", "A1c"],
      fbs: ["FBS", "fbs", "fasting glucose"],
      ldl: ["LDL", "ldl"],
    }[key] || [key];
    for (const k of Object.keys(labHistory || {})) {
      if (aliases.some((a) => k.toLowerCase().includes(a.toLowerCase()))) {
        const arr = labHistory[k];
        if (Array.isArray(arr) && arr.length >= 2) return arr[1];
      }
    }
    return null;
  };

  return {
    patient: {
      name: patient.name,
      age: patient.age,
      sex: patient.sex,
    },
    visit: {
      number: summary.totalVisits,
      monthsOnProgramme: summary.monthsWithGini,
      carePhase: summary.carePhase,
    },
    diagnoses: activeDx.map((d) => ({
      name: d.label || d.diagnosis_id,
      status: d.status,
      since: d.since_year,
    })),
    medications: activeMeds
      .filter((m) => !m.parent_medication_id)
      .slice(0, 20)
      .map((m) => ({
        name: m.composition || m.name,
        dose: m.dose,
        frequency: m.frequency,
      })),
    vitals: {
      bp: latestVitals.bp_sys ? `${latestVitals.bp_sys}/${latestVitals.bp_dia}` : null,
      weight: latestVitals.weight,
      bmi: latestVitals.bmi,
      prevWeight: prevVitals.weight,
    },
    labs: {
      hba1c: hba1cLatest && {
        value: hba1cLatest.result,
        unit: hba1cLatest.unit,
        previous: previousOf("hba1c")?.result,
        previousDate: previousOf("hba1c")?.date,
      },
      fbs: fbsLatest && {
        value: fbsLatest.result,
        unit: fbsLatest.unit,
        previous: previousOf("fbs")?.result,
        previousDate: previousOf("fbs")?.date,
      },
      ldl: ldlLatest && {
        value: ldlLatest.result,
        unit: ldlLatest.unit,
        previous: previousOf("ldl")?.result,
        previousDate: previousOf("ldl")?.date,
      },
    },
    goals: goals.map((g) => ({
      marker: g.marker,
      target: g.target_value,
      current: g.current_value,
    })),
    plan: consultations?.[0]?.con_data || {},
  };
}

export async function generateVisitSummary(data) {
  if (!ANTHROPIC_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured on server");
  }
  const ctx = buildContext(data);
  const patientName = ctx.patient?.name || "the patient";
  const userMsg = [
    `Here is the visit data as JSON:`,
    ``,
    JSON.stringify(ctx, null, 2),
    ``,
    `Write the pre-visit clinical handoff now, following the system-prompt structure exactly.`,
    `The very first words of your output MUST be the patient's full name: "${patientName}".`,
    `Begin: "${patientName} is a ..." — do not begin with anything else.`,
  ].join("\n");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 900,
      temperature: 0.3,
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
  return text;
}
