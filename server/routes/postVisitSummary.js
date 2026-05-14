import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";
import { extractDiagnosisGrade } from "../utils/diagnosisGrade.js";
import { buildVisitLabContext } from "../services/visitLabContext.js";
import { computeCarePhase, deriveBiomarkerPriorityStatus } from "../utils/carePhase.js";

const router = Router();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Single-flight map (see server/routes/summary.js for rationale).
const inFlight = new Map();

// Cache columns
pool
  .query(
    `
  ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS post_visit_summary JSONB,
    ADD COLUMN IF NOT EXISTS post_visit_summary_generated_at TIMESTAMPTZ
`,
  )
  .catch(() => {});

const SYSTEM_PROMPT = `You are a junior endocrinology resident giving a verbal post-visit handoff to your senior consultant, immediately after the consultation has ended and the prescription has been finalised. Write the way a junior doctor would brief a senior — clinical, concise, respectful, in flowing prose.

Tone & style:
- Spoken-handoff register: "This is...", "She has been with us for...", "Today her labs showed...", "We have continued her on...".
- Plain narrative prose only. No headings, no bullets, no markdown, no emojis, no section labels.
- Past tense for what happened in this visit; present tense for current status.
- 2 short paragraphs separated by a blank line ("\\n\\n"). Total 120-180 words.
- Always state time on Gini programme in the exact "Xy Ym" format (e.g. "2y 5m"). If less than a year, write "Nm" (e.g. "6m"); if a whole number of years, "Yy". Never write "X months" or "X years".

Paragraph 1 — Who the patient is and the clinical picture today:
Open with the patient's name, age, sex, visit number, and time on the Gini programme (and care phase). In the same paragraph, give the active-problem list with the most relevant biomarker or vital woven in for each problem (e.g. "her diabetes is poorly controlled today with HbA1c 7.7% and FBS 271 mg/dL", "BP remains uncontrolled at 160/80", "her renal function has worsened, with eGFR down to 39 mL/min/1.73m²"). Cite trend direction against prior values where it matters.

Paragraph 2 — What's improving, what was decided today, and current treatment:
Briefly note markers that are improving or well-controlled, with numbers. Then describe what the senior decided this visit (additions, dose changes, advice given, referrals or screening ordered, next-review intent) — but phrase it from the resident's voice ("we restarted...", "we titrated up to..."). State what the patient is currently on by name — e.g. "She is currently on metformin 1g BD, telmisartan 40 mg OD, atorvastatin 20 mg HS, and dapagliflozin 10 mg OD." If a recent stop or change explains a biomarker shift, you may reason about it ("after antidiabetic therapy was held two days ago") but do not name the stopped drug. Close with the next-review plan.

Format output as JSON: { "narrative": "<the two narrative paragraphs joined with \\n\\n>" }.

Hard rules:
- Do not invent data. Only use values present in the input.
- Use exact numbers, units, drug names, and doses from the input.

DIAGNOSIS FORMAT STANDARD (applies to EVERY diagnosis you mention — primary, comorbid, complication, or incidental):
- ABSOLUTE GRADE/STAGE/SEVERITY RULE (highest priority — failure to follow this invalidates the entire brief): If the input line for a diagnosis carries a "grade/marker:", "severity:", or "stage" value (e.g. "grade/marker: moderate NPDR", "severity: Grade 2", "Stage 3"), that exact grade/stage/severity token MUST appear attached to the diagnosis name in the narrative — verbatim, in the same mention, never separated, never dropped, never paraphrased. Examples: input "diabetic retinopathy · grade/marker: moderate NPDR" → narrative must say "moderate NPDR" or "diabetic retinopathy (moderate NPDR)", never bare "retinopathy". Input "fatty liver · grade/marker: Grade 2" → "Grade 2 fatty liver", never bare "fatty liver". Input "CKD · grade/marker: Stage 3 (G3a/A2)" → "CKD Stage 3 (G3a/A2)", never bare "CKD" or "kidney disease". If you write a complication or condition name without its grade when the grade is in the input, the brief is wrong — rewrite it.
- NEVER lump two graded complications into a single phrase ("neuropathy and retinopathy as complications"). Each complication must be named separately with its own grade/severity/marker attached, even if it makes the sentence longer.
- Never name a condition by its bare label when the input carries ANY of the following qualifiers: grade, stage, severity, class, type, marker, duration, since-year, age-of-onset (AOO), status, or trend. Always inline EVERY qualifier present in the input, verbatim, immediately attached to the diagnosis name.
- Specifically: if the input shows "since 2015", "Duration: Since 2015", "since 2008", or an AOO value, you MUST state it (e.g. "type 2 diabetes since 2015 (AOO 44)", "hypertension since 2008"). Do NOT drop "since <year>" or AOO — these are part of the diagnosis label.
- Acceptable shapes: "type 2 diabetes since 2015 (AOO 44), well-controlled", "hypertension since 2008, controlled", "CKD Stage 3 (G3a/A2)", "moderate NPDR", "NYHA II heart failure", "Grade 2 fatty liver", "MASLD (no liver enzymes on file)", "diabetic neuropathy", "diabetic nephropathy (A2, microalbuminuria)".
- If multiple qualifiers exist (since + AOO, stage + class, severity + type, etc.) state ALL of them in the same mention — do not pick one and drop the rest.
- Do not paraphrase qualifiers into vague words (never reduce "Stage 3 CKD" to "kidney disease"; never reduce "G3a/A2" to "mixed signals"; never drop "since 2015" because it feels like clutter). Qualifiers from the input must appear in the prose, in the same mention as the diagnosis.
- This applies to comorbidities and incidental diagnoses too — if "MASLD", "anxiety spells", "post CK arthralgia", "sinusitis", "dual adiposity" appear in the input, list each by name in the active-problem walk-through. Do not collapse them into a vague phrase like "and other comorbidities".

NUMBER FORMAT STANDARD (applies to every biomarker, vital, or lab value you cite):
- Always cite a value WITH its unit (e.g. "7.7%", "124 mg/dL", "143/96 mmHg", "108 mL/min/1.73m²", "10.4 g/dL"). Never a bare number.
- Whenever a previous value is available in the input, state the current value AND the previous value in the form "<current> <unit> from <previous> <unit>" (e.g. "HbA1c 7.7% from 5.1%", "FBS 124 mg/dL from 88 mg/dL", "haemoglobin 10.4 g/dL from 13.4 g/dL", "eGFR 108 mL/min/1.73m² from 92"). The unit may be omitted on the "from" half only when it is identical and obvious.
- Use this same "X from Y" shape for every value with a prior — do not mix "rising to 7.7% from 5.1%", "down to 39 from 77", and "now 1.58, previously 1.4" within the same brief. One shape, applied uniformly.
- If no previous value exists, state the current value alone with its unit and do not invent a prior.
- Every diagnosis you mention must be paired with at least one supporting number in this format. No bare diagnosis without a value when a value exists in the input.

- List ONLY currently active medications by name. NEVER name stopped, previous, or discontinued drugs — not in the current-meds sentence, not as a parenthetical, not as a list, not anywhere. If active meds is empty, say "She/He is currently on no active medications." and stop. Do not enumerate the discontinued list as a substitute. Stopped drugs may only appear as anonymous class-level reasoning ("antihypertensive therapy was held two days ago") and only when needed to explain a specific biomarker shift.
- Narrative must contain ONLY flowing prose — no labels, no bullets, no preamble.`;

