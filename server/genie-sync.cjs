// genie-sync.js — GiniScribe → MyHealth Genie sync module
// Place in: gini-scribe/server/genie-sync.js
// Requires env vars: GENIE_SUPABASE_URL, GENIE_SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

let genieDb = null;
let giniDb = null;

function getGenieDb() {
  if (genieDb) return genieDb;
  const url = process.env.GENIE_SUPABASE_URL;
  const key = process.env.GENIE_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null; // Graceful: no env vars = no sync
  genieDb = createClient(url, key);
  return genieDb;
}

// Scribe's own Postgres exposed via Supabase (vuukipgdegewpwucdgxa). This
// is where Gini-program patients chat — non-Gini patients chat on the
// main Genie DB (purzqfmfycfowyxfaumc). The scribe inbox aggregates
// conversations from BOTH databases so a single inbox view shows every
// patient's threads regardless of which DB hosts them.
function getGiniDb() {
  if (giniDb) return giniDb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  giniDb = createClient(url, key);
  return giniDb;
}

// Returns all configured chat DBs in stable order, each tagged with a
// `name` so callers can route follow-up operations (getById, send, mark
// read) back to the same DB the conversation came from.
function getChatDbs() {
  const dbs = [];
  const genie = getGenieDb();
  if (genie) dbs.push({ name: 'genie', db: genie });
  const gini = getGiniDb();
  if (gini) dbs.push({ name: 'gini', db: gini });
  return dbs;
}

// Resolve which chat DB a conversation lives in. Conversations returned
// from getConversationById carry `_source` — use that fast-path; otherwise
// probe both DBs.
function dbForConversation(conv) {
  const dbs = getChatDbs();
  if (!dbs.length) return null;
  if (conv?._source) {
    const found = dbs.find((d) => d.name === conv._source);
    if (found) return found.db;
  }
  return getGenieDb();
}

// ─── Retry helpers ────────────────────────────────────────────────────────────
// Transient failures (network hiccups, rate limits, 5xx) should be retried with
// exponential backoff. Fatal errors (bad input, unknown RPC, auth) should not.
const TRANSIENT_PG_CODES = new Set([
  '08000', '08003', '08006', '08001', '08004', // connection errors
  '57P01', '57P02', '57P03', // admin shutdown / crash
  '53300', '53400', // too many connections
  '40001', '40P01', // serialization / deadlock
]);
const TRANSIENT_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_MSG_RE = /(fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout)/i;

function isTransientError(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_PG_CODES.has(err.code)) return true;
  if (err.status && TRANSIENT_HTTP_STATUS.has(err.status)) return true;
  if (err.statusCode && TRANSIENT_HTTP_STATUS.has(err.statusCode)) return true;
  const msg = err.message || String(err);
  if (TRANSIENT_MSG_RE.test(msg)) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` with exponential backoff retry on transient errors.
 * fn may return a Supabase-style `{ data, error }` OR throw; both are handled.
 * Returns whatever fn returns on the last attempt.
 */
async function withRetry(fn, { label = 'op', attempts = 3, baseMs = 400 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      // Supabase style: { data, error } — treat transient error field as retryable
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        if (i < attempts - 1 && isTransientError(result.error)) {
          const delay = baseMs * Math.pow(3, i);
          console.warn(`[Genie Sync][retry] ${label} attempt ${i + 1} failed (${result.error.message || result.error.code || 'transient'}), retrying in ${delay}ms`);
          await sleep(delay);
          lastErr = result.error;
          continue;
        }
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && isTransientError(err)) {
        const delay = baseMs * Math.pow(3, i);
        console.warn(`[Genie Sync][retry] ${label} attempt ${i + 1} threw (${err.message}), retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  // exhausted retries on a { error } result
  return { data: null, error: lastErr };
}

// Derive a clock time (HH:MM, 24h) from the AI-extracted free-text `timing`
// (e.g. "before breakfast", "at bedtime", "8 AM", "after dinner") so the
// patient app can render an exact "8 AM" chip, sort meds within their
// time-of-day bucket, and drive the "due in Xh" countdown + reminder default.
// Returns null if the timing text is missing or unrecognised — the app then
// falls back to its bucket-from-timing-text logic and a generic chip.
function deriveScheduledTime(timing, frequency) {
  if (!timing) return null;
  const t = String(timing).toLowerCase().trim();

  // 1. Explicit clock time inside the timing text: "8am", "8 AM", "08:00", "20:30".
  const ampm = t.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = ampm[2] ? parseInt(ampm[2], 10) : 0;
    const isPm = /^p/.test(ampm[3]);
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const hhmm = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (hhmm) return `${String(parseInt(hhmm[1], 10)).padStart(2, '0')}:${hhmm[2]}`;

  // 2. Meal/period anchors. "before" shifts ~30min earlier than the meal,
  //    "after" ~30min later. These are conservative defaults that match
  //    typical Indian meal patterns; the patient can edit reminder times.
  const before = /\bbefore\b/.test(t);
  const after  = /\bafter\b/.test(t);
  const adjust = (h, m) => {
    if (before) m -= 30;
    else if (after) m += 30;
    if (m < 0) { h -= 1; m += 60; }
    if (m >= 60) { h += 1; m -= 60; }
    h = (h + 24) % 24;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };
  if (/breakfast/.test(t))                       return adjust(8, 0);
  if (/lunch/.test(t))                           return adjust(13, 0);
  if (/dinner|supper/.test(t))                   return adjust(20, 0);
  if (/bedtime|at bed|before bed|h\.?s\.?\b/.test(t)) return '22:00';
  if (/morning|am\b/.test(t))                    return '08:00';
  if (/noon|afternoon/.test(t))                  return '13:00';
  if (/evening/.test(t))                         return '18:00';
  if (/night/.test(t))                           return '21:00';
  if (/empty\s*stomach|fasting/.test(t))         return '07:00';

  // 3. Frequency-only fallback — used when timing is empty but frequency is
  //    e.g. "OD" / "Once daily". Picks a sensible morning default for OD;
  //    leaves multi-dose schedules null (the app shows them under "Anytime"
  //    rather than a misleading single time).
  if (!t && frequency) {
    const f = String(frequency).toLowerCase();
    if (/\bod\b|once\s*daily|once a day/.test(f)) return '08:00';
    if (/\bhs\b|at night|bedtime/.test(f))         return '22:00';
  }
  return null;
}

/**
 * Sync a full visit from GiniScribe to MyHealth Genie
 * Call this after every prescription save in Scribe
 * 
 * @param {object} visit - The full visit/prescription data from Scribe
 * @param {object} patient - The patient record from Scribe
 * @param {object} doctor - The doctor who wrote the prescription
 */
async function syncVisitToGenie(visit, patient, doctor) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };

  const giniPatientId = String(patient.id || patient.patient_id);
  const errors = [];

  // Call an RPC with retry + per-call try/catch. A single failing RPC must never
  // abort the rest of the sync — push to errors[] and continue.
  const callRpc = async (name, params, meta = {}) => {
    try {
      const result = await withRetry(() => db.rpc(name, params), { label: name });
      if (result?.error) {
        errors.push({ step: meta.step || name, ...meta.extra, error: result.error.message || String(result.error) });
        return { data: null, error: result.error };
      }
      return result;
    } catch (err) {
      errors.push({ step: meta.step || name, ...meta.extra, error: err.message || String(err) });
      return { data: null, error: err };
    }
  };

  try {
    // 1. Link/update patient profile
    const { data: mhgId } = await callRpc('gini_link_patient', {
      p_gini_id: giniPatientId,
      p_name: patient.name || patient.patient_name,
      p_phone: patient.phone ?? patient.mobile ?? null,
      p_dob: patient.dob || patient.date_of_birth || null,
      p_sex: patient.sex || patient.gender || null,
      p_blood_group: patient.blood_group || null,
      p_uhid: patient.uhid || patient.file_no || null,
    }, { step: 'link_patient' });

    // 2. Sync care team (hospital + doctor + MO)
    const careTeam = [
      { role: 'hospital', name: 'Gini Advanced Care Hospital', phone: process.env.HOSPITAL_PHONE || null, speciality: null, org: 'Gini Advanced Care Hospital', primary: true, sourceId: 'gini-hospital' },
      { role: 'doctor', name: doctor?.name || doctor?.con_name || visit.doctor_name || visit.con_name, phone: doctor?.phone || null, speciality: doctor?.speciality || visit.speciality || null, org: 'Gini Advanced Care Hospital', primary: true, sourceId: `gini-doc-${doctor?.id || 'primary'}` },
    ];
    if (visit.mo_name || patient.coordinator) {
      careTeam.push({ role: 'coordinator', name: visit.mo_name || patient.coordinator, phone: visit.mo_phone || null, speciality: 'Medical Officer', org: 'Gini Advanced Care Hospital', primary: false, sourceId: `gini-mo-${visit.mo_id || 'primary'}` });
    }
    for (const ct of careTeam) {
      await callRpc('gini_sync_care_team', {
        p_gini_patient_id: giniPatientId, p_source_id: ct.sourceId, p_role: ct.role,
        p_name: ct.name, p_phone: ct.phone, p_speciality: ct.speciality,
        p_organization: ct.org, p_is_primary: ct.primary,
      }, { step: 'care_team', extra: { name: ct.name } });
    }

    // 3. Sync medications — flow the rich Scribe fields the v9 patient app
    //    consumes (icon picker, brand pill, "due in Xh" chip, trend timeline).
    const meds = visit.medications || visit.medicines || visit.prescription || [];
    for (let i = 0; i < meds.length; i++) {
      const med = meds[i];
      await callRpc('gini_sync_medication', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `${visit.id || visit.visit_id || visit.consultation_id}-med-${i}`,
        p_name: med.name || med.medicine_name || med.drug_name,
        p_dose: med.dose || med.dosage || null,
        p_frequency: med.frequency || null,
        p_timing: med.timing || med.schedule || null,
        p_duration: med.duration || null,
        p_instructions: med.instructions || med.notes || null,
        p_is_active: med.is_active !== false,
        p_type: med.drug_class || med.med_group || med.route || null,
        p_brand: med.pharmacy_match || med.brand || null,
        p_scheduled_time: med.scheduled_time || deriveScheduledTime(med.timing || med.schedule, med.frequency),
        p_start_date: med.started_date || med.start_date || visit.visit_date || null,
        p_expiry_date: med.expiry_date || null,
        p_for_conditions: med.for_diagnosis || med.for_conditions || null,
        // Meds attached to a fresh visit payload are by definition the latest
        // prescription — bucket them as 'current' unless scribe already
        // stamped a value (e.g. older rows being replayed).
        p_visit_status: med.visit_status || 'current',
        p_days_of_week: Array.isArray(med.days_of_week) && med.days_of_week.length ? med.days_of_week : null,
      }, { step: 'medication', extra: { name: med.name } });
    }

    // 4. Sync lab results — include lab_name (panel/provider) so the v9
    //    trend modal can show "Latest · 24 Apr 2026 / Lal Path Labs".
    const labs = visit.lab_results || visit.labs || visit.investigations || [];
    for (let i = 0; i < labs.length; i++) {
      const lab = labs[i];
      await callRpc('gini_sync_lab', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `${visit.id || visit.visit_id || visit.consultation_id}-lab-${i}`,
        p_test_name: lab.test_name || lab.name || lab.test,
        p_value: parseFloat(lab.value) || 0,
        p_unit: lab.unit || null,
        p_reference_range: lab.reference_range || lab.normal_range || lab.ref_range || lab.ref || null,
        p_status: lab.status || lab.flag || (lab.is_abnormal ? 'abnormal' : 'normal'),
        p_test_date: lab.test_date || visit.visit_date || new Date().toISOString().split('T')[0],
        p_lab_name: lab.lab_name || lab.panel_name || lab.lab || null,
      }, { step: 'lab', extra: { name: lab.test_name } });
    }

    // 5. Sync diagnoses/conditions
    const diagnoses = visit.diagnoses || visit.conditions || visit.diagnosis_list || visit.mo_data?.diagnoses || [];
    for (let i = 0; i < diagnoses.length; i++) {
      const dx = diagnoses[i];
      const dxName = typeof dx === 'string' ? dx : (dx.name || dx.diagnosis || dx.label);
      await callRpc('gini_sync_condition', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `gini-dx-${dxName?.toLowerCase().replace(/\s+/g,'-')}`,
        p_name: dxName,
        p_status: dx.status || 'active',
        p_diagnosed_date: dx.diagnosed_date || null,
        p_notes: dx.notes || null,
      }, { step: 'condition', extra: { name: dxName } });
    }

    // 6. Sync goals if present
    const goals = visit.goals || visit.targets || [];
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      await callRpc('gini_sync_goal', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `gini-goal-${(g.biomarker || g.marker)?.toLowerCase().replace(/\s+/g,'-') || i}`,
        p_biomarker: g.biomarker || g.test_name || g.marker,
        p_current_value: String(g.current_value || g.current),
        p_target_value: String(g.target_value || g.target),
        p_target_date: g.target_date || null,
        p_status: 'active',
      }, { step: 'goal', extra: { name: g.biomarker || g.marker } });
    }

    // 7. Sync appointment (next follow-up). Pass time + purpose so the v9
    //    pre-visit hero can render "Friday, 1 May · 11:30 AM" and the Care
    //    tab can label the visit with its purpose.
    if (visit.follow_up_date || visit.next_appointment) {
      await callRpc('gini_sync_appointment', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `gini-appt-${visit.id || visit.visit_id || visit.consultation_id}`,
        p_appointment_date: visit.follow_up_date || visit.next_appointment,
        p_doctor_name: doctor?.name || doctor?.con_name || visit.doctor_name || visit.con_name || null,
        p_notes: visit.follow_up_instructions || null,
        p_status: 'scheduled',
        p_appointment_time: visit.follow_up_time || visit.next_appointment_time || visit.time_slot || null,
        p_purpose: visit.follow_up_purpose || visit.visit_type || visit.purpose || null,
      }, { step: 'appointment' });
    }

    // 8. Add timeline event
    await callRpc('gini_sync_timeline', {
      p_gini_patient_id: giniPatientId,
      p_source_id: `gini-visit-${visit.id || visit.visit_id || visit.consultation_id}`,
      p_title: `Visit: ${doctor?.name || doctor?.con_name || visit.doctor_name || visit.con_name || 'Gini Hospital'} — ${meds.length} medications`,
      p_event_date: visit.visit_date || new Date().toISOString().split('T')[0],
      p_icon: '\u{1F3E5}',
    }, { step: 'timeline' });

    // 9. Sync doctor-recorded vitals
    if (visit.vitals) {
      const v = visit.vitals;
      await callRpc('gini_sync_vitals', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `gini-vitals-${visit.id || visit.visit_id || visit.consultation_id}`,
        p_recorded_at: visit.visit_date || new Date().toISOString(),
        p_bp_sys: parseFloat(v.bp_sys) || null,
        p_bp_dia: parseFloat(v.bp_dia) || null,
        p_pulse: parseFloat(v.pulse) || null,
        p_spo2: parseFloat(v.spo2) || null,
        p_weight: parseFloat(v.weight) || null,
        p_height: parseFloat(v.height) || null,
        p_temp: parseFloat(v.temp) || null,
        p_rbs: parseFloat(v.rbs) || null,
        p_meal_type: v.meal_type || null,
        p_source: 'doctor',
      }, { step: 'vitals' });
    }

    console.log(`[Genie Sync] Patient ${giniPatientId}: ${meds.length} meds, ${labs.length} labs, ${diagnoses.length} conditions. Errors: ${errors.length}`);

    return { synced: true, errors, mhgPatientId: mhgId };

  } catch (e) {
    console.error('[Genie Sync] Fatal:', e.message);
    return { synced: false, reason: e.message, errors };
  }
}

