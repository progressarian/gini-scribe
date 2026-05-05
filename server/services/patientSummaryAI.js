// Generates a patient-facing visit summary via Claude. Tone is plain,
// reassuring, and written for the patient (NOT the doctor). The output is
// what gets printed on the prescription's "Visit summary" block. Persistence
// is the caller's responsibility — store the returned text as a new version.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-20250514";

const SYSTEM_PROMPT = `You are writing a short visit summary for the PATIENT to read on their printed prescription. Your reader is the patient — not a doctor.

Style:
- One short paragraph, 3-5 sentences, plain prose (no bullets, no headings, no markdown, no medical jargon).
- Warm, simple, second-person ("you", "your"). Use everyday words a non-medical reader can understand.
- Avoid Latin / abbreviations (write "blood pressure" not "BP", "blood sugar" not "FBS", "long-term sugar" or "HbA1c (3-month sugar average)" — explain abbreviations).
- Mention what improved, what is being changed today, and what the patient should do until the next visit.
- End with one clear next step (when to come back, what tests to bring, lifestyle reminder).

Hard rules:
- Do NOT invent values. Only use numbers from the input JSON.
- Do NOT list every medicine — name only what changed today.
- Output ONLY the summary text. No preamble, no JSON, no quotes, no labels.
- 60-110 words.`;

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
    visit: {
      number: summary.totalVisits,
      monthsOnProgramme: summary.monthsWithGini,
    },
    diagnoses: activeDx.slice(0, 4).map((d) => ({
      name: d.label || d.diagnosis_id,
      status: d.status,
    })),
    todayChangedMedicines: newOrChanged,
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
    nextVisit: {
      date: followUp.date || null,
      testsToBring: followUp.tests_to_bring || [],
    },
    testsOrderedToday: (tests || []).map((t) => (typeof t === "string" ? t : t.name || t.test)),
  };
}

export async function generatePatientSummary(data) {
  if (!ANTHROPIC_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured on server");
  }
  const ctx = buildContext(data);
  const userMsg = `Here is the visit data as JSON:\n\n${JSON.stringify(ctx, null, 2)}\n\nWrite the patient-facing visit summary now (for the patient to read on their printed prescription).`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
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
  return text;
}
