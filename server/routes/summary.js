import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { runSummaryRules } from "../services/summaryRules.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";

const router = Router();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

const SYSTEM_PROMPT = `You are a clinical assistant briefing a doctor before they see a patient.
Be concise, specific, and clinical. Use exact numbers from the data provided.
Never be vague. Never use generic language.
Format output as JSON with four fields: narrative, red_alerts, amber_alerts, green_notes.

The "narrative" field is a single prose paragraph (4–7 sentences, ~100–140 words) that gives the doctor an at-a-glance briefing they could read in 20 seconds and walk into the room. It MUST:
- Open with: "<First name> is a <age>-year-old <man|woman> with <comma-separated active conditions>, on <N> active medications."
- State visit number and months on programme (use the values provided).
- Highlight what is performing well using exact numbers (e.g. "HbA1c is controlled at 5.9% and LDL is at target (22.3 mg/dL)").
- Pivot with "However," / "But" / "Three things need your attention before you start:" and concisely flag what needs action today, citing exact numbers and class consequences.
- Use plain clinical prose — no bullet points, no markdown, no emojis inside the narrative.
- Do not hallucinate numbers; only use values present in the data below.

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
    const bits = [d.label || d.name || "Unknown"];
    if (d.since) bits.push(`since ${d.since}`);
    if (d.severity) bits.push(d.severity);
    if (d.is_active === false) bits.push("(inactive)");
    return `  - ${bits.join(" · ")}`;
  });
  return `Diagnoses (full list):\n${lines.join("\n")}`;
}

async function generateAiBrief(patient, diagnoses, alerts, labHistory, ctx = {}) {
  if (!ANTHROPIC_KEY) return null;
  const total = alerts.red.length + alerts.amber.length + alerts.green.length;
  if (total === 0) return null;

  const firstName = (patient?.name || "").trim().split(/\s+/)[0] || "Patient";
  const sexWord =
    patient?.sex && /^m/i.test(patient.sex)
      ? "man"
      : patient?.sex && /^f/i.test(patient.sex)
        ? "woman"
        : "patient";
  const userContent = [
    `Patient: ${patient?.name || "Unknown"}, ${patient?.age ?? "?"}y${patient?.sex ? ", " + patient.sex : ""}`,
    `First name (use in narrative opener): ${firstName}`,
    `Sex word (use in narrative opener): ${sexWord}`,
    `Phone: ${patient?.phone || "—"}`,
    `Patient ID / file: ${patient?.file_no || patient?.id || "—"}`,
    `Visit number: ${ctx.totalVisits ?? "?"}`,
    `Months on programme: ${ctx.monthsWithGini ?? "?"}`,
    `Care phase: ${ctx.carePhase ?? "?"}`,
    `Active medications count: ${ctx.activeMedsCount ?? "?"}`,
    ``,
    fmtDiagnoses(diagnoses),
    ``,
    fmtMedList(ctx.activeMeds || [], "Active medications"),
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
    `Generate the clinical briefing as described in the system prompt. Return only valid JSON with fields narrative, red_alerts, amber_alerts, green_notes. When labs or vitals have changed meaningfully vs. previous, surface that in the narrative and the appropriate zone with exact numbers and delta. Cross-reference active medications against diagnoses to flag protocol gaps (e.g. nephropathy without ACE/ARB, CAD without statin/aspirin) and stopped high-weight drugs against their corresponding biomarker trends.`,
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
        max_tokens: 1100,
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
    return {
      narrative: typeof parsed.narrative === "string" ? parsed.narrative.trim() : null,
      red: (parsed.red_alerts || []).slice(0, 3),
      amber: (parsed.amber_alerts || []).slice(0, 3),
      green: (parsed.green_notes || []).slice(0, 3),
    };
  } catch {
    return null;
  }
}

// ── GET /api/patients/:id/summary ─────────────────────────────────────────────
// Query params: appointmentId (optional) — if omitted, uses latest appointment
// Cache TTL: 1 hour (stored in appointments.ai_summary)

router.get("/patients/:id/summary", async (req, res) => {
  const pid = Number(req.params.id);
  if (!pid) return res.status(400).json({ error: "Invalid patient ID" });

  const apptId = req.query.appointmentId ? Number(req.query.appointmentId) : null;

  try {
    // ── 1. Check cache ──
    if (apptId) {
      const cacheR = await pool.query(
        `SELECT ai_summary, ai_summary_generated_at FROM appointments WHERE id=$1`,
        [apptId],
      );
      const row = cacheR.rows[0];
      if (row?.ai_summary && row.ai_summary_generated_at) {
        const ageMs = Date.now() - new Date(row.ai_summary_generated_at).getTime();
        if (ageMs < 10 * 60 * 1000) {
          // 10 min cache (was 1 hour)
          // < 1 hour — serve from cache
          return res.json({ ...row.ai_summary, cached: true });
        }
      }
    }

    // ── 2. Fetch data needed for the rule engine ──
    const [patientR, diagnosesR, labsR, vitalsR, apptR, latestReportR, activeMedsR, stoppedMedsR] =
      await Promise.all([
        pool.query("SELECT * FROM patients WHERE id=$1", [pid]),

        pool.query(
          `SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
           WHERE patient_id=$1 ORDER BY diagnosis_id, is_active DESC, updated_at DESC`,
          [pid],
        ),

        // All labs deduped (same query as visit route)
        pool.query(
          `SELECT * FROM (
             SELECT DISTINCT ON (COALESCE(canonical_name, test_name), test_date::date)
               *
             FROM lab_results
             WHERE patient_id=$1
             ORDER BY
               COALESCE(canonical_name, test_name),
               test_date::date,
               CASE source
                 WHEN 'opd'                THEN 1
                 WHEN 'report_extract'     THEN 2
                 WHEN 'lab_healthray'      THEN 3
                 WHEN 'vitals_sheet'       THEN 4
                 WHEN 'prescription_parsed' THEN 5
                 WHEN 'healthray'          THEN 6
                 ELSE 7
               END ASC,
               created_at DESC
           ) deduped
           ORDER BY test_date DESC`,
          [pid],
        ),

        pool.query(`SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC LIMIT 5`, [
          pid,
        ]),

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

        // Active medications (for drug-interaction and protocol-gap rules)
        pool.query(
          `SELECT id, name, dose, frequency FROM medications WHERE patient_id=$1 AND is_active=true`,
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

    // ── 3. Build labHistory (newest-first per test, same as visit route) ──
    const labHistory = {};
    for (const r of labsR.rows) {
      const key = r.canonical_name || r.test_name;
      if (!labHistory[key]) labHistory[key] = [];
      labHistory[key].push({ result: r.result, unit: r.unit, flag: r.flag, date: r.test_date });
    }

    // ── 4. Build prep ──
    const apptRow = apptR.rows[0] || null;
    const resolvedApptId = apptId || apptRow?.id || null;
    const apptCompliance = apptRow?.compliance || {};
    const prep = {
      medPct: apptCompliance.medPct ?? null,
      missed: apptCompliance.missed || null,
      symptoms: apptCompliance.symptoms || [],
    };

    // ── 5. Run rule engine ──
    const sortedDiagnoses = sortDiagnoses(diagnosesR.rows);
    const rules = runSummaryRules({
      diagnoses: sortedDiagnoses,
      activeMeds: activeMedsR.rows,
      stoppedMeds: stoppedMedsR.rows,
      labResults: labsR.rows,
      labHistory,
      vitals: vitalsR.rows,
      prep,
    });

    // ── 6. Compute visit context for narrative (cheap, single query) ──
    const consR = await pool.query(
      `SELECT visit_date FROM consultations WHERE patient_id=$1 ORDER BY visit_date ASC`,
      [pid],
    );
    const totalVisits = consR.rows.length;
    const firstVisitDate = consR.rows[0]?.visit_date || null;
    let monthsWithGini = 0;
    if (firstVisitDate) {
      monthsWithGini = Math.max(
        0,
        Math.floor((Date.now() - new Date(firstVisitDate).getTime()) / (1000 * 60 * 60 * 24 * 30)),
      );
    }
    let carePhase = "Phase 1 · Control";
    if (totalVisits >= 10) carePhase = "Phase 3 · Sustain";
    else if (totalVisits >= 4) carePhase = "Phase 2 · Stabilize";

    // ── 7. Generate AI brief (async, non-blocking for cache write) ──
    const ai = await generateAiBrief(patient, sortedDiagnoses, rules, labHistory, {
      totalVisits,
      monthsWithGini,
      carePhase,
      activeMedsCount: activeMedsR.rows.length,
      activeMeds: activeMedsR.rows,
      stoppedMeds: stoppedMedsR.rows,
      vitals: vitalsR.rows,
      prep,
    });

    const generatedAt = new Date().toISOString();
    const latestReport = latestReportR.rows[0] || null;
    // dataAsOf = the date of the most recent piece of data used by the rules
    const dataAsOf =
      latestReport?.doc_date || latestReport?.created_at || labsR.rows[0]?.test_date || generatedAt;
    const payload = {
      rules,
      ai,
      generatedAt,
      dataAsOf,
      cached: false,
      latestReport,
      visitContext: { totalVisits, monthsWithGini, carePhase },
    };

    // ── 7. Store in cache ──
    if (resolvedApptId) {
      pool
        .query(
          `UPDATE appointments
         SET ai_summary=$1, ai_summary_generated_at=$2
         WHERE id=$3`,
          [JSON.stringify(payload), generatedAt, resolvedApptId],
        )
        .catch(() => {}); // fire-and-forget; don't block response
    }

    return res.json(payload);
  } catch (err) {
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
