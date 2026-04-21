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

  try {
    // 1. Link/update patient profile
    const { data: mhgId, error: linkErr } = await db.rpc('gini_link_patient', {
      p_gini_id: giniPatientId,
      p_name: patient.name || patient.patient_name,
      p_phone: patient.phone ?? patient.mobile ?? null,
      p_dob: patient.dob || patient.date_of_birth || null,
      p_sex: patient.sex || patient.gender || null,
      p_blood_group: patient.blood_group || null,
      p_uhid: patient.uhid || patient.file_no || null,
    });
    if (linkErr) errors.push({ step: 'link_patient', error: linkErr.message });

    // 2. Sync care team (hospital + doctor + MO)
    const careTeam = [
      { role: 'hospital', name: 'Gini Advanced Care Hospital', phone: process.env.HOSPITAL_PHONE || null, speciality: null, org: 'Gini Advanced Care Hospital', primary: true, sourceId: 'gini-hospital' },
      { role: 'doctor', name: doctor?.name || doctor?.con_name || visit.doctor_name || visit.con_name, phone: doctor?.phone || null, speciality: doctor?.speciality || visit.speciality || null, org: 'Gini Advanced Care Hospital', primary: true, sourceId: `gini-doc-${doctor?.id || 'primary'}` },
    ];
    if (visit.mo_name || patient.coordinator) {
      careTeam.push({ role: 'coordinator', name: visit.mo_name || patient.coordinator, phone: visit.mo_phone || null, speciality: 'Medical Officer', org: 'Gini Advanced Care Hospital', primary: false, sourceId: `gini-mo-${visit.mo_id || 'primary'}` });
    }
    for (const ct of careTeam) {
      const { error } = await db.rpc('gini_sync_care_team', {
        p_gini_patient_id: giniPatientId, p_source_id: ct.sourceId, p_role: ct.role,
        p_name: ct.name, p_phone: ct.phone, p_speciality: ct.speciality,
        p_organization: ct.org, p_is_primary: ct.primary,
      });
      if (error) errors.push({ step: 'care_team', name: ct.name, error: error.message });
    }

    // 3. Sync medications
    const meds = visit.medications || visit.medicines || visit.prescription || [];
    for (let i = 0; i < meds.length; i++) {
      const med = meds[i];
      const { error } = await db.rpc('gini_sync_medication', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `${visit.id || visit.visit_id || visit.consultation_id}-med-${i}`,
        p_name: med.name || med.medicine_name || med.drug_name,
        p_dose: med.dose || med.dosage || null,
        p_frequency: med.frequency || null,
        p_timing: med.timing || med.schedule || null,
        p_duration: med.duration || null,
        p_instructions: med.instructions || med.notes || null,
        p_is_active: true,
      });
      if (error) errors.push({ step: 'medication', name: med.name, error: error.message });
    }

    // 4. Sync lab results
    const labs = visit.lab_results || visit.labs || visit.investigations || [];
    for (let i = 0; i < labs.length; i++) {
      const lab = labs[i];
      const { error } = await db.rpc('gini_sync_lab', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `${visit.id || visit.visit_id || visit.consultation_id}-lab-${i}`,
        p_test_name: lab.test_name || lab.name || lab.test,
        p_value: parseFloat(lab.value) || 0,
        p_unit: lab.unit || null,
        p_reference_range: lab.reference_range || lab.normal_range || lab.ref_range || lab.ref || null,
        p_status: lab.status || lab.flag || (lab.is_abnormal ? 'abnormal' : 'normal'),
        p_test_date: lab.test_date || visit.visit_date || new Date().toISOString().split('T')[0],
      });
      if (error) errors.push({ step: 'lab', name: lab.test_name, error: error.message });
    }

    // 5. Sync diagnoses/conditions
    const diagnoses = visit.diagnoses || visit.conditions || visit.diagnosis_list || visit.mo_data?.diagnoses || [];
    for (let i = 0; i < diagnoses.length; i++) {
      const dx = diagnoses[i];
      const dxName = typeof dx === 'string' ? dx : (dx.name || dx.diagnosis || dx.label);
      const { error } = await db.rpc('gini_sync_condition', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `gini-dx-${dxName?.toLowerCase().replace(/\s+/g,'-')}`,
        p_name: dxName,
        p_status: dx.status || 'active',
        p_diagnosed_date: dx.diagnosed_date || null,
        p_notes: dx.notes || null,
      });
      if (error) errors.push({ step: 'condition', name: dxName, error: error.message });
    }

    // 6. Sync goals if present
    const goals = visit.goals || visit.targets || [];
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      const { error } = await db.rpc('gini_sync_goal', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `gini-goal-${(g.biomarker || g.marker)?.toLowerCase().replace(/\s+/g,'-') || i}`,
        p_biomarker: g.biomarker || g.test_name || g.marker,
        p_current_value: String(g.current_value || g.current),
        p_target_value: String(g.target_value || g.target),
        p_target_date: g.target_date || null,
        p_status: 'active',
      });
      if (error) errors.push({ step: 'goal', name: g.biomarker || g.marker, error: error.message });
    }

    // 7. Sync appointment (next follow-up)
    if (visit.follow_up_date || visit.next_appointment) {
      const { error } = await db.rpc('gini_sync_appointment', {
        p_gini_patient_id: giniPatientId,
        p_source_id: `gini-appt-${visit.id || visit.visit_id || visit.consultation_id}`,
        p_appointment_date: visit.follow_up_date || visit.next_appointment,
        p_doctor_name: doctor?.name || doctor?.con_name || visit.doctor_name || visit.con_name || null,
        p_notes: visit.follow_up_instructions || null,
        p_status: 'scheduled',
      });
      if (error) errors.push({ step: 'appointment', error: error.message });
    }

    // 8. Add timeline event
    const { error: tlErr } = await db.rpc('gini_sync_timeline', {
      p_gini_patient_id: giniPatientId,
      p_source_id: `gini-visit-${visit.id || visit.visit_id || visit.consultation_id}`,
      p_title: `Visit: ${doctor?.name || doctor?.con_name || visit.doctor_name || visit.con_name || 'Gini Hospital'} — ${meds.length} medications`,
      p_event_date: visit.visit_date || new Date().toISOString().split('T')[0],
      p_icon: '\u{1F3E5}',
    });
    if (tlErr) errors.push({ step: 'timeline', error: tlErr.message });