/**
 * Sync just the patient profile (no visit data) from GiniScribe to MyHealth Genie.
 * Called when a patient row is created in Scribe outside of a visit flow —
 * ensures the mobile app finds an existing `program_type='gini_patient'` row
 * when the user signs in by phone.
 */
async function syncPatientToGenie(patient) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };
  if (!patient || patient.id == null) {
    return { synced: false, reason: 'Missing patient.id' };
  }

  const giniId = String(patient.id);
  try {
    const result = await withRetry(
      () =>
        db.rpc('gini_link_patient', {
          p_gini_id: giniId,
          p_name: patient.name || patient.patient_name || 'Patient',
          p_phone: patient.phone ?? patient.mobile ?? null,
          p_dob: patient.dob || patient.date_of_birth || null,
          p_sex: patient.sex || patient.gender || null,
          p_blood_group: patient.blood_group || null,
          p_uhid: patient.uhid || patient.file_no || null,
        }),
      { label: `syncPatient(${giniId})` },
    );
    if (result?.error) {
      console.error('[Genie Sync Patient] Error:', result.error.message || result.error);
      return { synced: false, reason: result.error.message || String(result.error) };
    }
    return { synced: true, mhgPatientId: result?.data || null };
  } catch (err) {
    console.error('[Genie Sync Patient] Exception:', err.message || err);
    return { synced: false, reason: err.message || String(err) };
  }
}

/**
 * Push all active scribe diagnoses for a patient to Genie's `conditions` table.
 *
 * syncVisitToGenie only pushes diagnoses that are attached to the `visit`
 * payload it's given — i.e. on consultation save. Diagnoses added/edited via
 * the standalone AddDiagnosis / UpdateDiagnosis mutations never flowed to
 * Genie, which is why the patient app's Conditions section would stay empty
 * until the doctor saved a full consultation. This helper closes that gap:
 * it reads the canonical diagnoses list from Postgres and replays the same
 * `gini_sync_condition` RPC that syncVisitToGenie uses, so Genie converges.
 *
 * Safe to call fire-and-forget; every RPC has its own try/catch so one failed
 * condition can't abort the rest.
 */
async function syncDiagnosesToGenie(scribePatientId, localDb) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };
  if (!scribePatientId) return { synced: false, reason: 'Missing patient id' };

  const giniPatientId = String(scribePatientId);
  const errors = [];
  let pushed = 0;

  try {
    const { rows } = await localDb.query(
      `SELECT DISTINCT ON (diagnosis_id)
         diagnosis_id, label, status, since_year, notes, is_active, updated_at
       FROM diagnoses
       WHERE patient_id = $1 AND is_active IS NOT FALSE
       ORDER BY diagnosis_id, updated_at DESC`,
      [scribePatientId],
    );

    for (const dx of rows) {
      const dxName = dx.label || dx.diagnosis_id;
      if (!dxName) continue;
      // Genie's gini_sync_condition RPC accepts a full date; expand the
      // scribe-side since_year to a Jan-1 date so the year doesn't get lost.
      let diagDate = null;
      if (dx.since_year) {
        const yr = String(dx.since_year);
        diagDate = /^\d{4}$/.test(yr) ? `${yr}-01-01` : yr;
      }
      try {
        const result = await withRetry(
          () =>
            db.rpc('gini_sync_condition', {
              p_gini_patient_id: giniPatientId,
              p_source_id: `gini-dx-${String(dxName).toLowerCase().replace(/\s+/g, '-')}`,
              p_name: dxName,
              p_status: dx.status || 'active',
              p_diagnosed_date: diagDate,
              p_notes: dx.notes || null,
            }),
          { label: `gini_sync_condition(${dxName})` },
        );
        if (result?.error) {
          errors.push({ name: dxName, error: result.error.message || String(result.error) });
        } else {
          pushed += 1;
        }
      } catch (err) {
        errors.push({ name: dxName, error: err.message || String(err) });
      }
    }

    return { synced: true, pushed, total: rows.length, errors };
  } catch (err) {
    console.error('[Genie Sync Diagnoses] Exception:', err.message || err);
    return { synced: false, reason: err.message || String(err), errors };
  }
}

/**
 * Mirror of `syncDiagnosesToGenie` for the `medications` table. `syncVisitToGenie`
 * only pushes meds attached to a full consultation payload, so standalone
 * add/edit/stop on the /visit page never reached Genie. Reads the canonical
 * medications list from Postgres and replays `gini_sync_medication` per row.
 * Includes inactive rows so a stop flips `is_active=false` on the Genie side.
 */
async function syncMedicationsToGenie(scribePatientId, localDb) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };
  if (!scribePatientId) return { synced: false, reason: 'Missing patient id' };

  const giniPatientId = String(scribePatientId);
  const errors = [];
  let pushed = 0;

  try {
    const { rows } = await localDb.query(
      `SELECT id, name, dose, frequency, timing, clinical_note, notes, is_active,
              drug_class, med_group, route, pharmacy_match, started_date,
              for_diagnosis, visit_status, days_of_week, common_side_effects
         FROM medications
        WHERE patient_id = $1
        ORDER BY updated_at DESC
        LIMIT 500`,
      [scribePatientId],
    );

    for (const med of rows) {
      if (!med.name) continue;
      try {
        const result = await withRetry(
          () =>
            db.rpc('gini_sync_medication', {
              p_gini_patient_id: giniPatientId,
              p_source_id: `gini-med-${med.id}`,
              p_name: med.name,
              p_dose: med.dose || null,
              p_frequency: med.frequency || null,
              p_timing: med.timing || null,
              p_duration: null,
              p_instructions: med.clinical_note || med.notes || null,
              p_is_active: med.is_active !== false,
              p_type: med.drug_class || med.med_group || med.route || null,
              p_brand: med.pharmacy_match || null,
              p_scheduled_time: deriveScheduledTime(med.timing, med.frequency),
              p_start_date: med.started_date || null,
              p_expiry_date: null,
              p_for_conditions: med.for_diagnosis || null,
              p_visit_status: med.visit_status || null,
              p_days_of_week: med.days_of_week || null,
              p_common_side_effects: Array.isArray(med.common_side_effects)
                ? med.common_side_effects
                : med.common_side_effects || null,
            }),
          { label: `gini_sync_medication(${med.name})` },
        );
        if (result?.error) {
          errors.push({ name: med.name, error: result.error.message || String(result.error) });
        } else {
          pushed += 1;
        }
      } catch (err) {
        errors.push({ name: med.name, error: err.message || String(err) });
      }
    }

    return { synced: true, pushed, total: rows.length, errors };
  } catch (err) {
    console.error('[Genie Sync Medications] Exception:', err.message || err);
    return { synced: false, reason: err.message || String(err), errors };
  }
}

/**
 * Delete a patient-added medication from Genie. `genieMedId` is the UUID
 * stored in `patient_medications_genie.genie_id` — i.e. the Supabase
 * `medications.id` that the patient created in the Genie app. Removes the
 * row both on Genie (so it disappears from the app) and from the scribe
 * mirror table. Idempotent: missing rows are treated as success.
 */
