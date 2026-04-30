// Shared helper that builds the same labLatest / labHistory / vitals shapes
// the /visit/:patientId endpoint returns. Used by /visit, the pre-visit
// summary, and the post-visit summary so all three see identical numbers.
//
// Mirrors server/routes/visit.js (lab query, labLatest/labHistory build,
// appointments.biomarkers JSONB seeding, patient_vitals_log merge).

import { getCanonical } from "../utils/labCanonical.js";
import { LAB_MAP } from "../routes/opd.js";

export async function buildVisitLabContext(pool, patientId) {
  const pid = Number(patientId);

  const [labsR, vitalsR, vitalsLogR, bioR] = await Promise.all([
    pool.query(
      `SELECT
         lr.id, lr.patient_id, lr.appointment_id,
         COALESCE(a.appointment_date::date, lr.test_date) AS test_date,
         lr.test_date AS lab_test_date,
         lr.test_name, lr.canonical_name, lr.result, lr.result_text, lr.unit,
         lr.ref_range, lr.flag, lr.is_critical, lr.source, lr.panel_name, lr.created_at
       FROM lab_results lr
       LEFT JOIN appointments a ON a.id = lr.appointment_id
       WHERE lr.patient_id = $1
         AND lr.test_date >= NOW() - INTERVAL '5 years'
       ORDER BY test_date DESC, lr.created_at DESC`,
      [pid],
    ),
    pool.query(`SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC LIMIT 100`, [
      pid,
    ]),
    pool.query(
      `SELECT * FROM patient_vitals_log
        WHERE patient_id=$1
        ORDER BY recorded_date DESC, created_at DESC NULLS LAST, id DESC
        LIMIT 500`,
      [pid],
    ),
    pool.query(
      `SELECT appointment_date, biomarkers FROM appointments
        WHERE patient_id = $1 AND biomarkers IS NOT NULL
          AND appointment_date IS NOT NULL
        ORDER BY appointment_date DESC, created_at DESC`,
      [pid],
    ),
  ]);

  const labHistory = {};
  const labLatest = {};
  const _latestRaw = {};
  for (const r of labsR.rows) {
    const key = r.canonical_name || getCanonical(r.test_name) || r.test_name;
    if (!labHistory[key]) labHistory[key] = [];
    labHistory[key].push({
      result: r.result,
      result_text: r.result_text,
      unit: r.unit,
      flag: r.flag,
      date: r.test_date,
      ref_range: r.ref_range,
      panel_name: r.panel_name,
    });
    const rawDate = r.lab_test_date || r.test_date;
    const prevRaw = _latestRaw[key];
    if (
      !labLatest[key] ||
      rawDate > prevRaw ||
      (rawDate === prevRaw && r.created_at > labLatest[key]._ca)
    ) {
      labLatest[key] = {
        test_name: r.test_name,
        result: r.result,
        result_text: r.result_text,
        unit: r.unit,
        flag: r.flag,
        date: r.test_date,
        ref_range: r.ref_range,
        is_critical: r.is_critical,
        source: r.source,
        panel_name: r.panel_name,
        _ca: r.created_at,
      };
      _latestRaw[key] = rawDate;
    }
  }
  for (const v of Object.values(labLatest)) delete v._ca;

  // Seed labLatest + labHistory from appointments.biomarkers across all
  // appointments. lab_results stays authoritative when a row already covers
  // that canonical+date.
  //
  // HealthRay copies the last-known biomarker value forward into every
  // subsequent appointment's clinical note. Without de-duplication this
  // creates phantom trend points (e.g. hba1c=9.5 appears on 4 consecutive
  // appts → 4 fake readings). Strategy:
  //   - Sort appts oldest → newest so the earliest appearance of a value
  //     wins.
  //   - When `_lab_dates[bioKey]` is set, trust it (HealthRay tagged a real
  //     lab draw date).
  //   - When `_lab_dates[bioKey]` is missing, treat the value as a
  //     carry-forward: keep only its first appearance, dated to that
  //     appointment.
  const dayOf = (d) => (d ? String(d).slice(0, 10) : null);
  const sortedBios = [...bioR.rows].sort((a, b) =>
    String(a.appointment_date || "").localeCompare(String(b.appointment_date || "")),
  );
  const firstSeenCarry = new Map(); // `${canonical}|${value}` → already-seeded
  for (const row of sortedBios) {
    const bio = row.biomarkers || {};
    const bioLabDates = bio._lab_dates || {};
    for (const [bioKey, meta] of Object.entries(LAB_MAP)) {
      const raw = bio[bioKey];
      if (raw == null) continue;
      const v = parseFloat(raw);
      if (!isFinite(v)) continue;
      const canonical = meta.canonical;
      const labDate = bioLabDates[bioKey];
      let date;
      if (labDate) {
        date = labDate;
      } else {
        const dedupKey = `${canonical}|${v}`;
        if (firstSeenCarry.has(dedupKey)) continue;
        firstSeenCarry.set(dedupKey, true);
        date = row.appointment_date;
      }
      const dayKey = dayOf(date);
      if (!labHistory[canonical]) labHistory[canonical] = [];
      const dup = labHistory[canonical].some((h) => dayOf(h.date) === dayKey);
      if (!dup) {
        labHistory[canonical].push({
          result: v,
          result_text: null,
          unit: meta.unit || null,
          flag: null,
          date,
          ref_range: null,
          panel_name: meta.panel || null,
        });
      }
      if (!labLatest[canonical]) {
        labLatest[canonical] = {
          test_name: meta.test_name,
          result: v,
          result_text: null,
          unit: meta.unit || null,
          flag: null,
          date,
          ref_range: null,
          is_critical: false,
          source: "biomarkers",
          panel_name: meta.panel || null,
        };
      }
    }
  }
  for (const arr of Object.values(labHistory)) {
    arr.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  }

  // Merge app-logged vitals (patient_vitals_log) into the doctor-side vitals
  // array so summary consumers see both streams in one chronological list.
  const appVitals = (vitalsLogR.rows || []).map((r) => {
    const recordedAt =
      r.created_at || (r.recorded_date ? new Date(r.recorded_date).toISOString() : null);
    return {
      id: `app:${r.id}`,
      patient_id: r.patient_id,
      consultation_id: null,
      recorded_at: recordedAt,
      bp_sys: r.bp_systolic != null ? String(r.bp_systolic) : null,
      bp_dia: r.bp_diastolic != null ? String(r.bp_diastolic) : null,
      pulse: r.pulse != null ? String(r.pulse) : null,
      temp: null,
      spo2: r.spo2 != null ? String(r.spo2) : null,
      weight: r.weight_kg != null ? String(r.weight_kg) : null,
      height: null,
      bmi: r.bmi != null ? String(r.bmi) : null,
      rbs: r.rbs != null ? String(r.rbs) : null,
      waist: r.waist != null ? String(r.waist) : null,
      body_fat: r.body_fat != null ? String(r.body_fat) : null,
      muscle_mass: r.muscle_mass != null ? String(r.muscle_mass) : null,
      notes: null,
      appointment_id: null,
      bp_standing_sys: null,
      bp_standing_dia: null,
      source: "patient_app",
      meal_type: r.meal_type || null,
      reading_time: r.reading_time || null,
      recorded_date: r.recorded_date || null,
    };
  });
  const vitals = [...vitalsR.rows, ...appVitals].sort((a, b) => {
    const ta = a.recorded_at ? new Date(a.recorded_at).getTime() : 0;
    const tb = b.recorded_at ? new Date(b.recorded_at).getTime() : 0;
    return tb - ta;
  });

  return { labLatest, labHistory, vitals, rawLabs: labsR.rows };
}
