// Generates a one-paragraph clinical visit summary via Claude. The summary is
// written as a doctor's narrative for the prescription PDF — not a JSON
// document. Idempotency / persistence is the caller's responsibility (write
// the result to doctor_summaries as a new version).

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `You are an experienced consultant endocrinologist writing a brief visit summary for a printed prescription.

Style:
- One paragraph, 4-7 sentences, plain prose (no bullet points, no headings, no markdown).
- Conversational clinical tone, present tense.
- Mention the most clinically meaningful changes only: trend in HbA1c / FBS / BP / weight / LDL since first visit or last visit, what therapy is being started/stopped today, and the rationale.
- Reference target values when stating control status (e.g. "target BP below 130/80").
- End with the next-step plan (referrals, screening tests ordered, advice).

Hard rules:
- Do NOT invent data. Only use values present in the input JSON.
- Do NOT list every diagnosis or every medication exhaustively — pick the relevant 2-3.
- Output ONLY the summary text. No preamble, no JSON, no quotes.
- 80-160 words.`;

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

  const firstOf = (key) => {
    const aliases = {
      hba1c: ["HbA1c", "hba1c", "A1c"],
      fbs: ["FBS", "fbs", "fasting glucose"],
      ldl: ["LDL", "ldl"],
    }[key] || [key];
    for (const k of Object.keys(labHistory || {})) {
      if (aliases.some((a) => k.toLowerCase().includes(a.toLowerCase()))) {
        const arr = labHistory[k];
        if (Array.isArray(arr) && arr.length >= 2) return arr[arr.length - 1]; // newest-first → last is oldest
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
    medications: activeMeds.slice(0, 12).map((m) => ({
      name: m.composition || m.name,
      dose: m.dose,
      frequency: m.frequency,
      isNew: m.is_new,
      isExternal: m.med_group === "external" || !!m.external_doctor,
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
        first: firstOf("hba1c")?.result,
      },
      fbs: fbsLatest && {
        value: fbsLatest.result,
        unit: fbsLatest.unit,
        first: firstOf("fbs")?.result,
      },
      ldl: ldlLatest && {
        value: ldlLatest.result,
        unit: ldlLatest.unit,
        first: firstOf("ldl")?.result,
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
  const userMsg = `Here is the visit data as JSON:\n\n${JSON.stringify(ctx, null, 2)}\n\nWrite the visit summary now.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
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