async function deleteGenieMedication(scribePatientId, genieMedId, localDb) {
  if (!genieMedId) return { deleted: false, reason: 'Missing genie medication id' };
  const db = getGenieDb();

  let mirrorDeleted = 0;
  if (localDb && scribePatientId) {
    try {
      const r = await localDb.query(
        `DELETE FROM patient_medications_genie
          WHERE patient_id = $1 AND (genie_id = $2 OR id::text = $2)
          RETURNING id`,
        [scribePatientId, String(genieMedId)],
      );
      mirrorDeleted = r.rows.length;
    } catch (err) {
      console.warn('[Genie Delete Med] Mirror delete failed:', err.message || err);
    }
  }

  if (!db) {
    return { deleted: mirrorDeleted > 0, mirrorDeleted, reason: 'No Genie credentials' };
  }

  try {
    const { data, error } = await db
      .from('medications')
      .delete()
      .eq('id', genieMedId)
      .select('id');
    if (error) {
      console.error('[Genie Delete Med] Error:', error.message);
      return { deleted: mirrorDeleted > 0, mirrorDeleted, reason: error.message };
    }
    return { deleted: true, mirrorDeleted, genieDeleted: data?.length || 0 };
  } catch (err) {
    console.error('[Genie Delete Med] Exception:', err.message || err);
    return { deleted: mirrorDeleted > 0, mirrorDeleted, reason: err.message || String(err) };
  }
}

/**
 * Update a patient-added medication in Genie. `genieMedId` is the UUID
 * stored in `patient_medications_genie.genie_id`. Updates the scribe mirror
 * row first, then pushes the same fields to the Genie Supabase `medications`
 * row so the change reflects in the patient app. `fields` is a partial of
 * { dose, frequency, timing, instructions, is_active }.
 */
async function updateGenieMedication(scribePatientId, genieMedId, fields, localDb) {
  if (!genieMedId) return { updated: false, reason: 'Missing genie medication id' };
  const allowed = ['dose', 'frequency', 'timing', 'instructions', 'is_active'];
  const payload = {};
  for (const k of allowed) {
    if (fields && fields[k] !== undefined) payload[k] = fields[k];
  }
  if (Object.keys(payload).length === 0) {
    return { updated: false, reason: 'No updatable fields' };
  }

  let mirrorUpdated = 0;
  if (localDb && scribePatientId) {
    try {
      const sets = [];
      const vals = [];
      let i = 1;
      for (const [k, v] of Object.entries(payload)) {
        sets.push(`${k} = $${i++}`);
        vals.push(v);
      }
      vals.push(scribePatientId, String(genieMedId));
      const r = await localDb.query(
        `UPDATE patient_medications_genie
            SET ${sets.join(', ')}, synced_at = NOW()
          WHERE patient_id = $${i++} AND (genie_id = $${i} OR id::text = $${i})
          RETURNING id`,
        vals,
      );
      mirrorUpdated = r.rows.length;
    } catch (err) {
      console.warn('[Genie Update Med] Mirror update failed:', err.message || err);
    }
  }

  const db = getGenieDb();
  if (!db) {
    return { updated: mirrorUpdated > 0, mirrorUpdated, reason: 'No Genie credentials' };
  }

  try {
    const { data, error } = await db
      .from('medications')
      .update(payload)
      .eq('id', genieMedId)
      .select('id');
    if (error) {
      console.error('[Genie Update Med] Error:', error.message);
      return { updated: mirrorUpdated > 0, mirrorUpdated, reason: error.message };
    }
    return { updated: true, mirrorUpdated, genieUpdated: data?.length || 0 };
  } catch (err) {
    console.error('[Genie Update Med] Exception:', err.message || err);
    return { updated: mirrorUpdated > 0, mirrorUpdated, reason: err.message || String(err) };
  }
}

/**
 * Mirror of `syncDiagnosesToGenie` for the `lab_results` table. Standalone lab
 * adds (POST /visit/:patientId/lab) bypass `syncVisitToGenie`. Skips rows with
 * non-numeric results since `gini_sync_lab.p_value` is NUMERIC NOT NULL.
 */
async function syncLabsToGenie(scribePatientId, localDb) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };
  if (!scribePatientId) return { synced: false, reason: 'Missing patient id' };

  const giniPatientId = String(scribePatientId);
  const errors = [];
  let pushed = 0;

  try {
    // Skip patient-origin rows (genie_id IS NOT NULL): those already exist
    // in Genie. Pushing them via gini_sync_lab would create duplicates
    // because the RPC's EXISTS check is keyed on source_id, which is NULL
    // for patient-app rows. Edits to these rows go through
    // updateGenieLabByGenieId in routes/visit.js.
    const { rows } = await localDb.query(
      `SELECT id, test_name, result, unit, test_date, ref_range, flag, panel_name
         FROM lab_results
        WHERE patient_id = $1
          AND result IS NOT NULL
          AND genie_id IS NULL
        ORDER BY test_date DESC NULLS LAST, id DESC
        LIMIT 500`,
      [scribePatientId],
    );

    for (const lab of rows) {
      if (!lab.test_name) continue;
      const value = parseFloat(lab.result);
      if (!Number.isFinite(value)) continue;
      try {
        const result = await withRetry(
          () =>
            db.rpc('gini_sync_lab', {
              p_gini_patient_id: giniPatientId,
              p_source_id: `gini-lab-${lab.id}`,
              p_test_name: lab.test_name,
              p_value: value,
              p_unit: lab.unit || null,
              p_reference_range: lab.ref_range || null,
              p_status: lab.flag || 'normal',
              p_test_date: lab.test_date || new Date().toISOString().split('T')[0],
              p_lab_name: lab.panel_name || null,
            }),
          { label: `gini_sync_lab(${lab.test_name})` },
        );
        if (result?.error) {
          errors.push({ name: lab.test_name, error: result.error.message || String(result.error) });
        } else {
          pushed += 1;
        }
      } catch (err) {
        errors.push({ name: lab.test_name, error: err.message || String(err) });
      }
    }

    return { synced: true, pushed, total: rows.length, errors };
  } catch (err) {
    console.error('[Genie Sync Labs] Exception:', err.message || err);
    return { synced: false, reason: err.message || String(err), errors };
  }
}

/**
 * Sign a Supabase storage object so the URL works for the patient app without
 * needing scribe-side auth. Returns null on failure (caller should fall back
 * to the row's existing file_url).
 */
