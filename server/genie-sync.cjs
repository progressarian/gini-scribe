// genie-sync.js — GiniScribe → MyHealth Genie sync module
// Place in: gini-scribe/server/genie-sync.js
// Requires env vars: GENIE_SUPABASE_URL, GENIE_SUPABASE_SERVICE_KEY

const { createClient } = require('@supabase/supabase-js');

let genieDb = null;

function getGenieDb() {
  if (genieDb) return genieDb;
  const url = process.env.GENIE_SUPABASE_URL;
  const key = process.env.GENIE_SUPABASE_SERVICE_KEY;
  if (!url || !key) return null; // Graceful: no env vars = no sync
  genieDb = createClient(url, key);
  return genieDb;
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

    // 3. Sync medications
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
        p_is_active: true,
      }, { step: 'medication', extra: { name: med.name } });
    }

    // 4. Sync lab results
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

    // 7. Sync appointment (next follow-up)
    if (visit.follow_up_date || visit.next_appointment) {
      await callRpc('gini_sync_appointment', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `gini-appt-${visit.id || visit.visit_id || visit.consultation_id}`,
        p_appointment_date: visit.follow_up_date || visit.next_appointment,
        p_doctor_name: doctor?.name || doctor?.con_name || visit.doctor_name || visit.con_name || null,
        p_notes: visit.follow_up_instructions || null,
        p_status: 'scheduled',
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
    query = query.eq('patient_id', String(giniPatientId));
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

  const payload = {
    patient_id: String(patientId),
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


/**
 * Sync patient logs FROM Genie → Local PostgreSQL
 */
async function syncPatientLogsFromGenie(scribePatientId, localDb) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: "No Genie credentials" };

  const fetchErrors = [];
  const upsertFailures = { vitals: 0, activities: 0, symptoms: 0, medications: 0, meals: 0 };

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

    const [vitals, activities, symptoms, meds, meals] = await Promise.all([
      safeFetch('vitals', () =>
        db.from("vitals")
          .select("*")
          .eq("patient_id", genieUUID)
          .or("source.is.null,source.not.in.(doctor,scribe)")
          .order("recorded_date", { ascending: false })
          .limit(500),
      ),
      safeFetch('activity_logs', () =>
        db.from("activity_logs")
          .select("*")
          .eq("patient_id", genieUUID)
          .order("log_date", { ascending: false })
          .limit(500),
      ),
      safeFetch('symptom_logs', () =>
        db.from("symptom_logs")
          .select("*")
          .eq("patient_id", genieUUID)
          .order("log_date", { ascending: false })
          .limit(500),
      ),
      safeFetch('medication_logs', () =>
        db.from("medication_logs")
          .select(`*, medications ( name, dose )`)
          .eq("patient_id", genieUUID)
          .order("log_date", { ascending: false })
          .limit(500),
      ),
      safeFetch('meal_logs', () =>
        db.from("meal_logs")
          .select("*")
          .eq("patient_id", genieUUID)
          .order("log_date", { ascending: false })
          .limit(500),
      ),
    ]);

    // Helper: run a single upsert with retry and per-row isolation so one bad
    // row cannot nuke the rest of the batch.
    const safeUpsert = async (bucket, sql, params) => {
      try {
        await withRetry(() => localDb.query(sql, params), { label: `upsert:${bucket}` });
        return true;
      } catch (err) {
        upsertFailures[bucket] = (upsertFailures[bucket] || 0) + 1;
        console.error(`[Genie Sync][upsert:${bucket}] Failed: ${err.message}`);
        return false;
      }
    };


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
          reading_time = EXCLUDED.reading_time
      `, [
        scribePatientId, v.id, v.recorded_date, v.reading_time,
        v.bp_systolic, v.bp_diastolic, v.rbs, v.meal_type,
        v.weight_kg, v.pulse, v.spo2, v.body_fat,
        v.muscle_mass, v.bmi, v.waist, v.created_at,
      ]);
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
          activity_type = EXCLUDED.activity_type
      `, [
        scribePatientId, a.id, a.activity_type, a.value, a.value2,
        a.context, a.duration_minutes, a.mood_score,
        a.log_date, a.log_time, a.created_at,
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
          severity = EXCLUDED.severity
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
          status = EXCLUDED.status
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
          calories = EXCLUDED.calories
      `, [
        scribePatientId, m.id, m.meal_type, m.description,
        m.calories, m.protein_g, m.carbs_g, m.fat_g,
        m.log_date, m.created_at,
      ]);
    }

    const counts = {
      vitals: vitals.length - upsertFailures.vitals,
      activities: activities.length - upsertFailures.activities,
      symptoms: symptoms.length - upsertFailures.symptoms,
      medications: meds.length - upsertFailures.medications,
      meals: meals.length - upsertFailures.meals,
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
  const db = getGenieDb();
  if (!db) return null;
  if (!patientId || !['doctor', 'lab', 'reception'].includes(kind)) {
    throw new Error('ensureConversation: patientId + valid kind required');
  }
  const pid = String(patientId);
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
  const db = getGenieDb();
  if (!db || !['lab', 'reception'].includes(kind)) return [];
  const { data, error } = await db
    .from('conversations')
    .select('*')
    .eq('kind', kind)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(500);
  if (error) { console.error('[conv listForTeam]', error.message); return []; }
  return attachPatientDetails(db, data || []);
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
 */
async function listConversationsForPatient(patientId) {
  const db = getGenieDb();
  if (!db) return [];
  const { data, error } = await db
    .from('conversations')
    .select('*')
    .eq('patient_id', String(patientId))
    .order('kind', { ascending: true });
  if (error) { console.error('[conv listForPatient]', error.message); return []; }
  return data || [];
}

async function getConversationById(conversationId) {
  const db = getGenieDb();
  if (!db || !conversationId) return null;
  const { data, error } = await db
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .maybeSingle();
  if (error) { console.error('[conv getById]', error.message); return null; }
  return data || null;
}

/**
 * Paginated messages for a single conversation (oldest → newest within page).
 */
async function getConversationMessages(conversationId, { limit = 30, before = null } = {}) {
  const db = getGenieDb();
  if (!db || !conversationId) return { data: [], nextCursor: null, hasMore: false };

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
} = {}) {
  const db = getGenieDb();
  if (!db || !conversationId || !message) return null;

  const conv = await getConversationById(conversationId);
  if (!conv) return null;

  const payload = {
    patient_id: conv.patient_id,
    conversation_id: conversationId,
    direction,
    message,
    sender_name: senderName || (direction === 'inbound' ? 'Team' : 'Patient'),
    sender_role: senderRole || conv.kind,
    is_read: false,
  };

  const { data, error } = await db
    .from('patient_messages')
    .insert(payload)
    .select()
    .single();

  if (error) { console.error('[conv sendMessage]', error.message); return null; }
  return data;
}

/**
 * Zero the unread counter for one side of a conversation and mark the
 * corresponding messages as read. `side='team'` clears outbound unreads
 * (scribe read the patient's messages). `side='patient'` clears inbound
 * unreads (patient read the team's messages).
 */
async function markConversationRead({ conversationId, side } = {}) {
  const db = getGenieDb();
  if (!db || !conversationId || !['team', 'patient'].includes(side)) return false;

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

module.exports = {
  syncPatientToGenie, deletePatientFromGenie,
  syncVisitToGenie, sendAlertToGenie, getAlertsFromGenie,
  getMessagesFromGenie, sendReplyToGenie, getThreadFromGenie, markMessageReadInGenie, resolveGeniePatientId,
  syncPatientLogsFromGenie,
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
  getGenieDb,
};
