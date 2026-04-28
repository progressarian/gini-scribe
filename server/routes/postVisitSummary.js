import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";

const router = Router();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

const SYSTEM_PROMPT = `You are writing a post-visit summary for a doctor's records, after a patient consultation has just been completed and the prescription has been finalised.

Tone: clinical but warm; past-tense for what happened in this visit; present-tense for current status. Plain prose only — no bullets, no markdown, no emojis.

Format output as JSON with one field: { "narrative": "..." }.

The narrative MUST be 3 short paragraphs separated by a blank line (use "\\n\\n"):

Paragraph 1 — Opener:
"<Full name>, <age><M|F> — <X months|years> on the Gini Diabetes Control Programme."  (One sentence.)

Paragraph 2 — What is improving / staying well:
2–4 sentences citing exact numbers and the trend vs. earlier visits or baseline. State which existing medicines are being kept and why.

Paragraph 3 — What changed this visit and goals:
2–4 sentences describing what was added, stopped, or dose-adjusted this visit, why the change was made (e.g. uncontrolled BP on dual therapy → added third agent), the target to reach by next visit, and any lifestyle advice given. End with the next-review intent.

Use exact biomarker numbers, drug names, and doses from the data provided. Do not invent numbers. Keep total length 110–180 words.`;

function fmtAlerts(rules) {
  const lines = [];
  for (const a of rules.red || [])
    lines.push(`[RED]   ${a.title}${a.detail ? " — " + a.detail : ""}`);
  for (const a of rules.amber || [])
    lines.push(`[AMBER] ${a.title}${a.detail ? " — " + a.detail : ""}`);
  for (const a of rules.green || [])
    lines.push(`[GREEN] ${a.title}${a.detail ? " — " + a.detail : ""}`);
  return lines.join("\n") || "(none)";
}

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

function fmtMeds(active, stopped, recentChanges) {
  const lines = [];
  lines.push("Currently active:");
  if (active.length === 0) lines.push("  (none)");
  for (const m of active)
    lines.push(
      `  - ${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? " " + m.frequency : ""}${m.timing ? " (" + m.timing + ")" : ""}${m.started_date ? " · started " + String(m.started_date).slice(0, 10) : ""}`,
    );
  if (stopped.length) {
    lines.push("Stopped within last 60 days:");
    for (const m of stopped)
      lines.push(
        `  - ${m.name}${m.dose ? " " + m.dose : ""} (stopped ${m.stopped_date}${m.stop_reason ? ", reason: " + m.stop_reason : ""})`,
      );
  }
  if (recentChanges.length) {
    lines.push("Added/updated in the last 14 days (this visit):");
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
    "Diagnoses (full list):\n" +
    diagnoses
      .slice(0, 15)
      .map((d) => {
        const bits = [d.label || d.name || "Unknown"];
        if (d.since) bits.push(`since ${d.since}`);
        if (d.severity) bits.push(d.severity);
        if (d.is_active === false) bits.push("(inactive)");
        return `  - ${bits.join(" · ")}`;
      })
      .join("\n")
  );
}

async function generatePostVisitNarrative({
  patient,
  diagnoses,
  labHistory,
  activeMeds,
  stoppedMeds,
  recentChanges,
  vitals,
  prep,
  ctx,
  doctorNote,
}) {
  if (!ANTHROPIC_KEY) return null;

  const monthsLabel =
    ctx.monthsWithGini >= 12
      ? `${Math.floor(ctx.monthsWithGini / 12)} year${Math.floor(ctx.monthsWithGini / 12) > 1 ? "s" : ""}${ctx.monthsWithGini % 12 ? " and " + (ctx.monthsWithGini % 12) + " months" : ""}`
      : `${ctx.monthsWithGini} months`;

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
    `Months on programme: ${monthsLabel}`,
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
    `Generate the post-visit summary as a JSON object { "narrative": "..." }. Keep to the 3-paragraph format described in the system prompt. Use exact numbers from above; do not invent values. Reference vitals (BP, weight) and compliance trends if relevant. The "what changed" paragraph must specifically cite anything in "Added/updated in the last 14 days" with the new dose and the clinical reason inferred from the diagnoses + biomarkers.`,
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
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    let text = (data.content || []).map((c) => c.text || "").join("");
    text = text
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(text);
    return typeof parsed.narrative === "string" ? parsed.narrative.trim() : null;
  } catch {
    return null;
  }
}

