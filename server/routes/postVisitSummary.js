import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";

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
  const childrenByParent = {};
  for (const m of active) {
    if (m.parent_medication_id) {
      (childrenByParent[m.parent_medication_id] ||= []).push(m);
    }
  }
  const parents = active.filter((m) => !m.parent_medication_id);
  for (const m of parents) {
    lines.push(
      `  - ${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? " " + m.frequency : ""}${m.timing ? " (" + m.timing + ")" : ""}`,
    );
    for (const child of childrenByParent[m.id] || []) {
      const cond = child.support_condition ? ` — ${child.support_condition}` : "";
      lines.push(
        `      ↳ ${child.name}${child.dose ? " " + child.dose : ""}${child.frequency ? " " + child.frequency : ""}${cond}`,
      );
    }
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

async function generatePostVisitNarrative(args) {
  let result = await _generatePostVisitNarrativeInner(args, "1");
  if (!result || !String(result).trim()) {
    console.warn("[post-visit AI] first attempt produced no narrative — retrying once");
    result = await _generatePostVisitNarrativeInner(args, "2");
  }
  return result || null;
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
    `Generate the post-visit clinical brief as a JSON object { "narrative": "..." } using the 5-section structured format from the system prompt. Use exact numbers from above; do not invent values. Only list currently active medications.`,
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
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(
        `[post-visit AI attempt=${attemptLabel}] Anthropic ${resp.status}: ${body.slice(0, 400)}`,
      );
      return null;
    }
    const data = await resp.json();
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
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error(`[post-visit AI attempt=${attemptLabel}] JSON parse failed:`, e.message);
      console.error(`[post-visit AI attempt=${attemptLabel}] raw text:`, text.slice(0, 600));
      return null;
    }
    return typeof parsed.narrative === "string" ? parsed.narrative.trim() : null;
  } catch (err) {
    console.error(
      `[post-visit AI attempt=${attemptLabel}] generation failed:`,
      err?.message || err,
    );
    return null;
  }
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
    // If the client didn't send appointmentId, fall back to the patient's latest
    // appointment so the cache key is stable across calls.
    let apptDate = null;
    if (!apptId) {
      const latestR = await pool.query(
        `SELECT id, appointment_date FROM appointments
          WHERE patient_id=$1
          ORDER BY appointment_date DESC NULLS LAST, id DESC
          LIMIT 1`,
        [pid],
      );
      apptId = latestR.rows[0]?.id || null;
      apptDate = latestR.rows[0]?.appointment_date || null;
    } else {
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
        `SELECT id, name, dose, frequency, timing, started_date,
                parent_medication_id, support_condition
           FROM medications
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
      ctx: { totalVisits, monthsWithGini, daysWithGini, carePhase },
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
        `[post-visit] cache NOT WRITTEN patient=${pid} appt=${apptId} — narrative empty; next request will retry`,
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