// 9. Sync doctor-recorded vitals
if (visit.vitals) {
  const v = visit.vitals;

  const { error } = await db.rpc('gini_sync_vitals', {
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
  });
    console.log("[Genie Sync] Vitals synced:", v);
  if (error) {
    errors.push({ step: 'vitals', error: error.message });
  }
}

    console.log(`[Genie Sync] Patient ${giniPatientId}: ${meds.length} meds, ${labs.length} labs, ${diagnoses.length} conditions. Errors: ${errors.length}`);


    return { synced: true, errors, mhgPatientId: mhgId };

  } catch (e) {
    console.error('[Genie Sync] Fatal:', e.message);
    return { synced: false, reason: e.message, errors };
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
  if (senderRole) {
    // Messages from the patient targeting a specific team inbox.
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
 * Get full message thread for a patient (both directions)
 */
async function getThreadFromGenie(patientId) {
  const db = getGenieDb();
  if (!db) return [];

  const { data, error } = await db
    .from('patient_messages')
    .select('*')
    .eq('patient_id', String(patientId))
    .order('created_at', { ascending: true });

  if (error) { console.error('[Genie Thread] Error:', error.message); return []; }
  return data || [];
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
    const { data, error } = await db
      .from("patients")
      .select("id")
      .eq("gini_patient_id", String(giniPatientId))
      .maybeSingle();

    if (error) {
      console.error("[Genie Resolve Patient] Error:", error.message);
      return null;
    }

    return data?.id || null;

  } catch (err) {
    console.error("[Genie Resolve Patient] Exception:", err);
    return null;
  }
}


/**
 * Sync patient logs FROM Genie → Local PostgreSQL
 */
async function syncPatientLogsFromGenie(scribePatientId, localDb) {
  const db = getGenieDb();
  if (!db) return { synced: false, reason: "No Genie credentials" };

  try {

    const genieUUID = await resolveGeniePatientId(scribePatientId);

    if (!genieUUID) {
      return {
        synced: false,
        reason: "Genie patient not found"
      };
    }

    // Fetch all logs in parallel
    const [
      vitalsRes,
      activityRes,
      symptomRes,
      medRes,
      mealRes
    ] = await Promise.all([

      db.from("vitals")
        .select("*")
        .eq("patient_id", genieUUID)
        .or("source.is.null,source.not.in.(doctor,scribe)")
        .order("recorded_date", { ascending: false })
        .limit(500),

      db.from("activity_logs")
        .select("*")
        .eq("patient_id", genieUUID)
        .order("log_date", { ascending: false })
        .limit(500),

      db.from("symptom_logs")
        .select("*")
        .eq("patient_id", genieUUID)
        .order("log_date", { ascending: false })
        .limit(500),

      db.from("medication_logs")
        .select(`
          *,
          medications (
            name,
            dose
          )
        `)
        .eq("patient_id", genieUUID)
        .order("log_date", { ascending: false })
        .limit(500),

      db.from("meal_logs")
        .select("*")
        .eq("patient_id", genieUUID)
        .order("log_date", { ascending: false })
        .limit(500)

    ]);

    const vitals = vitalsRes.data || [];
    const activities = activityRes.data || [];
    const symptoms = symptomRes.data || [];
    const meds = medRes.data || [];
    const meals = mealRes.data || [];


    // -------------------------
    // Vitals UPSERT
    // -------------------------

    for (const v of vitals) {
      await localDb.query(`
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
        scribePatientId,
        v.id,
        v.recorded_date,
        v.reading_time,
        v.bp_systolic,
        v.bp_diastolic,
        v.rbs,
        v.meal_type,
        v.weight_kg,
        v.pulse,
        v.spo2,
        v.body_fat,
        v.muscle_mass,
        v.bmi,
        v.waist,
        v.created_at
      ]);
    }


    // -------------------------
    // Activity UPSERT
    // -------------------------

    for (const a of activities) {
      await localDb.query(`
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
        scribePatientId,
        a.id,
        a.activity_type,
        a.value,
        a.value2,
        a.context,
        a.duration_minutes,
        a.mood_score,
        a.log_date,
        a.log_time,
        a.created_at
      ]);
    }


    // -------------------------
    // Symptoms UPSERT
    // -------------------------

    for (const s of symptoms) {
      await localDb.query(`
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
        scribePatientId,
        s.id,
        s.symptom,
        s.severity,
        s.body_area,
        s.context,
        s.notes,
        s.follow_up_needed,
        s.log_date,
        s.log_time,
        s.created_at
      ]);
    }


    // -------------------------
    // Medications UPSERT
    // -------------------------

    for (const m of meds) {
      await localDb.query(`
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
        scribePatientId,
        m.id,
        m.medications?.name || null,
        m.medications?.dose || null,
        m.genie_medication_id,
        m.log_date,
        m.dose_time,
        m.status,
        m.created_at
      ]);
    }


    // -------------------------
    // Meals UPSERT
    // -------------------------

    for (const m of meals) {
      await localDb.query(`
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
        scribePatientId,
        m.id,
        m.meal_type,
        m.description,
        m.calories,
        m.protein_g,
        m.carbs_g,
        m.fat_g,
        m.log_date,
        m.created_at
      ]);
    }


    return {
      synced: true,
      counts: {
        vitals: vitals.length,
        activities: activities.length,
        symptoms: symptoms.length,
        medications: meds.length,
        meals: meals.length
      }
    };

  } catch (err) {

    console.error("[Genie Log Sync] Error:", err);

    return {
      synced: false,
      reason: err.message
    };

  }
}


module.exports = {
  syncVisitToGenie, sendAlertToGenie, getAlertsFromGenie,
  getMessagesFromGenie, sendReplyToGenie, getThreadFromGenie, markMessageReadInGenie, resolveGeniePatientId,
  syncPatientLogsFromGenie
};