// ── GET /api/patients/:id/post-visit-summary ──────────────────────────────────
// Returns { ready, narrative?, carePhase?, cached? }
// ready=false until a consultation exists for the appointment's date.
router.get("/patients/:id/post-visit-summary", async (req, res) => {
  const pid = Number(req.params.id);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });

  const apptId = req.query.appointmentId ? Number(req.query.appointmentId) : null;

  try {
    // Resolve the appointment date — needed to detect "consultation saved today"
    let apptDate = null;
    if (apptId) {
      const r = await pool.query(`SELECT appointment_date FROM appointments WHERE id=$1`, [apptId]);
      apptDate = r.rows[0]?.appointment_date || null;
    }

    // Readiness check: a consultation exists for this patient on the appointment date
    // (or today, if no appointment provided).
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
    if (!consultation) return res.json({ ready: false });

    // Cache check (per-appointment)
    if (apptId) {
      const cacheR = await pool.query(
        `SELECT post_visit_summary, post_visit_summary_generated_at FROM appointments WHERE id=$1`,
        [apptId],
      );
      const row = cacheR.rows[0];
      if (row?.post_visit_summary && row.post_visit_summary_generated_at) {
        const age = Date.now() - new Date(row.post_visit_summary_generated_at).getTime();
        if (age < 60 * 60 * 1000) {
          return res.json({ ready: true, ...row.post_visit_summary, cached: true });
        }
      }
    }

    // Pull data
    const [
      patientR,
      diagnosesR,
      labsR,
      activeMedsR,
      stoppedMedsR,
      recentChangesR,
      consAllR,
      vitalsR,
      apptComplianceR,
    ] = await Promise.all([
      pool.query("SELECT * FROM patients WHERE id=$1", [pid]),
      pool.query(
        `SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
           WHERE patient_id=$1 ORDER BY diagnosis_id, is_active DESC, updated_at DESC`,
        [pid],
      ),
      pool.query(
        `SELECT * FROM (
             SELECT DISTINCT ON (COALESCE(canonical_name, test_name), test_date::date) *
             FROM lab_results WHERE patient_id=$1
             ORDER BY COALESCE(canonical_name, test_name), test_date::date, created_at DESC
           ) d ORDER BY test_date DESC`,
        [pid],
      ),
      pool.query(
        `SELECT id, name, dose, frequency, started_date FROM medications
           WHERE patient_id=$1 AND is_active=true`,
        [pid],
      ),
      pool.query(
        `SELECT id, name, dose, stopped_date, stop_reason FROM medications
           WHERE patient_id=$1 AND is_active=false AND stopped_date > CURRENT_DATE - INTERVAL '60 days'`,
        [pid],
      ),
      pool.query(
        `SELECT id, name, dose, frequency, started_date FROM medications
           WHERE patient_id=$1 AND started_date > CURRENT_DATE - INTERVAL '14 days'`,
        [pid],
      ),
      pool.query(
        `SELECT visit_date FROM consultations WHERE patient_id=$1 ORDER BY visit_date ASC`,
        [pid],
      ),
      pool.query(`SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC LIMIT 5`, [
        pid,
      ]),
      apptId
        ? pool.query(`SELECT compliance FROM appointments WHERE id=$1`, [apptId])
        : pool.query(
            `SELECT compliance FROM appointments WHERE patient_id=$1 ORDER BY appointment_date DESC LIMIT 1`,
            [pid],
          ),
    ]);

    const patient = patientR.rows[0];
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const labHistory = {};
    for (const r of labsR.rows) {
      const key = r.canonical_name || r.test_name;
      if (!labHistory[key]) labHistory[key] = [];
      labHistory[key].push({ result: r.result, unit: r.unit, flag: r.flag, date: r.test_date });
    }

    const totalVisits = consAllR.rows.length;
    const firstDate = consAllR.rows[0]?.visit_date || null;
    let monthsWithGini = 0;
    if (firstDate) {
      monthsWithGini = Math.max(
        0,
        Math.floor((Date.now() - new Date(firstDate).getTime()) / (1000 * 60 * 60 * 24 * 30)),
      );
    }
    let carePhase = "Phase 1 · Control";
    if (totalVisits >= 10) carePhase = "Phase 3 · Sustain";
    else if (totalVisits >= 4) carePhase = "Phase 2 · Stabilize";

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

    const narrative = await generatePostVisitNarrative({
      patient,
      diagnoses: sortDiagnoses(diagnosesR.rows),
      labHistory,
      activeMeds: activeMedsR.rows,
      stoppedMeds: stoppedMedsR.rows,
      recentChanges: recentChangesR.rows,
      vitals: vitalsR.rows,
      prep,
      ctx: { totalVisits, monthsWithGini, carePhase },
      doctorNote,
    });

    const generatedAt = new Date().toISOString();
    const payload = {
      narrative,
      carePhase,
      visitDate: checkDate,
      totalVisits,
      monthsWithGini,
      generatedAt,
    };

    if (apptId) {
      pool
        .query(
          `UPDATE appointments
           SET post_visit_summary=$1, post_visit_summary_generated_at=$2
           WHERE id=$3`,
          [JSON.stringify(payload), generatedAt, apptId],
        )
        .catch(() => {});
    }

    return res.json({ ready: true, ...payload, cached: false });
  } catch (err) {
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
