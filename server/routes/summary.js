import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { runSummaryRules } from "../services/summaryRules.js";

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
Format output as JSON with three arrays: red_alerts, amber_alerts, green_notes.
Each item is a single sentence. Maximum 3 items per zone.
Do not hallucinate — only use information explicitly provided in the rule alerts.`;

function formatAlerts(alerts) {
  const lines = [];
  for (const a of alerts.red) lines.push(`[RED]   ${a.title}${a.detail ? " — " + a.detail : ""}`);
  for (const a of alerts.amber) lines.push(`[AMBER] ${a.title}${a.detail ? " — " + a.detail : ""}`);
  for (const a of alerts.green) lines.push(`[GREEN] ${a.title}${a.detail ? " — " + a.detail : ""}`);
  return lines.join("\n");
}

async function generateAiBrief(patient, diagnoses, alerts) {
  if (!ANTHROPIC_KEY) return null;
  const total = alerts.red.length + alerts.amber.length + alerts.green.length;
  if (total === 0) return null;

  const dx =
    diagnoses
      .map((d) => d.label)
      .filter(Boolean)
      .join(", ") || "Not recorded";
  const userContent = [
    `Patient: ${patient?.name || "Unknown"}, ${patient?.age ?? "?"}y${patient?.sex ? ", " + patient.sex : ""}`,
    `Diagnoses: ${dx}`,
    ``,
    `Rule engine alerts:`,
    formatAlerts(alerts),
    ``,
    `Generate a clinical briefing. Return only valid JSON.`,
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
        max_tokens: 600,
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
        if (ageMs < 60 * 60 * 1000) {
          // < 1 hour — serve from cache
          return res.json({ ...row.ai_summary, cached: true });
        }
      }
    }

    // ── 2. Fetch data needed for the rule engine ──
    const [patientR, diagnosesR, activeMedsR, stoppedMedsR, labsR, vitalsR, apptR, docsR] =
      await Promise.all([
        pool.query("SELECT * FROM patients WHERE id=$1", [pid]),

        pool.query(
          `SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
           WHERE patient_id=$1 ORDER BY diagnosis_id, created_at DESC`,
          [pid],
        ),

        pool.query(
          `SELECT m.* FROM medications m
           WHERE m.patient_id=$1 AND m.is_active=true
           ORDER BY m.created_at DESC`,
          [pid],
        ),

        pool.query(
          `SELECT DISTINCT ON (UPPER(COALESCE(pharmacy_match, name)))
             id, name, pharmacy_match, stop_reason, stopped_date
           FROM medications
           WHERE patient_id=$1 AND is_active=false
           ORDER BY UPPER(COALESCE(pharmacy_match, name)), stopped_date DESC NULLS LAST`,
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

        // Unreviewed documents
        pool.query(
          `SELECT id, title, file_name, doc_type, reviewed FROM documents
           WHERE patient_id=$1 AND reviewed=FALSE
           ORDER BY created_at DESC`,
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
    const rules = runSummaryRules({
      diagnoses: diagnosesR.rows,
      activeMeds: activeMedsR.rows,
      stoppedMeds: stoppedMedsR.rows,
      labResults: labsR.rows,
      labHistory,
      vitals: vitalsR.rows,
      documents: docsR.rows,
      prep,
    });

    // ── 6. Generate AI brief (async, non-blocking for cache write) ──
    const ai = await generateAiBrief(patient, diagnosesR.rows, rules);

    const generatedAt = new Date().toISOString();
    const payload = { rules, ai, generatedAt, cached: false };

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