async function signStorageUrl(storagePath, expiresIn = 60 * 60 * 24 * 30) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const bucket = 'patient-files';
  if (!url || !key || !storagePath) return null;
  try {
    const resp = await fetch(
      `${url}/storage/v1/object/sign/${bucket}/${storagePath}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn }),
      },
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const signed = data.signedURL || data.signedUrl || null;
    if (!signed) return null;
    return signed.startsWith('http') ? signed : `${url}/storage/v1${signed}`;
  } catch {
    return null;
  }
}

/**
 * Push uploaded documents (prescription PDFs, lab report PDFs, imaging/scan
 * files) from scribe's `documents` table into Genie's `patient_documents` so
 * the V9 Care → Records tab can list them. Mirrors `syncLabsToGenie`'s
 * upsert-by-source_id pattern; the matching RPC lives in
 * `myhealthgenie/supabase/migrations/2026-04-25_gini_sync_document.sql`.
 */
async function syncDocumentsToGenie(scribePatientId, localDb) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };
  if (!scribePatientId) return { synced: false, reason: 'Missing patient id' };

  const giniPatientId = String(scribePatientId);
  const errors = [];
  let pushed = 0;

  try {
    const { rows } = await localDb.query(
      `SELECT id, doc_type, title, file_name, file_url, storage_path, mime_type,
              extracted_data, extracted_text, doc_date
         FROM documents
        WHERE patient_id = $1
          AND doc_type IN ('prescription','lab_report','imaging','discharge')
        ORDER BY doc_date DESC NULLS LAST, id DESC
        LIMIT 200`,
      [scribePatientId],
    );

    for (const doc of rows) {
      const signed = doc.storage_path ? await signStorageUrl(doc.storage_path) : null;
      const fileUrl = signed || doc.file_url || null;
      // Fold the raw clinical note into the JSONB payload as `raw_text`.
      // The Genie RPC has no dedicated parameter for it, but `extracted_data`
      // is already JSONB so the patient app can read `extracted_data.raw_text`
      // when the user taps the prescription card in the Story screen.
      let extractedPayload = doc.extracted_data || null;
      if (doc.extracted_text) {
        const base = extractedPayload && typeof extractedPayload === 'object'
          ? extractedPayload
          : {};
        extractedPayload = { ...base, raw_text: String(doc.extracted_text) };
      }
      try {
        const result = await withRetry(
          () =>
            db.rpc('gini_sync_document', {
              p_gini_patient_id: giniPatientId,
              p_source_id: `gini-doc-${doc.id}`,
              p_doc_type: doc.doc_type,
              p_title: doc.title || doc.file_name || doc.doc_type,
              p_document_date: doc.doc_date || null,
              p_file_url: fileUrl,
              p_content_type: doc.mime_type || null,
              p_extracted_data: extractedPayload,
            }),
          { label: `gini_sync_document(${doc.id})` },
        );
        if (result?.error) {
          errors.push({ id: doc.id, error: result.error.message || String(result.error) });
        } else {
          pushed += 1;
        }
      } catch (err) {
        errors.push({ id: doc.id, error: err.message || String(err) });
      }
    }

    return { synced: true, pushed, total: rows.length, errors };
  } catch (err) {
    console.error('[Genie Sync Documents] Exception:', err.message || err);
    return { synced: false, reason: err.message || String(err), errors };
  }
}

/**
 * Mirror of `syncDiagnosesToGenie` for follow-up / scheduled appointments.
 * `syncVisitToGenie` only pushes the follow-up date embedded in a freshly-saved
 * consultation, so edits via `PATCH /visit/:patientId/followup` or
 * `PATCH /appointments/:id` never reached Genie and the patient app kept
 * showing the stale appointment date.
 *
 * Reads the most recent/upcoming appointment from scribe and pushes it via
 * `gini_sync_appointment` (upserts by `source_id`).
 */
async function syncAppointmentToGenie(scribePatientId, localDb) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };
  if (!scribePatientId) return { synced: false, reason: 'Missing patient id' };

  const giniPatientId = String(scribePatientId);
  const errors = [];
  let pushed = 0;

  try {
    // Prefer the next scheduled appointment; fall back to most recent.
    const { rows } = await localDb.query(
      `SELECT id, appointment_date, time_slot, doctor_name, status, notes, visit_type
         FROM appointments
        WHERE patient_id = $1
        ORDER BY
          CASE WHEN appointment_date >= CURRENT_DATE THEN 0 ELSE 1 END,
          appointment_date ASC,
          id DESC
        LIMIT 1`,
      [scribePatientId],
    );
    if (!rows[0]) return { synced: true, pushed: 0, total: 0, errors };

    const appt = rows[0];
    try {
      const result = await withRetry(
        () =>
          db.rpc('gini_sync_appointment', {
            p_gini_patient_id: giniPatientId,
            p_source_id: `gini-appt-${appt.id}`,
            p_appointment_date: appt.appointment_date,
            p_doctor_name: appt.doctor_name || null,
            p_notes: appt.notes || null,
            p_status: appt.status || 'scheduled',
            p_appointment_time: appt.time_slot || null,
            p_purpose: appt.visit_type || null,
          }),
        { label: `gini_sync_appointment(${appt.id})` },
      );
      if (result?.error) {
        errors.push({ id: appt.id, error: result.error.message || String(result.error) });
      } else {
        pushed += 1;
      }
    } catch (err) {
      errors.push({ id: appt.id, error: err.message || String(err) });
    }
    return { synced: true, pushed, total: rows.length, errors };
  } catch (err) {
    console.error('[Genie Sync Appointment] Exception:', err.message || err);
    return { synced: false, reason: err.message || String(err), errors };
  }
}

/**
 * Mirror of `syncDiagnosesToGenie` for the patient's primary care team.
 * `syncVisitToGenie` only pushes care team at full consultation save. If the
 * doctor is reassigned on an appointment outside a visit (e.g., via
 * `PATCH /appointments/:id` with a new `doctor_name`), Genie keeps showing the
 * old doctor. This helper reads the current assignment from the latest
 * appointment and replays `gini_sync_care_team` so the `patients.doctor_name`
 * column on Genie converges (see gini_sync_care_team SQL definition).
 */
async function syncCareTeamToGenie(scribePatientId, localDb) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };
  if (!scribePatientId) return { synced: false, reason: 'Missing patient id' };

  const giniPatientId = String(scribePatientId);
  const errors = [];
  let pushed = 0;

  try {
    const { rows } = await localDb.query(
      `SELECT doctor_name
         FROM appointments
        WHERE patient_id = $1 AND doctor_name IS NOT NULL
        ORDER BY appointment_date DESC NULLS LAST, id DESC
        LIMIT 1`,
      [scribePatientId],
    );
    const doctorName = rows[0]?.doctor_name;
    if (!doctorName) return { synced: true, pushed: 0, total: 0, errors };

    try {
      const result = await withRetry(
        () =>
          db.rpc('gini_sync_care_team', {
            p_gini_patient_id: giniPatientId,
            p_source_id: 'gini-doc-primary',
            p_role: 'doctor',
            p_name: doctorName,
            p_phone: null,
            p_speciality: null,
            p_organization: 'Gini Advanced Care Hospital',
            p_is_primary: true,
          }),
        { label: `gini_sync_care_team(${doctorName})` },
      );
      if (result?.error) {
        errors.push({ name: doctorName, error: result.error.message || String(result.error) });
      } else {
        pushed += 1;
      }
    } catch (err) {
      errors.push({ name: doctorName, error: err.message || String(err) });
    }
    return { synced: true, pushed, total: 1, errors };
  } catch (err) {
    console.error('[Genie Sync CareTeam] Exception:', err.message || err);
    return { synced: false, reason: err.message || String(err), errors };
  }
}

/**
 * Push a single scribe `vitals` row to Genie so BP/weight/pulse the doctor
 * types on the /visit page shows up on the patient's phone.
 *
 * syncVisitToGenie only fires on consultation save; standalone vitals edits
 * (POST/PATCH /visit/:patientId/vitals) bypassed that path entirely, which
 * is why the app never saw doctor-entered readings. Idempotent on
 * `gini-vitals-{scribeVitalsId}` so re-saves update the same Genie row.
 */
async function syncVitalsRowToGenie(scribePatientId, vitalsRow) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };
  if (!scribePatientId || !vitalsRow || vitalsRow.id == null) {
    return { synced: false, reason: 'Missing patient id or vitals row' };
  }
  try {
    const result = await withRetry(
      () =>
        db.rpc('gini_sync_vitals', {
          p_gini_patient_id: String(scribePatientId),
          p_source_id: `gini-vitals-${vitalsRow.id}`,
          p_recorded_at: vitalsRow.recorded_at || new Date().toISOString(),
          p_bp_sys: vitalsRow.bp_sys != null ? parseFloat(vitalsRow.bp_sys) : null,
          p_bp_dia: vitalsRow.bp_dia != null ? parseFloat(vitalsRow.bp_dia) : null,
          p_pulse: vitalsRow.pulse != null ? parseFloat(vitalsRow.pulse) : null,
          p_spo2: vitalsRow.spo2 != null ? parseFloat(vitalsRow.spo2) : null,
          p_weight: vitalsRow.weight != null ? parseFloat(vitalsRow.weight) : null,
          p_height: vitalsRow.height != null ? parseFloat(vitalsRow.height) : null,
          p_temp: vitalsRow.temp != null ? parseFloat(vitalsRow.temp) : null,
          p_rbs: vitalsRow.rbs != null ? parseFloat(vitalsRow.rbs) : null,
          p_meal_type: vitalsRow.meal_type || null,
          p_source: 'doctor',
        }),
      { label: `gini_sync_vitals(${vitalsRow.id})` },
    );
    if (result?.error) {
      return { synced: false, reason: result.error.message || String(result.error) };
    }
    return { synced: true };
  } catch (err) {
    console.error('[Genie Sync Vitals Row] Exception:', err.message || err);
    return { synced: false, reason: err.message || String(err) };
  }
}

/**
 * Update a Genie `vitals` row directly by its UUID. Used when the doctor
 * edits a patient-app-logged reading from /visit — the canonical row lives
 * in Genie and patient_vitals_log mirrors it via genie_id, so we update
 * the source of truth on Genie too. Distinct from syncVitalsRowToGenie,
 * which is keyed by scribe vitals.id via the gini_sync_vitals RPC.
 */
async function updateGenieVitalsByGenieId(genieVitalsId, fields) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };
  if (!genieVitalsId) return { synced: false, reason: 'Missing genie_id' };
  const payload = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v !== undefined && v !== null && v !== '') payload[k] = v;
  }
  if (Object.keys(payload).length === 0) return { synced: false, reason: 'No fields to update' };
  try {
    const result = await withRetry(
      () => db.from('vitals').update(payload).eq('id', genieVitalsId),
      { label: `genie_vitals_update(${genieVitalsId})` },
    );
    if (result?.error) {
      return { synced: false, reason: result.error.message || String(result.error) };
    }
    return { synced: true };
  } catch (err) {
    console.error('[Genie Sync Vitals Update] Exception:', err.message || err);
    return { synced: false, reason: err.message || String(err) };
  }
}

/**
 * Update a Genie `lab_results` row directly by its UUID. Used when the
 * doctor edits a lab value on scribe whose canonical row lives on Genie
 * (i.e. originated from the patient app, scribe.lab_results.genie_id is
 * set). The gini_sync_lab RPC is keyed by source_id and would INSERT a
 * fresh Genie row instead of updating in this case, so we bypass it and
 * write straight to the table.
 *
 * Field mapping (scribe → Genie lab_results column):
 *   result    → value
 *   ref_range → reference_range
 *   flag      → status   ('HIGH'→'high', 'LOW'→'low', null→'normal')
 * Other fields (test_name, test_date, unit, lab_name) are passed through.
 */
async function updateGenieLabByGenieId(genieLabId, fields) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: 'No Genie credentials' };
  if (!genieLabId) return { synced: false, reason: 'Missing genie_id' };
  const payload = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v !== undefined && v !== null && v !== '') payload[k] = v;
  }
  if (Object.keys(payload).length === 0) return { synced: false, reason: 'No fields to update' };
  try {
    const result = await withRetry(
      () => db.from('lab_results').update(payload).eq('id', genieLabId),
      { label: `genie_lab_update(${genieLabId})` },
    );
    if (result?.error) {
      return { synced: false, reason: result.error.message || String(result.error) };
    }
    return { synced: true };
  } catch (err) {
    console.error('[Genie Sync Lab Update] Exception:', err.message || err);
    return { synced: false, reason: err.message || String(err) };
  }
}

/**
 * Delete a patient row from MyHealth Genie by gini_patient_id.
 * Used by the test-patient cleanup script. Best-effort: if a FK cascade is
 * missing on the Genie side, we log and continue — test data leftovers are
 * acceptable.
 */
async function deletePatientFromGenie(giniPatientId) {
  const db = getGenieDb();
  if (!db) return { deleted: false, reason: 'No Genie credentials' };
  if (giniPatientId == null) return { deleted: false, reason: 'Missing gini_patient_id' };

  const giniId = String(giniPatientId);
  try {
    const { data, error } = await db
      .from('patients')
      .delete()
      .eq('gini_patient_id', giniId)
      .select('id');
    if (error) {
      console.error('[Genie Delete Patient] Error:', error.message);
      return { deleted: false, reason: error.message };
    }
    return { deleted: (data?.length || 0) > 0, count: data?.length || 0 };
  } catch (err) {
    console.error('[Genie Delete Patient] Exception:', err.message || err);
    return { deleted: false, reason: err.message || String(err) };
  }
}

/**
 * Send an alert from Scribe to patient's Genie app
 */
async function sendAlertToGenie(giniPatientId, alertType, title, message, data = null) {
  const db = getGenieDb();
  if (!db) return null;
  const { data: alertId, error } = await db.rpc('gini_send_alert', {
    p_gini_patient_id: String(giniPatientId),
    p_direction: 'scribe_to_genie',
    p_alert_type: alertType,
    p_title: title,
    p_message: message,
    p_data: data,
    p_created_by: 'doctor',
  });
  if (error) console.error('[Genie Alert] Error:', error.message);
  return alertId;
}

/**
 * Get alerts FROM Genie (patient concerns, compliance alerts, etc.)
 */
async function getAlertsFromGenie(giniPatientId = null) {
  const db = getGenieDb();
  if (!db) return [];
  const { data, error } = await db.rpc('gini_get_alerts', {
    p_gini_patient_id: giniPatientId,
    p_direction: 'genie_to_scribe',
    p_status: 'pending',
  });
  if (error) { console.error('[Genie Alerts] Error:', error.message); return []; }
  return data || [];
}

/**
 * Get patient messages FROM Genie (patient → doctor)
 */
async function getMessagesFromGenie(giniPatientId = null, senderRole = null) {
  const db = getGenieDb();
  if (!db) return [];

  let query = db
    .from('patient_messages')
    .select('*')
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
    .limit(200);

  if (giniPatientId) {
    // patient_messages.patient_id is UUID — coerce a scribe int into the
    // genie UUID before filtering, otherwise PostgREST throws 22P02.
    const uuid = await resolveAnyToGenieUuid(giniPatientId);
    if (!uuid) return [];
    query = query.eq('patient_id', uuid);
  }
  if (senderRole === 'doctor') {
    // Doctor inbox: include legacy untagged rows so pre-tagging messages
    // don't vanish from the doctor's view.
    query = query.or('sender_role.eq.doctor,sender_role.is.null');
  } else if (senderRole) {
    // Lab / reception: strict match on sender_role.
    query = query.eq('sender_role', senderRole);
  }

  const { data, error } = await query;
  if (error) { console.error('[Genie Messages] Error:', error.message); return []; }
  return data || [];
}

/**
 * Send doctor reply to patient via Supabase patient_messages
 */
async function sendReplyToGenie(patientId, message, senderName, senderRole) {
  const db = getGenieDb();
  if (!db) return null;

  const uuid = await resolveAnyToGenieUuid(patientId);
  if (!uuid) {
    console.error('[Genie Reply] No genie patient for id:', patientId);
    return null;
  }
  const payload = {
    patient_id: uuid,
    direction: 'inbound',
    message,
    sender_name: senderName || 'Dr. Bhansali',
    is_read: false,
  };
  if (senderRole) payload.sender_role = senderRole;

  const { data, error } = await db
    .from('patient_messages')
    .insert(payload)
    .select()
    .single();

  if (error) { console.error('[Genie Reply] Error:', error.message); return null; }
  return data;
}

/**
 * Get a role-scoped message thread for a patient.
 *
 * Roles split the patient's chat into three separate conversations:
 *   - 'doctor'    — patient ↔ doctor(s). Also includes NULL-role rows for
 *                   back-compat with historical messages sent before the
 *                   role tagging existed.
 *   - 'lab'       — patient ↔ Gini Lab.
 *   - 'reception' — patient ↔ Gini Advanced Care (reception).
 *
 * Per-doctor sub-threads: when role='doctor' and `doctor` (a name) is
 * provided, we further scope inbound (doctor → patient) rows to that
 * doctor's replies only by matching sender_name case-insensitively.
 * Outbound (patient → doctor) rows don't yet carry a target-doctor
 * discriminator in the schema, so they remain shared across doctors of
 * the same patient — good enough in practice because patient messaging
 * in the Genie app currently targets "the doctor" as a single channel.
 *
 * Pass role=null to get the old unfiltered behaviour (still used by
 * admin/debug callers that want everything in one stream).
 */
async function getThreadFromGenie(
  patientId,
  { limit = null, before = null, role = null, doctor = null } = {},
) {
  const db = getGenieDb();
  if (!db) return { data: [], nextCursor: null, hasMore: false };

  // patient_messages.patient_id is UUID. The scribe UI may pass either a
  // scribe int (e.g. "16709") or the genie UUID — normalize once so we
  // never hit Postgres 22P02 "invalid input syntax for type uuid".
  const uuid = await resolveAnyToGenieUuid(patientId);
  if (!uuid) {
    return limit ? { data: [], nextCursor: null, hasMore: false } : [];
  }
  patientId = uuid;

  // Helper: apply role + doctor filters to a Supabase query builder.
  const applyRoleFilters = (q) => {
    if (role === 'doctor') {
      // NULL sender_role rows pre-date the role tagging and were always
      // doctor-addressed, so fold them in.
      q = q.or('sender_role.eq.doctor,sender_role.is.null');
      if (doctor) {
        // Scope inbound replies to this specific doctor by name match.
        // Outbound rows (direction='outbound') stay visible regardless.
        // Strip characters that would break PostgREST's .or() syntax or
        // inject extra wildcards: %, _, ',', '(', ')'. What remains is a
        // safe ILIKE pattern for a name.
        const safeDoctor = String(doctor).replace(/[%_,()]/g, '').trim();
        if (safeDoctor) {
          q = q.or(
            `direction.eq.outbound,and(direction.eq.inbound,sender_name.ilike.%${safeDoctor}%)`,
          );
        }
      }
    } else if (role === 'lab' || role === 'reception') {
      q = q.eq('sender_role', role);
    }
    return q;
  };

  // Without a limit we keep the legacy behaviour: full thread ascending.
  if (!limit) {
    let q = db
      .from('patient_messages')
      .select('*')
      .eq('patient_id', String(patientId))
      .order('created_at', { ascending: true });
    q = applyRoleFilters(q);

    const { data, error } = await q;
    if (error) { console.error('[Genie Thread] Error:', error.message); return []; }
    return data || [];
  }

  // Paginated: fetch newest-first, cap at limit+1 to detect hasMore, cursor on created_at.
  let q = db
    .from('patient_messages')
    .select('*')
    .eq('patient_id', String(patientId))
    .order('created_at', { ascending: false })
    .limit(limit + 1);
  q = applyRoleFilters(q);

  if (before) q = q.lt('created_at', before);

  const { data, error } = await q;
  if (error) {
    console.error('[Genie Thread Paginated] Error:', error.message);
    return { data: [], nextCursor: null, hasMore: false };
  }

  const rows = data || [];
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const oldest = trimmed[trimmed.length - 1];
  // Return ascending (oldest→newest within this page) for direct rendering.
  return {
    data: trimmed.slice().reverse(),
    nextCursor: hasMore && oldest ? oldest.created_at : null,
    hasMore,
  };
}

/**
 * Mark a message as read in Supabase
 */
async function markMessageReadInGenie(messageId) {
  const db = getGenieDb();
  if (!db) return false;

  const { error } = await db
    .from('patient_messages')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', messageId);

  if (error) { console.error('[Genie MarkRead] Error:', error.message); return false; }
  return true;
}
/**
 * Resolve Genie Patient UUID from Gini/Scribe Patient ID
 */
async function resolveGeniePatientId(giniPatientId) {
  const db = getGenieDb();
  if (!db) return null;

  try {
    const { data, error } = await withRetry(
      () =>
        db
          .from("patients")
          .select("id")
          .eq("gini_patient_id", String(giniPatientId))
          .maybeSingle(),
      { label: `resolvePatient(${giniPatientId})` },
    );

    if (error) {
      console.error("[Genie Resolve Patient] Error:", error.message || error);
      return null;
    }

    return data?.id || null;

  } catch (err) {
    console.error("[Genie Resolve Patient] Exception:", err.message || err);
    return null;
  }
}

// Coerce any patient identifier the scribe side might pass — scribe int
// (e.g. "16709"), genie UUID, or already-resolved UUID — into the genie
// `patients.id` UUID. Required because `patient_messages.patient_id` is
// UUID-typed: passing a scribe int directly throws Postgres 22P02
// "invalid input syntax for type uuid". Returns null if no mapping
// exists (patient never synced to genie).
const UUID_RX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
async function resolveAnyToGenieUuid(input) {
  if (input == null || input === "") return null;
  const s = String(input).trim();
  if (UUID_RX.test(s)) return s;
  return await resolveGeniePatientId(s);
}


/**
 * Sync patient logs FROM Genie → Local PostgreSQL
 */
async function syncPatientLogsFromGenie(scribePatientId, localDb) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: "No Genie credentials" };

  // Dynamic import — labCanonical.js is ESM, this file is CJS. Used to
  // populate scribe lab_results.canonical_name on patient-pull rows so the
  // POST /lab existing-row check (keyed on canonical_name) can match.
  const { getCanonical } = await import("./utils/labCanonical.js");

  const fetchErrors = [];
  const upsertFailures = {
    vitals: 0,
    activities: 0,
    symptoms: 0,
    medications: 0,
    meals: 0,
    medications_master: 0,
    conditions: 0,
    labs: 0,
  };

  try {

    const genieUUID = await resolveGeniePatientId(scribePatientId);

    if (!genieUUID) {
      return {
        synced: false,
        reason: "Genie patient not found"
      };
    }

    // Each fetch wrapped in its own retry; a single table failing does not
    // prevent the others from syncing. Missing data becomes an empty list.
    const safeFetch = async (label, build) => {
      try {
        const res = await withRetry(build, { label: `fetch:${label}` });
        if (res?.error) {
          fetchErrors.push({ table: label, error: res.error.message || String(res.error) });
          return [];
        }
        return res?.data || [];
      } catch (err) {
        fetchErrors.push({ table: label, error: err.message || String(err) });
        return [];
      }
    };

    const [vitals, activities, symptoms, meds, meals, medsMaster, conditions, labs] = await Promise.all([
      safeFetch('vitals', () =>
        db.from("vitals")
          .select("*")
          .eq("patient_id", genieUUID)
          .or("source.is.null,source.not.in.(doctor,scribe)")
          .order("recorded_date", { ascending: false })
          .limit(2000),
      ),
      safeFetch('activity_logs', () =>
        db.from("activity_logs")
          .select("*")
          .eq("patient_id", genieUUID)
          .order("log_date", { ascending: false })
          .limit(2000),
      ),
      safeFetch('symptom_logs', () =>
        db.from("symptom_logs")
          .select("*")
          .eq("patient_id", genieUUID)
          .order("log_date", { ascending: false })
          .limit(2000),
      ),
      safeFetch('medication_logs', () =>
        db.from("medication_logs")
          .select(`*, medications ( name, dose )`)
          .eq("patient_id", genieUUID)
          .order("log_date", { ascending: false })
          .limit(2000),
      ),
      safeFetch('meal_logs', () =>
        db.from("meal_logs")
          .select("*")
          .eq("patient_id", genieUUID)
          .order("log_date", { ascending: false })
          .limit(2000),
      ),
      // Master medications list the patient (or scribe) has attached to the
      // Genie profile. We mirror these so the scribe visit page can show
      // "patient-added" medicines even before a dose has been logged.
      safeFetch('medications', () =>
        db.from("medications")
          .select("*")
          .eq("patient_id", genieUUID)
          .order("created_at", { ascending: false })
          .limit(2000),
      ),
      safeFetch('conditions', () =>
        db.from("conditions")
          .select("*")
          .eq("patient_id", genieUUID)
          .order("created_at", { ascending: false })
          .limit(2000),
      ),
      // Patient-app self-logged labs (HbA1c, LDL, TSH, Haemoglobin, eGFR
      // entered via LogModal). Filter on source='patient' so we don't
      // re-pull rows that scribe itself just pushed via gini_sync_lab
      // (those carry source='scribe').
      safeFetch('lab_results', () =>
        db.from("lab_results")
          .select("*")
          .eq("patient_id", genieUUID)
          .eq("source", "patient")
          .order("test_date", { ascending: false })
          .limit(2000),
      ),
    ]);

    // Helper: run a single upsert with retry and per-row isolation so one bad
    // row cannot nuke the rest of the batch.
    const safeUpsert = async (bucket, sql, params) => {
      try {
        const r = await withRetry(() => localDb.query(sql, params), { label: `upsert:${bucket}` });
        return { ok: true, rowCount: r?.rowCount || 0 };
      } catch (err) {
        upsertFailures[bucket] = (upsertFailures[bucket] || 0) + 1;
        console.error(`[Genie Sync][upsert:${bucket}] Failed: ${err.message}`);
        return { ok: false, rowCount: 0 };
      }
    };

    // Track whether any patient-app lab was inserted or materially updated
    // during this sync. If so, the doctor's cached visit summary is stale
    // (it was generated against the previous lab values) and must be
    // cleared so the next /summary call regenerates against fresh labs.
    let labsChangedRows = 0;


    // -------------------------
    // Vitals UPSERT
    // -------------------------

    for (const v of vitals) {
      await safeUpsert('vitals', `
        INSERT INTO patient_vitals_log (
          patient_id, genie_id, recorded_date, reading_time,
          bp_systolic, bp_diastolic, rbs, meal_type,
          weight_kg, pulse, spo2, body_fat,
          muscle_mass, bmi, waist, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
        )
        ON CONFLICT (genie_id) DO UPDATE SET
          recorded_date = EXCLUDED.recorded_date,
          reading_time  = EXCLUDED.reading_time,
          bp_systolic   = EXCLUDED.bp_systolic,
          bp_diastolic  = EXCLUDED.bp_diastolic,
          rbs           = EXCLUDED.rbs,
          meal_type     = EXCLUDED.meal_type,
          weight_kg     = EXCLUDED.weight_kg,
          pulse         = EXCLUDED.pulse,
          spo2          = EXCLUDED.spo2,
          body_fat      = EXCLUDED.body_fat,
          muscle_mass   = EXCLUDED.muscle_mass,
          bmi           = EXCLUDED.bmi,
          waist         = EXCLUDED.waist
      `, [
        scribePatientId, v.id, v.recorded_date, v.reading_time,
        v.bp_systolic, v.bp_diastolic, v.rbs, v.meal_type,
        v.weight_kg, v.pulse, v.spo2, v.body_fat,
        v.muscle_mass, v.bmi, v.waist, v.created_at,
      ]);
    }


    // -------------------------
    // Lab Results UPSERT  (patient-app self-logged labs)
    // -------------------------
    // Mirror Genie `lab_results` rows (source='patient') into the scribe
    // `lab_results` table so the doctor's visit page sees the patient's
    // self-entered HbA1c / LDL / TSH / Haemoglobin / eGFR alongside the
    // doctor-entered or Healthray-imported values. Idempotent via
    // genie_id (added in 2026-04-28_lab_results_genie_id.sql). Genie's
    // numeric `value` maps to scribe's `result`; status ('normal'|'high'|
    // 'low') maps to scribe's flag convention ('HIGH'|'LOW'|null).

    for (const lab of labs) {
      const value = lab.value != null ? parseFloat(lab.value) : null;
      if (!Number.isFinite(value)) continue;
      if (!lab.test_name) continue;
      const flag =
        lab.status === 'high' ? 'HIGH' :
        lab.status === 'low' ? 'LOW' : null;
      const canonical = getCanonical(lab.test_name) || lab.test_name;
      const labRes = await safeUpsert('labs', `
        INSERT INTO lab_results (
          patient_id, genie_id, test_date, test_name, canonical_name,
          result, unit, ref_range, flag, panel_name,
          source, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
        )
        ON CONFLICT (genie_id) DO UPDATE SET
          test_date      = EXCLUDED.test_date,
          test_name      = EXCLUDED.test_name,
          canonical_name = EXCLUDED.canonical_name,
          result         = EXCLUDED.result,
          unit           = EXCLUDED.unit,
          ref_range      = EXCLUDED.ref_range,
          flag           = EXCLUDED.flag,
          panel_name     = EXCLUDED.panel_name
        WHERE lab_results.result    IS DISTINCT FROM EXCLUDED.result
           OR lab_results.test_date IS DISTINCT FROM EXCLUDED.test_date
           OR lab_results.unit      IS DISTINCT FROM EXCLUDED.unit
           OR lab_results.flag      IS DISTINCT FROM EXCLUDED.flag
           OR lab_results.test_name IS DISTINCT FROM EXCLUDED.test_name
      `, [
        scribePatientId,
        lab.id,
        lab.test_date || null,
        lab.test_name,
        canonical,
        value,
        lab.unit || null,
        lab.reference_range || null,
        flag,
        lab.lab_name || null,
        'patient_app',
        lab.created_at || new Date().toISOString(),
      ]);
      labsChangedRows += labRes?.rowCount || 0;
    }

    // If a patient-app lab actually changed (insert or value/date/unit/flag
    // diff), wipe the cached pre/post-visit AI summary on the patient's most
    // recent appointment so the next /summary call regenerates against the
    // fresh lab values. Past appointments stay frozen — that snapshot is
    // what was true at the time of that visit.
    if (labsChangedRows > 0) {
      try {
        await localDb.query(
          `UPDATE appointments
              SET ai_summary = NULL,
                  ai_summary_generated_at = NULL,
                  post_visit_summary = NULL,
                  post_visit_summary_generated_at = NULL
            WHERE id = (
              SELECT id FROM appointments
               WHERE patient_id = $1
               ORDER BY appointment_date DESC NULLS LAST, id DESC
               LIMIT 1
            )
              AND (ai_summary IS NOT NULL OR post_visit_summary IS NOT NULL)`,
          [scribePatientId],
        );
      } catch (err) {
        console.error('[Genie Sync][labs] summary invalidate failed:', err?.message || err);
      }
    }


    // -------------------------
    // Activity UPSERT
    // -------------------------

    for (const a of activities) {
      await safeUpsert('activities', `
        INSERT INTO patient_activity_log (
          patient_id, genie_id, activity_type,
          value, value2, context,
          duration_minutes, mood_score,
          log_date, log_time, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
        )
        ON CONFLICT (genie_id) DO UPDATE SET
          activity_type    = EXCLUDED.activity_type,
          value            = EXCLUDED.value,
          value2           = EXCLUDED.value2,
          context          = EXCLUDED.context,
          duration_minutes = EXCLUDED.duration_minutes,
          mood_score       = EXCLUDED.mood_score,
          log_date         = EXCLUDED.log_date,
          log_time         = EXCLUDED.log_time
      `, [
        scribePatientId, a.id, a.activity_type, a.value, a.value2,
        a.context, a.duration_minutes, a.mood_score,
        a.log_date, a.log_time, a.created_at,
      ]);
    }


    // -------------------------
    // Body Scan BACKFILL  (activity_logs → patient_vitals_log)
    // -------------------------
    // Defence-in-depth: any time the Genie app's Body section records
    // weight / body_fat / muscle_mass / bmi / waist, the intended write
    // goes into the vitals table. Old app bundles (pre-insert-fix) and
    // older code paths instead wrote only to activity_logs with the
    // metrics encoded as JSON in `context`. Here we synthesize a
    // patient_vitals_log row from those entries so the doctor sees the
    // reading regardless of which write path ran. Idempotent via a
    // 'body-' prefix on genie_id so re-runs don't duplicate.
    // Pre-compute the timestamps of real vitals rows that already carry at
    // least one body metric — we use these to skip the backfill when the
    // app successfully double-wrote the scan (new bundle path). Tolerance
    // is 60s to absorb clock skew and the two-write latency.
    const bodyVitalsTimestamps = vitals
      .filter((v) => v.weight_kg != null || v.body_fat != null || v.muscle_mass != null)
      .map((v) => new Date(v.created_at).getTime())
      .filter((t) => !isNaN(t));

    for (const a of activities) {
      if (a.activity_type !== 'Body' || !a.context) continue;
      let ctx;
      try { ctx = typeof a.context === 'string' ? JSON.parse(a.context) : a.context; }
      catch { continue; }
      if (!ctx || typeof ctx !== 'object') continue;
      const wt = ctx.weight_kg != null ? Number(ctx.weight_kg) : null;
      const bf = ctx.body_fat != null ? Number(ctx.body_fat) : null;
      const mm = ctx.muscle_mass != null ? Number(ctx.muscle_mass) : null;
      const bmi = ctx.bmi != null ? Number(ctx.bmi) : null;
      const waist = ctx.waist != null ? Number(ctx.waist) : null;
      if (wt == null && bf == null && mm == null && bmi == null && waist == null) continue;
      // Skip if the same scan was already written to Genie vitals directly
      // (new app bundles do the double-write; the direct row is richer).
      const aTs = new Date(a.created_at).getTime();
      if (!isNaN(aTs) && bodyVitalsTimestamps.some((t) => Math.abs(t - aTs) <= 60_000)) continue;
      await safeUpsert('vitals', `
        INSERT INTO patient_vitals_log (
          patient_id, genie_id, recorded_date, reading_time,
          weight_kg, body_fat, muscle_mass, bmi, waist, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
        )
        ON CONFLICT (genie_id) DO UPDATE SET
          weight_kg = EXCLUDED.weight_kg,
          body_fat = EXCLUDED.body_fat,
          muscle_mass = EXCLUDED.muscle_mass,
          bmi = EXCLUDED.bmi,
          waist = EXCLUDED.waist
      `, [
        scribePatientId,
        `body-${a.id}`,
        a.log_date,
        a.log_time || null,
        wt, bf, mm, bmi, waist,
        a.created_at,
      ]);
    }


    // -------------------------
    // Symptoms UPSERT
    // -------------------------

    for (const s of symptoms) {
      await safeUpsert('symptoms', `
        INSERT INTO patient_symptom_log (
          patient_id, genie_id, symptom, severity,
          body_area, context, notes,
          follow_up_needed,
          log_date, log_time, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
        )
        ON CONFLICT (genie_id) DO UPDATE SET
          symptom          = EXCLUDED.symptom,
          severity         = EXCLUDED.severity,
          body_area        = EXCLUDED.body_area,
          context          = EXCLUDED.context,
          notes            = EXCLUDED.notes,
          follow_up_needed = EXCLUDED.follow_up_needed,
          log_date         = EXCLUDED.log_date,
          log_time         = EXCLUDED.log_time
      `, [
        scribePatientId, s.id, s.symptom, s.severity, s.body_area,
        s.context, s.notes, s.follow_up_needed,
        s.log_date, s.log_time, s.created_at,
      ]);
    }


    // -------------------------
    // Medications UPSERT
    // -------------------------

    for (const m of meds) {
      await safeUpsert('medications', `
        INSERT INTO patient_med_log (
          patient_id, genie_id,
          medication_name,
          medication_dose,
          genie_medication_id,
          log_date,
          dose_time,
          status,
          created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9
        )
        ON CONFLICT (genie_id) DO UPDATE SET
          medication_name = EXCLUDED.medication_name,
          medication_dose = EXCLUDED.medication_dose,
          log_date        = EXCLUDED.log_date,
          dose_time       = EXCLUDED.dose_time,
          status          = EXCLUDED.status
      `, [
        scribePatientId, m.id,
        m.medications?.name || null,
        m.medications?.dose || null,
        m.genie_medication_id,
        m.log_date, m.dose_time, m.status, m.created_at,
      ]);
    }


    // -------------------------
    // Meals UPSERT
    // -------------------------

    for (const m of meals) {
      await safeUpsert('meals', `
        INSERT INTO patient_meal_log (
          patient_id, genie_id,
          meal_type, description,
          calories, protein_g,
          carbs_g, fat_g,
          log_date, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
        )
        ON CONFLICT (genie_id) DO UPDATE SET
          meal_type   = EXCLUDED.meal_type,
          description = EXCLUDED.description,
          calories    = EXCLUDED.calories,
          protein_g   = EXCLUDED.protein_g,
          carbs_g     = EXCLUDED.carbs_g,
          fat_g       = EXCLUDED.fat_g,
          log_date    = EXCLUDED.log_date
      `, [
        scribePatientId, m.id, m.meal_type, m.description,
        m.calories, m.protein_g, m.carbs_g, m.fat_g,
        m.log_date, m.created_at,
      ]);
    }


    // -------------------------
    // Medications MASTER UPSERT (Genie `medications` → scribe mirror)
    // -------------------------

    for (const mm of medsMaster) {
      // Genie medications schema: id, patient_id, name, dose, timing, is_active,
      //   type, brand, scheduled_time, for_conditions, start_date, notes,
      //   created_at, source, source_id. Our mirror maps `timing` → frequency
      //   and `notes` → instructions so the UI doesn't need Genie-specific columns.
      const forConds = Array.isArray(mm.for_conditions)
        ? mm.for_conditions
        : (mm.for_conditions ? [String(mm.for_conditions)] : null);
      await safeUpsert('medications_master', `
        INSERT INTO patient_medications_genie (
          patient_id, genie_id, name, dose, frequency,
          timing, instructions, is_active, for_conditions,
          source, synced_at, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11
        )
        ON CONFLICT (genie_id) DO UPDATE SET
          name = EXCLUDED.name,
          dose = EXCLUDED.dose,
          frequency = EXCLUDED.frequency,
          timing = EXCLUDED.timing,
          instructions = EXCLUDED.instructions,
          is_active = EXCLUDED.is_active,
          for_conditions = EXCLUDED.for_conditions,
          source = EXCLUDED.source,
          synced_at = NOW()
      `, [
        scribePatientId, mm.id, mm.name, mm.dose,
        mm.timing || mm.scheduled_time || null,
        mm.timing || null,
        mm.notes || null,
        mm.is_active === undefined ? true : !!mm.is_active,
        forConds,
        mm.source || 'genie',
        mm.created_at,
      ]);
    }


    // -------------------------
    // Conditions UPSERT (Genie `conditions` → scribe mirror)
    // -------------------------

    for (const c of conditions) {
      // Genie `conditions` stores the diagnosis year as a 4-digit string in
      // `diagnosed_year`. Promote it to Jan 1 of that year for DATE storage
      // so the scribe UI can format it consistently with other date fields.
      let diagDate = null;
      if (c.diagnosed_year) {
        const yr = String(c.diagnosed_year);
        diagDate = /^\d{4}$/.test(yr) ? `${yr}-01-01` : yr;
      }
      await safeUpsert('conditions', `
        INSERT INTO patient_conditions_genie (
          patient_id, genie_id, name, status,
          diagnosed_date, notes, synced_at, created_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,NOW(),$7
        )
        ON CONFLICT (genie_id) DO UPDATE SET
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          diagnosed_date = EXCLUDED.diagnosed_date,
          notes = EXCLUDED.notes,
          synced_at = NOW()
      `, [
        scribePatientId, c.id, c.name, c.status,
        diagDate, c.notes || null, c.created_at,
      ]);
    }

    const counts = {
      vitals: vitals.length - upsertFailures.vitals,
      activities: activities.length - upsertFailures.activities,
      symptoms: symptoms.length - upsertFailures.symptoms,
      medications: meds.length - upsertFailures.medications,
      meals: meals.length - upsertFailures.meals,
      medications_master: medsMaster.length - upsertFailures.medications_master,
      conditions: conditions.length - upsertFailures.conditions,
    };
    const totalFailures = Object.values(upsertFailures).reduce((a, b) => a + b, 0);

    if (fetchErrors.length > 0 || totalFailures > 0) {
      console.warn(`[Genie Log Sync] Partial success for patient ${scribePatientId}: ${totalFailures} upsert failures, ${fetchErrors.length} fetch errors`);
    }

    return {
      synced: true,
      partial: fetchErrors.length > 0 || totalFailures > 0,
      counts,
      fetchErrors,
      upsertFailures,
    };

  } catch (err) {
    console.error("[Genie Log Sync] Fatal:", err.message || err);
    return {
      synced: false,
      reason: err.message || String(err),
      fetchErrors,
      upsertFailures,
    };
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Conversation-centric messaging (2026-04-23 rebuild)
// ───────────────────────────────────────────────────────────────────────────
// Stable per-thread identity lives in the `conversations` table. Each message
// in patient_messages now carries a conversation_id. These helpers are the
// single server-side entry point for creating threads, reading them, sending
// replies, and marking reads — replacing the older tuple-based filtering.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find-or-create a conversation. Idempotent on (patient_id, kind, doctor_id).
 * For lab/reception, pass doctor_id=null. For doctor conversations, pass a
 * stable scribe doctors.id (cast to text) so two doctors with the same name
 * get distinct threads.
 */
async function ensureConversation({ patientId, kind, doctorId = null, doctorName = null } = {}) {
  if (!patientId || !['doctor', 'lab', 'reception'].includes(kind)) {
    throw new Error('ensureConversation: patientId + valid kind required');
  }
  // Route by patient ID format: UUID → Genie DB (standalone Genie patients);
  // numeric / non-UUID → Gini DB (scribe-int Gini-program patients). The
  // patient app's chat client uses the same routing so both sides agree
  // on which DB hosts the conversation.
  const sId = String(patientId).trim();
  const isUuid = UUID_RX.test(sId);
  const db = isUuid ? getGenieDb() : getGiniDb();
  if (!db) {
    console.error('[conv ensure] no DB for patient', sId);
    return null;
  }
  // For Genie DB we historically stored patient_id as the genie UUID. For
  // Gini DB, store the raw scribe int as text. Resolve only when writing
  // to Genie DB and the input wasn't already a UUID.
  let pid = sId;
  if (isUuid) {
    pid = sId;
  } else if (db === getGenieDb()) {
    const resolved = await resolveAnyToGenieUuid(patientId);
    if (resolved) pid = resolved;
  }
  const did = doctorId != null ? String(doctorId) : null;

  // 1. Try to read existing.
  let q = db
    .from('conversations')
    .select('*')
    .eq('patient_id', pid)
    .eq('kind', kind);
  q = did === null ? q.is('doctor_id', null) : q.eq('doctor_id', did);

  const { data: existing, error: readErr } = await q.maybeSingle();
  if (readErr && readErr.code !== 'PGRST116') {
    console.error('[conv ensure read]', readErr.message);
  }
  if (existing) {
    // Refresh doctor_name if we now have one and it changed.
    if (doctorName && existing.doctor_name !== doctorName) {
      await db.from('conversations').update({ doctor_name: doctorName }).eq('id', existing.id);
      existing.doctor_name = doctorName;
    }
    return existing;
  }

  // 2. Insert; rely on the unique constraints to handle races.
  const { data: inserted, error: insErr } = await db
    .from('conversations')
    .insert({ patient_id: pid, kind, doctor_id: did, doctor_name: doctorName })
    .select()
    .single();

  if (!insErr && inserted) return inserted;

  // Race: someone else inserted first. Read again.
  let q2 = db.from('conversations').select('*').eq('patient_id', pid).eq('kind', kind);
  q2 = did === null ? q2.is('doctor_id', null) : q2.eq('doctor_id', did);
  const { data: after } = await q2.maybeSingle();
  if (after) return after;

  console.error('[conv ensure insert]', insErr?.message);
  return null;
}

// Batch-fetch patient rows from the Genie `patients` table for a list of
// conversation rows and attach a `patient` object (id, name, phone) to each.
async function attachPatientDetails(db, rows) {
  if (!db || !rows || rows.length === 0) return rows || [];
  const ids = [...new Set(rows.map((r) => r.patient_id).filter(Boolean))];
  if (ids.length === 0) return rows;
  const { data, error } = await db
    .from('patients')
    .select('id,name,phone,gini_patient_id')
    .in('id', ids);
  if (error) { console.error('[conv attachPatients]', error.message); return rows; }
  const map = new Map((data || []).map((p) => [String(p.id), p]));
  return rows.map((r) => ({ ...r, patient: map.get(String(r.patient_id)) || null }));
}

/**
 * List conversations for a specific doctor across all their patients.
 * Used by scribe's /messages (doctor inbox).
 */
async function listConversationsForDoctor(doctorId) {
  const db = getGenieDb();
  if (!db || !doctorId) return [];
  const { data, error } = await db
    .from('conversations')
    .select('*')
    .eq('kind', 'doctor')
    .eq('doctor_id', String(doctorId))
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(500);
  if (error) { console.error('[conv listForDoctor]', error.message); return []; }
  return attachPatientDetails(db, data || []);
}

/**
 * List conversations for a shared team inbox (lab / reception). Returned
 * across all patients; the scribe UI renders one row per patient.
 */
async function listConversationsForTeam(kind) {
  if (!['lab', 'reception'].includes(kind)) return [];
  const dbs = getChatDbs();
  if (!dbs.length) return [];

  // Query both DBs in parallel; tag each row with its source so the inbox
  // can route follow-up operations (open thread, reply, mark read) back
  // to the right DB. Failures on one DB don't poison the other.
  const results = await Promise.all(
    dbs.map(async ({ name, db }) => {
      try {
        const { data, error } = await db
          .from('conversations')
          .select('*')
          .eq('kind', kind)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(500);
        if (error) {
          console.error(`[conv listForTeam:${name}]`, error.message);
          return [];
        }
        const tagged = (data || []).map((c) => ({ ...c, _source: name }));
        return await attachPatientDetails(db, tagged);
      } catch (e) {
        console.error(`[conv listForTeam:${name}]`, e?.message || e);
        return [];
      }
    }),
  );

  const merged = [].concat(...results);
  // Dedupe by (patient_id, kind, doctor_id). When both DBs hold a row for
  // the same logical conversation (common for Gini patients whose lab/
  // reception placeholder got created on both sides), keep the one with
  // messages; if both have messages, keep the newer one.
  const dedupeKey = (c) => `${c.patient_id || ''}::${c.kind || ''}::${c.doctor_id || ''}`;
  const winners = new Map();
  for (const c of merged) {
    const k = dedupeKey(c);
    const existing = winners.get(k);
    if (!existing) {
      winners.set(k, c);
      continue;
    }
    const existingHasActivity = !!existing.last_message_at;
    const candidateHasActivity = !!c.last_message_at;
    if (candidateHasActivity && !existingHasActivity) {
      winners.set(k, c);
    } else if (candidateHasActivity && existingHasActivity) {
      // Both active: keep the more-recent one.
      if ((c.last_message_at || '') > (existing.last_message_at || '')) {
        winners.set(k, c);
      }
    } else if (!candidateHasActivity && !existingHasActivity) {
      // Neither active: keep the newer created_at.
      if ((c.created_at || '') > (existing.created_at || '')) {
        winners.set(k, c);
      }
    }
    // else: existing has activity, candidate doesn't — keep existing.
  }
  const deduped = [...winners.values()];
  deduped.sort((a, b) => {
    const at = a.last_message_at || '';
    const bt = b.last_message_at || '';
    if (!at && !bt) return 0;
    if (!at) return 1;
    if (!bt) return -1;
    return bt.localeCompare(at);
  });
  return deduped;
}

/**
 * Search the Genie `patients` table by name or phone. Returns up to `limit`
 * rows. Used by scribe's reception inbox to start a new chat with a patient.
 */
async function searchGeniePatients(query, { limit = 20 } = {}) {
  const db = getGenieDb();
  if (!db) return [];
  const q = String(query || '').trim();
  let builder = db.from('patients').select('id,name,phone,gini_patient_id').order('name').limit(limit);
  if (q) {
    const safe = q.replace(/[%,()]/g, ' ');
    builder = builder.or(`name.ilike.%${safe}%,phone.ilike.%${safe}%`);
  }
  const { data, error } = await builder;
  if (error) { console.error('[patients search]', error.message); return []; }
  return data || [];
}

/**
 * List all conversations for a patient (care-team view used by patient app).
 * Queries BOTH the Genie DB and the Gini DB and merges. Each row is tagged
 * with `_source` so the patient app can route follow-up sends back to the
 * correct DB. Without this tag the patient app could pick a conversation
 * from one DB and try to insert a message into the other, hitting an FK
 * violation on `patient_messages_conversation_id_fkey`.
 */
async function listConversationsForPatient(patientId) {
  if (patientId == null || patientId === '') return [];
  const dbs = getChatDbs();
  if (!dbs.length) return [];

  // Build the candidate ids the conversations.patient_id column might hold:
  //  - The original input as text (covers scribe-int patients on Gini DB).
  //  - The genie UUID (covers Genie-side rows where patient_id is the UUID).
  const idSet = new Set([String(patientId)]);
  try {
    const uuid = await resolveAnyToGenieUuid(patientId);
    if (uuid) idSet.add(String(uuid));
  } catch {
    /* non-fatal */
  }
  const ids = [...idSet];

  const results = await Promise.all(
    dbs.map(async ({ name, db }) => {
      try {
        const { data, error } = await db
          .from('conversations')
          .select('*')
          .in('patient_id', ids)
          .order('kind', { ascending: true });
        if (error) {
          console.error(`[conv listForPatient:${name}]`, error.message);
          return [];
        }
        return (data || []).map((c) => ({ ...c, _source: name }));
      } catch (e) {
        console.error(`[conv listForPatient:${name}]`, e?.message || e);
        return [];
      }
    }),
  );

  const merged = [].concat(...results);
  // Dedupe duplicates of the same (patient, kind, doctor) across DBs —
  // see listConversationsForTeam for the rule.
  const key = (c) => `${c.patient_id || ''}::${c.kind || ''}::${c.doctor_id || ''}`;
  const winners = new Map();
  for (const c of merged) {
    const k = key(c);
    const ex = winners.get(k);
    if (!ex) { winners.set(k, c); continue; }
    const exAct = !!ex.last_message_at;
    const cAct = !!c.last_message_at;
    if (cAct && !exAct) winners.set(k, c);
    else if (cAct && exAct && (c.last_message_at || '') > (ex.last_message_at || '')) winners.set(k, c);
    else if (!cAct && !exAct && (c.created_at || '') > (ex.created_at || '')) winners.set(k, c);
  }
  return [...winners.values()];
}

async function getConversationById(conversationId) {
  if (!conversationId) return null;
  const dbs = getChatDbs();
  if (!dbs.length) return null;
  // Probe each DB in order; first match wins. Tag with source so callers
  // (sendMessage, getMessages, markRead) can route to the same DB.
  for (const { name, db } of dbs) {
    try {
      const { data, error } = await db
        .from('conversations')
        .select('*')
        .eq('id', conversationId)
        .maybeSingle();
      if (error) {
        console.error(`[conv getById:${name}]`, error.message);
        continue;
      }
      if (data) return { ...data, _source: name };
    } catch (e) {
      console.error(`[conv getById:${name}]`, e?.message || e);
    }
  }
  return null;
}

/**
 * Paginated messages for a single conversation (oldest → newest within page).
 */
async function getConversationMessages(conversationId, { limit = 30, before = null } = {}) {
  if (!conversationId) return { data: [], nextCursor: null, hasMore: false };
  // Resolve which DB hosts the conversation, then query that DB's
  // patient_messages. Falls back to the genie DB if the lookup fails.
  const conv = await getConversationById(conversationId);
  const db = dbForConversation(conv) || getGenieDb();
  if (!db) return { data: [], nextCursor: null, hasMore: false };

  let q = db
    .from('patient_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit + 1);

  if (before) q = q.lt('created_at', before);

  const { data, error } = await q;
  if (error) {
    console.error('[conv getMessages]', error.message);
    return { data: [], nextCursor: null, hasMore: false };
  }

  const rows = data || [];
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const oldest = trimmed[trimmed.length - 1];
  return {
    data: trimmed.slice().reverse(),
    nextCursor: hasMore && oldest ? oldest.created_at : null,
    hasMore,
  };
}

/**
 * Send a message into a conversation. `direction` is set by the caller:
 *   - 'inbound'  = team → patient (scribe/server-originated)
 *   - 'outbound' = patient → team (patient app will usually write directly
 *                  to Supabase rather than going through scribe, but this
 *                  entry point exists for parity and for server-side tests).
 * senderRole is derived from the conversation unless overridden.
 */
async function sendMessageToConversation({
  conversationId,
  message,
  senderName,
  direction = 'inbound',
  senderRole = null,
  attachmentPath = null,
  attachmentMime = null,
  attachmentName = null,
} = {}) {
  if (!conversationId) {
    console.error('[conv sendMessage] missing conversationId');
    return null;
  }
  // Either text body or attachment must be present.
  const hasText = typeof message === 'string' && message.trim().length > 0;
  if (!hasText && !attachmentPath) {
    console.error('[conv sendMessage] no text and no attachment');
    return null;
  }

  const conv = await getConversationById(conversationId);
  if (!conv) {
    console.error('[conv sendMessage] conversation not found in any DB:', conversationId);
    return null;
  }
  // Insert into the same DB the conversation lives in so the FK resolves.
  const db = dbForConversation(conv);
  if (!db) {
    console.error('[conv sendMessage] no DB resolved for conv source:', conv._source);
    return null;
  }

  let payload = {
    patient_id: conv.patient_id,
    conversation_id: conversationId,
    direction,
    message: hasText ? message : null,
    sender_name: senderName || (direction === 'inbound' ? 'Team' : 'Patient'),
    sender_role: senderRole || conv.kind,
    is_read: false,
    attachment_path: attachmentPath || null,
    attachment_mime: attachmentMime || null,
    attachment_name: attachmentName || null,
  };

  // Insert with column-drop + NOT-NULL recovery loop:
  //  - PGRST204 missing column → drop named column and retry.
  //  - 23502 null in NOT NULL column → set the column to '' and retry
  //    (covers older `message NOT NULL` schemas that don't allow
  //    attachment-only rows with message=null).
  //  - any other error → log code/details and return null.
  for (let i = 0; i < 10; i++) {
    const { data, error } = await db
      .from('patient_messages')
      .insert(payload)
      .select()
      .single();
    if (!error && data) return data;
    const msg = error?.message || '';
    const code = error?.code || '';
    const details = error?.details || '';
    const hint = error?.hint || '';
    // PGRST204 — schema cache: missing column.
    if (code === 'PGRST204') {
      const m = msg.match(/'([^']+)' column/i) || msg.match(/column "([^"]+)"/i);
      const missing = m ? m[1] : null;
      if (missing && missing in payload) {
        const { [missing]: _drop, ...rest } = payload;
        payload = rest;
        console.warn(`[conv sendMessage] dropping missing column "${missing}" and retrying`);
        continue;
      }
    }
    // 23502 — NOT NULL violation. Find the column from details (e.g.
    // "Failing row contains ..., column \"message\" violates not-null
    // constraint") and provide an empty-string default to satisfy it.
    if (code === '23502') {
      const m = msg.match(/column "([^"]+)" of relation/i)
        || details.match(/column "([^"]+)"/i);
      const col = m ? m[1] : null;
      if (col && (col in payload) && payload[col] == null) {
        payload = { ...payload, [col]: '' };
        console.warn(`[conv sendMessage] NOT NULL on "${col}" — defaulting to '' and retrying`);
        continue;
      }
    }
    console.error('[conv sendMessage]', code, msg, '|', details, '|', hint);
    return null;
  }
  console.error('[conv sendMessage] retry budget exhausted');
  return null;
}

/**
 * Zero the unread counter for one side of a conversation and mark the
 * corresponding messages as read. `side='team'` clears outbound unreads
 * (scribe read the patient's messages). `side='patient'` clears inbound
 * unreads (patient read the team's messages).
 */
// Upload a chat attachment (image/PDF) into the shared `patient-files`
// bucket and return its storage key. Caller is responsible for then
// inserting the patient_messages row that references the key.
async function uploadChatAttachment({
  patientId,
  conversationId,
  base64,
  mediaType,
  fileName,
} = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const bucket = 'patient-files';
  if (!url || !key) return { error: 'Storage not configured' };
  if (!patientId || !conversationId || !base64 || !fileName) {
    return { error: 'Missing required fields' };
  }

  const buffer = Buffer.from(base64, 'base64');
  // 10 MB cap. Mirrors UploadReportModal.jsx and the documents.js path.
  const MAX_BYTES = 10 * 1024 * 1024;
  if (buffer.length > MAX_BYTES) {
    return { error: 'File exceeds 10 MB limit' };
  }

  // Lazy-import the same sanitizer used by documents.js to keep paths ASCII-safe.
  const safeName = sanitizeFilename(fileName);
  const ts = Date.now();
  const path = `patients/${patientId}/chat/${conversationId}/${ts}_${safeName}`;

  const resp = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      'Content-Type': mediaType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error('[chat upload]', resp.status, body);
    return { error: `Upload failed (${resp.status}): ${body.slice(0, 200)}` };
  }
  try {
    const ack = await resp.json();
    if (ack?.Key && !ack.Key.endsWith(path)) {
      console.warn('[chat upload] path mismatch — generated', path, 'stored', ack.Key);
    }
  } catch {
    /* non-JSON body is fine */
  }
  // Defensive HEAD verify — a recent regression had the upload reporting
  // 200 while the binary wasn't actually persisted. Catch that here
  // instead of letting downstream sign-URL calls 404 silently.
  try {
    const head = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${key}`, apikey: key },
    });
    if (!head.ok) {
      console.error('[chat upload verify]', head.status, 'path missing after upload', path);
      return { error: `Upload reported success but file not found (${head.status})` };
    }
  } catch (e) {
    console.warn('[chat upload verify]', e.message);
    /* non-fatal — verify failure shouldn't block the upload entirely */
  }
  return { path, mime: mediaType, name: fileName };
}