function fmtLabs(labHistory) {
  if (!labHistory) return "(none)";
  const entries = Object.entries(labHistory);
  if (entries.length === 0) return "(none)";
  const numeric = (v) => {
    if (v == null) return null;
    const m = String(v).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  return entries
    .slice(0, 20)
    .map(([name, hist]) => {
      const latest = hist[0];
      const prev = hist[1];
      let line = `${name}: ${latest.result}${latest.unit ? " " + latest.unit : ""}${latest.flag ? " [" + latest.flag + "]" : ""}`;
      if (prev) {
        const ln = numeric(latest.result);
        const pn = numeric(prev.result);
        let arrow = "";
        if (ln != null && pn != null) {
          arrow = ln > pn ? " ↑" : ln < pn ? " ↓" : " →";
        }
        line += ` | prev ${prev.result}${prev.unit ? " " + prev.unit : ""}${arrow}`;
      }
      return line;
    })
    .join("\n");
}

function fmtMeds(active, stopped = [], recentChanges = []) {
  const lines = ["Currently active (THESE are the only meds to list in the Current: line):"];
  if (active.length === 0) lines.push("  (none)");
  // Only top-level parent meds are listed in the brief; child/support meds
  // are intentionally excluded so the narrative names the primary regimen only.
  const parents = active.filter((m) => !m.parent_medication_id);
  for (const m of parents) {
    lines.push(
      `  - ${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? " " + m.frequency : ""}${m.timing ? " (" + m.timing + ")" : ""}`,
    );
  }
  if (stopped.length) {
    lines.push(
      "Stopped recently (CONTEXT ONLY — do not list in output, but use to reason about biomarker changes):",
    );
    for (const m of stopped)
      lines.push(
        `  - ${m.name}${m.dose ? " " + m.dose : ""} (stopped ${m.stopped_date}${m.stop_reason ? ", reason: " + m.stop_reason : ""})`,
      );
  }
  if (recentChanges.length) {
    lines.push(
      "Added/updated this visit (CONTEXT ONLY — do not list separately, already part of active list):",
    );
    for (const m of recentChanges)
      lines.push(
        `  - ${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? " " + m.frequency : ""} (started ${m.started_date || "recent"})`,
      );
  }
  return lines.join("\n");
}

function fmtVitals(vitals) {
  if (!vitals || vitals.length === 0) return "Vitals: (none recorded)";
  const lines = vitals.slice(0, 5).map((v) => {
    const parts = [];
    if (v.bp_sys || v.bp_dia) parts.push(`BP ${v.bp_sys || "?"}/${v.bp_dia || "?"}`);
    if (v.pulse) parts.push(`HR ${v.pulse}`);
    if (v.spo2) parts.push(`SpO2 ${v.spo2}%`);
    if (v.weight) parts.push(`Wt ${v.weight}kg`);
    if (v.bmi) parts.push(`BMI ${v.bmi}`);
    const date = v.recorded_at ? String(v.recorded_at).slice(0, 10) : "";
    return `  - ${date} · ${parts.join(", ")}`;
  });
  return `Vitals (most recent first):\n${lines.join("\n")}`;
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
  if (!diagnoses || diagnoses.length === 0) return "Diagnoses: (none)";
  return (
    "Diagnoses (full list — include grade/stage/severity verbatim when present):\n" +
    diagnoses
      .slice(0, 15)
      .map((d) => {
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
      })
      .join("\n")
  );
}

async function generatePostVisitNarrative(args) {
  let result = await _generatePostVisitNarrativeInner(args, "1");
  if (result && typeof result === "object" && result.error) {
    console.warn(
      `[post-visit AI] first attempt failed (${result.error}) — retrying once after backoff`,
    );
    await new Promise((r) => setTimeout(r, 1500));
    const retry = await _generatePostVisitNarrativeInner(args, "2");
    if (retry && typeof retry === "string" && retry.trim()) return { narrative: retry };
    const finalError = (retry && retry.error) || result.error;
    console.error(`[post-visit AI] both attempts failed — reason: ${finalError}`);
    return { error: finalError };
  }
  if (!result || (typeof result === "string" && !result.trim())) {
    console.warn("[post-visit AI] first attempt produced empty narrative — retrying once");
    await new Promise((r) => setTimeout(r, 1500));
    const retry = await _generatePostVisitNarrativeInner(args, "2");
    if (retry && typeof retry === "string" && retry.trim()) return { narrative: retry };
    return { error: (retry && retry.error) || "Empty narrative on both attempts" };
  }
  return { narrative: result };
}

async function _generatePostVisitNarrativeInner(
  {
    patient,
    diagnoses,
    labHistory,
    activeMeds,
    stoppedMeds = [],
    recentChanges = [],
    vitals,
    prep,
    ctx,
    doctorNote,
  },
  attemptLabel = "1",
) {
  if (!ANTHROPIC_KEY) return null;

  const m = Math.max(0, Math.floor(Number(ctx.monthsWithGini) || 0));
  const d = Math.max(0, Math.floor(Number(ctx.daysWithGini) || 0));
  const yPart = Math.floor(m / 12);
  const mPart = m % 12;
  let monthsLabel;
  if (m === 0) {
    monthsLabel = d === 0 ? "new patient (first visit today)" : `${d}d`;
  } else if (yPart === 0) {
    monthsLabel = `${mPart}m`;
  } else if (mPart === 0) {
    monthsLabel = `${yPart}y`;
  } else {
    monthsLabel = `${yPart}y ${mPart}m`;
  }

  const sexAbbrev =
    patient?.sex && /^m/i.test(patient.sex)
      ? "M"
      : patient?.sex && /^f/i.test(patient.sex)
        ? "F"
        : "";

  const userContent = [
    `Patient: ${patient?.name || "Unknown"}, ${patient?.age ?? "?"}${sexAbbrev}`,
    `Patient ID / file: ${patient?.file_no || patient?.id || "—"}`,
    `Visit number: ${ctx.totalVisits}`,
    `Time on Gini programme: ${monthsLabel}`,
    `Use the supplied value verbatim. Acceptable forms: "Xy Ym", "Nm", "Nd" (less than a month), or the literal phrase "new patient (first visit today)". Never write "X months", "X years", "X days", "0m", or "0d". If the value is "new patient (first visit today)", REPLACE the standard opener — write something like "<Name> is a <age>-year-old <sex>, here today for her/his first visit on the Gini programme." and do not mention any duration at all.`,
    `Care phase: ${ctx.carePhase}`,
    ``,
    fmtDiagnoses(diagnoses),
    ``,
    `Doctor's free-text note for this visit (if any):`,
    doctorNote || "(none provided)",
    ``,
    `Medications:`,
    fmtMeds(activeMeds, stoppedMeds, recentChanges),
    ``,
    fmtVitals(vitals),
    ``,
    fmtPrep(prep),
    ``,
    `Lab panel (latest vs. previous):`,
    fmtLabs(labHistory),
    ``,
    `Generate the post-visit clinical brief as a JSON object { "narrative": "..." } using the two-paragraph structure from the system prompt. Use exact numbers from above; do not invent values. Only list currently active medications. Every diagnosis you mention must inline EVERY qualifier present above (since-year, AOO, grade/marker, severity, status, trend, complication type) verbatim.`,
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
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const reason = `Anthropic API ${resp.status}: ${body.slice(0, 200)}`;
      console.error(`[post-visit AI attempt=${attemptLabel}] ${reason}`);
      return { error: reason };
    }
    const data = await resp.json();
    const stopReason = data.stop_reason || "";
    let text = (data.content || []).map((c) => c.text || "").join("");
    text = text
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
    const parsed = safeParseJson(text);
    if (parsed) {
      const narrative = typeof parsed.narrative === "string" ? parsed.narrative.trim() : null;
      if (!narrative) {
        return { error: `Parsed JSON but "narrative" field was empty or non-string` };
      }
      return narrative;
    }
    // Last-resort recovery — extract narrative by regex when strict JSON
    // fails (usually an unescaped quote inside the narrative string).
    const recovered = recoverNarrativeFromRaw(text);
    if (recovered) {
      console.warn(
        `[post-visit AI attempt=${attemptLabel}] strict JSON parse failed; recovered narrative via regex (stop_reason=${stopReason || "unknown"})`,
      );
      return recovered;
    }
    const reason =
      stopReason === "max_tokens"
        ? `Model output truncated at max_tokens — JSON incomplete`
        : `Model returned malformed JSON (stop_reason=${stopReason || "unknown"})`;
    console.error(`[post-visit AI attempt=${attemptLabel}] ${reason}`);
    console.error(`[post-visit AI attempt=${attemptLabel}] raw text:`, text.slice(0, 600));
    return { error: reason };
  } catch (err) {
    const reason = `Network/runtime error: ${err?.message || String(err)}`;
    console.error(`[post-visit AI attempt=${attemptLabel}] ${reason}`);
    return { error: reason };
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const sanitized = text
      .replace(/\r\n/g, "\\n")
      .replace(/(?<!\\)\n/g, "\\n")
      .replace(/(?<!\\)\r/g, "\\r")
      .replace(/(?<!\\)\t/g, "\\t")
      .replace(/[\u0000-\u001F]/g, "");
    try {
      return JSON.parse(sanitized);
    } catch {
      return null;
    }
  }
}