// Local copy of the sanitizer in routes/documents.js — duplicated to avoid
// a CJS↔ESM circular import (documents.js is ESM and imports this module).
function sanitizeFilename(name) {
  if (!name) return `file_${Date.now()}`;
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : '';
  const cleanBase = base
    .normalize('NFKD')
    .replace(/[–—]/g, '-')
    .replace(/[‘’“”]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^\w.\-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, 120);
  const cleanExt = ext.replace(/[^a-z0-9]/g, '').slice(0, 8);
  const safeBase = cleanBase || `file_${Date.now()}`;
  return cleanExt ? `${safeBase}.${cleanExt}` : safeBase;
}

// Short-lived signed URL for a chat attachment. 5-min default.
async function signChatAttachmentUrl(storagePath, expiresIn = 300) {
  return signStorageUrl(storagePath, expiresIn);
}

async function markConversationRead({ conversationId, side } = {}) {
  if (!conversationId || !['team', 'patient'].includes(side)) return false;
  const conv = await getConversationById(conversationId);
  const db = dbForConversation(conv) || getGenieDb();
  if (!db) return false;

  const targetDirection = side === 'team' ? 'outbound' : 'inbound';
  const updateCols = side === 'team'
    ? { team_unread_count: 0 }
    : { patient_unread_count: 0 };

  // Flip is_read on all matching messages (server-side, single round-trip).
  const { error: msgErr } = await db
    .from('patient_messages')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('direction', targetDirection)
    .eq('is_read', false);
  if (msgErr) console.error('[conv markRead msgs]', msgErr.message);

  const { error: convErr } = await db
    .from('conversations')
    .update(updateCols)
    .eq('id', conversationId);
  if (convErr) { console.error('[conv markRead conv]', convErr.message); return false; }
  return true;
}

// ─── Per-patient sync throttle ────────────────────────────────────────────
// The visit GET handler used to call syncPatientLogsFromGenie unconditionally,
// which — combined with React Query's refetch-on-focus and a 60s lab poll —
// produced one Genie round-trip every few seconds while a doctor's tab was
// open. This wrapper collapses those bursts: concurrent requests share the
// same in-flight promise, and we skip entirely if the previous sync for this
// patient completed less than MIN_SYNC_INTERVAL_MS ago. Explicit "Sync Now"
// (POST /api/patients/:id/sync-health-logs) keeps calling the raw function
// so users can always force a fresh pull.
const _lastSyncAt = new Map();    // scribePatientId → epoch ms of last success
const _inFlight = new Map();      // scribePatientId → Promise of current sync
const MIN_SYNC_INTERVAL_MS = 5_000;

async function syncPatientLogsFromGenieThrottled(scribePatientId, localDb) {
  // Normalize to string so Number(16619) and "16619" share the same throttle
  // entry (visit.js passes Number, health-logs.js passes the raw string param).
  const key = String(scribePatientId);
  if (_inFlight.has(key)) return _inFlight.get(key);
  const now = Date.now();
  const last = _lastSyncAt.get(key) || 0;
  if (now - last < MIN_SYNC_INTERVAL_MS) {
    return { synced: true, skipped: 'throttled', ageMs: now - last };
  }
  const p = (async () => {
    try {
      const r = await syncPatientLogsFromGenie(scribePatientId, localDb);
      _lastSyncAt.set(key, Date.now());
      return r;
    } finally {
      _inFlight.delete(key);
    }
  })();
  _inFlight.set(key, p);
  return p;
}

module.exports = {
  syncPatientToGenie, deletePatientFromGenie,
  syncVisitToGenie, sendAlertToGenie, getAlertsFromGenie,
  getMessagesFromGenie, sendReplyToGenie, getThreadFromGenie, markMessageReadInGenie, resolveGeniePatientId,
  syncPatientLogsFromGenie,
  syncPatientLogsFromGenieThrottled,
  syncDiagnosesToGenie,
  syncMedicationsToGenie,
  deleteGenieMedication,
  updateGenieMedication,
  updateGenieLabByGenieId,
  syncLabsToGenie,
  syncDocumentsToGenie,
  syncAppointmentToGenie,
  syncCareTeamToGenie,
  syncVitalsRowToGenie,
  updateGenieVitalsByGenieId,
  // Conversation-model exports
  ensureConversation,
  listConversationsForDoctor,
  listConversationsForTeam,
  listConversationsForPatient,
  searchGeniePatients,
  getConversationById,
  getConversationMessages,
  sendMessageToConversation,
  markConversationRead,
  uploadChatAttachment,
  signChatAttachmentUrl,
  getGenieDb,
  getGiniDb,
  dbForConversation,
};