// Pulls the value of the "narrative" JSON field out of a model response
// that failed strict parsing. Tolerates unescaped quotes inside the value
// by stopping at the closing brace of the object.
function recoverNarrativeFromRaw(text) {
  if (!text || typeof text !== "string") return null;
  const startMatch = text.match(/"narrative"\s*:\s*"/);
  if (!startMatch) return null;
  const start = startMatch.index + startMatch[0].length;
  // Find the end of the narrative: the LAST `"` before either the closing
  // `}` of the object or the end of the buffer.
  const window = text.slice(start);
  const closeBraceIdx = window.search(/"\s*}\s*$/);
  const searchUpTo = closeBraceIdx !== -1 ? closeBraceIdx + 1 : window.length;
  const lastQuote = window.lastIndexOf('"', searchUpTo);
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

// ── GET /api/patients/:id/post-visit-summary ──────────────────────────────────
// Returns { ready, narrative?, carePhase?, cached? }
// ready=false until a consultation exists for the appointment's date.
router.get("/patients/:id/post-visit-summary", async (req, res) => {
  const pid = Number(req.params.id);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });

  let apptId = req.query.appointmentId ? Number(req.query.appointmentId) : null;
  const forceRegen = req.query.regenerate === "true" || req.query.regenerate === "1";

  // Hoisted so the catch block can reject the in-flight promise.
  let resolveFlight = null;
  let rejectFlight = null;

  try {
    // Resolve the appointment date — needed to detect "consultation saved today".
    // If the client sent an appointmentId, verify it belongs to this patient
    // (cache is keyed by appointmentId, so a mismatch would return another
    // patient's cached summary). Mismatched or missing → fall back to latest.
    let apptDate = null;
    let apptStatus = null;
    if (apptId) {
      const r = await pool.query(
        `SELECT patient_id, appointment_date, status FROM appointments WHERE id=$1`,
        [apptId],
      );
      const ownerPid = r.rows[0]?.patient_id ?? null;
      if (ownerPid !== pid) {
        console.warn(
          `[post-visit] MISMATCH patient=${pid} sent appt=${apptId} which belongs to patient=${ownerPid ?? "none"} — ignoring and falling back to latest`,
        );
        apptId = null;
      } else {
        apptDate = r.rows[0]?.appointment_date || null;
        apptStatus = r.rows[0]?.status || null;
      }
    }
    if (!apptId) {
      // Prefer today's appointment over any past one. Otherwise a patient
      // with a pending appointment today and a previously-completed visit
      // would resolve to the past appointment and incorrectly serve its
      // cached post-summary.
      const latestR = await pool.query(
        `SELECT id, appointment_date, status FROM appointments
          WHERE patient_id=$1
          ORDER BY (appointment_date::date = CURRENT_DATE) DESC,
                   appointment_date DESC NULLS LAST, id DESC
          LIMIT 1`,
        [pid],
      );
      apptId = latestR.rows[0]?.id || null;
      apptDate = latestR.rows[0]?.appointment_date || null;
      apptStatus = latestR.rows[0]?.status || null;
    } else if (apptDate) {
      // Explicit apptId was passed, but if it points to a past date AND the
      // patient has a today's appointment, prefer today's. The frontend often
      // falls back to `latestAppointmentId` (a previously completed visit),
      // which would otherwise serve its post-summary while today's pending
      // visit is what the doctor is actually looking at.
      const apptDateStr = new Date(apptDate).toISOString().slice(0, 10);
      const todayStr = new Date().toISOString().slice(0, 10);
      if (apptDateStr < todayStr) {
        const todayR = await pool.query(
          `SELECT id, appointment_date, status FROM appointments
            WHERE patient_id=$1 AND appointment_date::date = CURRENT_DATE
            ORDER BY id DESC LIMIT 1`,
          [pid],
        );
        if (todayR.rows[0]) {
          console.log(
            `[post-visit] SWAP patient=${pid} from past appt=${apptId} (${apptDateStr}) to today's appt=${todayR.rows[0].id} (status=${todayR.rows[0].status})`,
          );
          apptId = todayR.rows[0].id;
          apptDate = todayR.rows[0].appointment_date;
          apptStatus = todayR.rows[0].status || null;
        }
      }
    }

    // Readiness gate: post-visit summary is "ready" once the appointment is
    // marked 'seen' or 'completed'. Anything earlier (scheduled, etc.) keeps
    // the UI on the pre-visit summary.
    if (apptStatus !== "seen" && apptStatus !== "completed") {
      return res.json({ ready: false, status: apptStatus });
    }

    const checkDate = apptDate
      ? new Date(apptDate).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const consCheckR = await pool.query(
      `SELECT id, con_data FROM consultations
       WHERE patient_id=$1 AND visit_date::date = $2::date
       ORDER BY created_at DESC LIMIT 1`,
      [pid, checkDate],
    );
    const consultation = consCheckR.rows[0];
    if (!consultation) return res.json({ ready: false, status: apptStatus });

    // Cache check (per-appointment) — valid until invalidated, no TTL.
    if (apptId && !forceRegen) {
      const cacheR = await pool.query(`SELECT post_visit_summary FROM appointments WHERE id=$1`, [
        apptId,
      ]);
      const row = cacheR.rows[0];
      const cached = row?.post_visit_summary;
      const cachedOk = !!(cached && cached.narrative);
      if (cached && cachedOk) {
        console.log(`[post-visit] HIT  patient=${pid} appt=${apptId} (cached)`);
        return res.json({ ready: true, ...cached, cached: true });
      }
      if (cached && !cachedOk) {
        console.warn(
          `[post-visit] STALE-NULL patient=${pid} appt=${apptId} — discarding broken cached row, regenerating`,
        );
        await pool
          .query(
            `UPDATE appointments SET post_visit_summary=NULL, post_visit_summary_generated_at=NULL WHERE id=$1`,
            [apptId],
          )
          .catch(() => {});
      } else {
        console.log(`[post-visit] MISS patient=${pid} appt=${apptId} — generating`);
      }
    } else if (forceRegen) {
      console.log(`[post-visit] REGEN patient=${pid} appt=${apptId} — bypassing cache`);
    } else {
      console.log(`[post-visit] NO-APPT patient=${pid} — cannot cache`);
    }

    // Single-flight: collapse parallel cold-cache requests for the same
    // (patient, appointment) into one Anthropic call.
    const flightKey = `post:${pid}:${apptId || "latest"}`;
    if (!forceRegen && inFlight.has(flightKey)) {
      const payload = await inFlight.get(flightKey);
      return res.json({ ready: true, ...payload, cached: true });
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

    // Pull data — labs/vitals come from the shared helper so this brief
    // mirrors the /visit page exactly (same labLatest/labHistory/vitals,
    // including appointments.biomarkers JSONB and patient_vitals_log
    // app readings).
    const labCtxPromise = buildVisitLabContext(pool, pid);
    const [
      patientR,
      diagnosesR,
      activeMedsR,
      stoppedMedsR,
      recentChangesR,
      consAllR,
      apptComplianceR,
    ] = await Promise.all([
      pool.query("SELECT * FROM patients WHERE id=$1", [pid]),
      pool.query(
        `SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
           WHERE patient_id=$1 ORDER BY diagnosis_id, is_active DESC, updated_at DESC`,
        [pid],
      ),
      pool.query(
        `SELECT id, name, dose, frequency, timing, started_date,
                parent_medication_id, support_condition
           FROM medications
           WHERE patient_id=$1 AND is_active=true`,
        [pid],
      ),
      pool.query(
        `SELECT id, name, dose, stopped_date, stop_reason, parent_medication_id FROM medications
           WHERE patient_id=$1 AND is_active=false AND stopped_date > CURRENT_DATE - INTERVAL '60 days'`,
        [pid],
      ),
      pool.query(
        `SELECT id, name, dose, frequency, started_date, parent_medication_id FROM medications
           WHERE patient_id=$1 AND started_date > CURRENT_DATE - INTERVAL '14 days'`,
        [pid],
      ),
      // EXACT same union+dedup as /visit/:patientId so the visit count
      // matches the UI strip's "N visits" badge.
      pool.query(
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
      ),
      apptId
        ? pool.query(`SELECT compliance FROM appointments WHERE id=$1`, [apptId])
        : pool.query(
            `SELECT compliance FROM appointments WHERE patient_id=$1 ORDER BY appointment_date DESC LIMIT 1`,
            [pid],
          ),
    ]);

    const patient = patientR.rows[0];
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const { labHistory, vitals: mergedVitals } = await labCtxPromise;

    // Mirror the JS dedup from /visit/:patientId — collapse duplicate
    // (visit_date, status) pairs from the SQL union.
    const _seenVisits = new Set();
    const visitRows = consAllR.rows.filter((c) => {
      const key = `${c.visit_date}|${c.status}`;
      if (_seenVisits.has(key)) return false;
      _seenVisits.add(key);
      return true;
    });
    const totalVisits = visitRows.length;
    // SQL ordered DESC, so the oldest is the last entry.
    const firstDate = visitRows.length ? visitRows[visitRows.length - 1].visit_date : null;
    let monthsWithGini = 0;
    let daysWithGini = 0;
    if (firstDate) {
      const diffMs = Date.now() - new Date(firstDate).getTime();
      daysWithGini = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      monthsWithGini = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30)));
    }
    const carePhaseResult = computeCarePhase({
      labHistory,
      vitals: mergedVitals,
      totalVisits,
      diagnoses: diagnosesR.rows,
    });
    // Mirror the visit-page pill: a single biomarker — HbA1c (diabetes) → TSH
    // (thyroid) → FBS (fallback) — drives the headline phase so the API,
    // pill, and AI narrative cannot disagree about whether the patient is
    // controlled or not.
    const bioPriority = deriveBiomarkerPriorityStatus({
      labHistory,
      vitals: mergedVitals,
      diagnoses: diagnosesR.rows,
    });
    const carePhase = bioPriority?.phase || carePhaseResult.carePhase;

    // Doctor's free-text note from the saved consultation (if any)
    let doctorNote = null;
    try {
      const cd = consultation.con_data;
      if (cd && typeof cd === "object") {
        doctorNote = cd.doctorSummary || cd.doctor_summary || cd.summary || cd.note || null;
      }
    } catch {
      doctorNote = null;
    }

    const apptCompliance = apptComplianceR.rows[0]?.compliance || {};
    const prep = {
      medPct: apptCompliance.medPct ?? null,
      missed: apptCompliance.missed || null,
      symptoms: apptCompliance.symptoms || [],
    };

    const aiResult = await generatePostVisitNarrative({
      patient,
      diagnoses: sortDiagnoses(diagnosesR.rows),
      labHistory,
      // Drop child/support meds from every bucket — only top-level parent
      // meds should appear (or be reasoned about) in the post-visit brief.
      activeMeds: activeMedsR.rows.filter((m) => !m.parent_medication_id),
      stoppedMeds: stoppedMedsR.rows.filter((m) => !m.parent_medication_id),
      recentChanges: recentChangesR.rows.filter((m) => !m.parent_medication_id),
      vitals: mergedVitals,
      prep,
      ctx: { totalVisits, monthsWithGini, daysWithGini, carePhase },
      doctorNote,
    });
    const narrative = aiResult?.narrative || null;
    const aiError = aiResult?.error || null;

    const generatedAt = new Date().toISOString();
    const payload = {
      narrative,
      aiError,
      carePhase,
      carePhaseBasis: carePhaseResult.carePhaseBasis,
      carePhaseCategory: carePhaseResult.carePhaseCategory,
      carePhaseDrivers: bioPriority ? [bioPriority.marker] : carePhaseResult.carePhaseDrivers,
      carePhaseParameters: carePhaseResult.carePhaseParameters,
      carePhasePriority: bioPriority
        ? {
            marker: bioPriority.marker,
            value: bioPriority.value,
            target: bioPriority.target,
            status: bioPriority.status,
            label: bioPriority.label,
            date: bioPriority.date,
          }
        : null,
      visitDate: checkDate,
      totalVisits,
      monthsWithGini,
      generatedAt,
    };

    // Only cache when narrative succeeded — otherwise next request retries.
    const narrativeOk = !!(narrative && String(narrative).trim());
    if (apptId && narrativeOk) {
      try {
        const updR = await pool.query(
          `UPDATE appointments
           SET post_visit_summary=$1, post_visit_summary_generated_at=$2
           WHERE id=$3`,
          [JSON.stringify(payload), generatedAt, apptId],
        );
        console.log(
          `[post-visit] SAVED patient=${pid} appt=${apptId} rowsUpdated=${updR.rowCount}`,
        );
      } catch (err) {
        console.error(
          `[post-visit] cache write FAILED patient=${pid} appt=${apptId}:`,
          err?.message || err,
        );
      }
    } else if (!apptId) {
      console.warn(`[post-visit] cache NOT WRITTEN patient=${pid} — no appointment row`);
    } else {
      console.warn(
        `[post-visit] cache NOT WRITTEN patient=${pid} appt=${apptId} — AI failed (reason: ${aiError || "unknown"}); next request will retry`,
      );
    }

    if (resolveFlight) resolveFlight(payload);
    return res.json({ ready: true, ...payload, cached: false });
  } catch (err) {
    if (rejectFlight) rejectFlight(err);
    handleError(res, err, "Failed to generate post-visit summary");
  }
});

// Invalidate cache (call after a consultation is re-saved)
router.delete("/patients/:id/post-visit-summary/cache", async (req, res) => {
  const apptId = req.query.appointmentId ? Number(req.query.appointmentId) : null;
  if (!apptId) return res.status(400).json({ error: "appointmentId query param required" });
  try {
    await pool.query(
      `UPDATE appointments
       SET post_visit_summary=NULL, post_visit_summary_generated_at=NULL
       WHERE id=$1`,
      [apptId],
    );
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, "Failed to invalidate post-visit summary cache");
  }
});

export default router;
