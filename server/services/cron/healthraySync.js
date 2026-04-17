// ── HealthRay → Gini Scribe sync orchestrator ──────────────────────────────

import {
  fetchDoctors,
  fetchAppointments,
  fetchClinicalNotes,
  fetchMedicalRecords,
  fetchPreviousAppointmentData,
} from "../healthray/client.js";
import { extractClinicalText, parseClinicalWithAI } from "../healthray/parser.js";
import {
  calcAge,
  buildName,
  mapGender,
  mapVisitType,
  mapStatus,
  extractTimeSlot,
  toISTDate,
  buildCompliance,
} from "../healthray/mappers.js";
import {
  ensureSyncColumns,
  findAppointment,
  findAppointmentWithNotes,
  upsertPatient,
  syncDoctors,
  upsertAppointment,
  syncLabResults,
  syncMedications,
  syncDiagnoses,
  syncStoppedMedications,
  stopStaleHealthrayMeds,
  syncDocuments,
  syncVitals,
  syncSymptoms,
  syncBiomarkersFromLatestLabs,
  markAppointmentAsSeen,
  markAppointmentAsCheckedIn,
} from "../healthray/db.js";
import { createLogger } from "../logger.js";
const { log, error } = createLogger("HealthRay Sync");

// ── Build patient data from HealthRay appointment ───────────────────────────
function buildPatientData(appt) {
  const fm = appt.family_member || {};
  const pat = appt.patient || {};

  const addr = pat.address || appt.address || {};
  const addressParts = [
    addr.house_no,
    addr.street_address,
    addr.address1,
    addr.city,
    addr.state,
    addr.zipcode,
  ].filter((p) => p && p !== "null");

  let dob = null;
  if (fm.birth_date) {
    const [dd, mm, yyyy] = fm.birth_date.split("-").map(Number);
    if (dd && mm && yyyy)
      dob = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  return {
    name: buildName(fm),
    phone: pat.mobile_no || null,
    fileNo: appt.patient_case_id || null,
    sex: mapGender(fm.gender),
    age: calcAge(fm.birth_date),
    address: addressParts.length > 0 ? addressParts.join(", ") : null,
    dob,
    email: pat.email || null,
    bloodGroup: fm.blood_group || null,
    abhaId: fm.abha_health_number || null,
    healthId: fm.healthray_id || null,
  };
}

// ── Build vitals & biomarkers from appointment data ─────────────────────────
function buildVitalsAndBiomarkers(appt) {
  let weight = null,
    height = null,
    bmi = null;
  try {
    weight = JSON.parse(appt.weight || "{}").weight || null;
  } catch {}
  try {
    height = JSON.parse(appt.height || "{}").height || null;
  } catch {}
  if (weight && height) bmi = +(weight / (height / 100) ** 2).toFixed(2);

  const opdVitals = {};
  if (weight) opdVitals.weight = weight;
  if (height) opdVitals.height = height;
  if (bmi) opdVitals.bmi = bmi;

  const biomarkers = {};
  if (appt.followup_days) biomarkers.followup = appt.followup_days.split("T")[0];
  if (appt.rmo_doctor) biomarkers.rmo = appt.rmo_doctor;
  if (appt.reason) biomarkers.reason = appt.reason;
  if (appt.tag) biomarkers.tag = appt.tag;
  if (appt.engaged_start) biomarkers.engagedStart = appt.engaged_start;
  if (appt.engaged_end) biomarkers.engagedEnd = appt.engaged_end;
  if (appt.appointment_number) biomarkers.appointmentNumber = appt.appointment_number;
  if (weight) biomarkers.weight = weight;

  return { opdVitals, biomarkers };
}

// ── Fetch clinical text — handles show_previous_appointment fallback ────────
async function fetchClinicalText(appt, healthrayId, doctorId) {
  const clinicalData = await fetchClinicalNotes(healthrayId, doctorId);

  // One-shot debug dump: set HEALTHRAY_DUMP_RAW=1 and optionally
  // HEALTHRAY_DUMP_PATIENT=<file_no> (e.g. P_174857) to print the raw
  // clinical-notes + medical-records payload for a single patient. Used to
  // locate where Diagnosis summary text lives on a given visit's JSON.
  if (process.env.HEALTHRAY_DUMP_RAW === "1") {
    const wantFileNo = process.env.HEALTHRAY_DUMP_PATIENT || "";
    const thisFileNo = appt.patient_case_id || "";
    if (!wantFileNo || wantFileNo === thisFileNo) {
      log(
        "DumpRaw",
        `${thisFileNo || healthrayId} clinicalData:\n${JSON.stringify(clinicalData, null, 2)}`,
      );
      try {
        const records = await fetchMedicalRecords(healthrayId);
        log(
          "DumpRaw",
          `${thisFileNo || healthrayId} medicalRecords:\n${JSON.stringify(records, null, 2)}`,
        );
      } catch (e) {
        log("DumpRaw", `${thisFileNo || healthrayId} medicalRecords fetch failed: ${e.message}`);
      }
    }
  }

  if (!clinicalData || !Array.isArray(clinicalData)) return null;

  const selCount = clinicalData.reduce(
    (sum, m) =>
      sum + (m.categories || []).reduce((s, c) => s + (c.topics?.selected?.length || 0), 0),
    0,
  );

  // If 0 selected topics and show_previous_appointment, get from previous appointment
  let effectiveData = clinicalData;
  if (selCount === 0 && appt.show_previous_appointment) {
    const patientHrId = appt.patient?.id || appt.self_user_id;
    if (patientHrId) {
      try {
        const prevData = await fetchPreviousAppointmentData(healthrayId, patientHrId, doctorId);
        if (prevData?.[0]?.menus?.length > 0) {
          log(
            "Enrich",
            `${healthrayId}: Using previous appointment data (${prevData[0].menus.length} menus)`,
          );
          effectiveData = prevData[0].menus;
        }
      } catch {}
    }
    // DB fallback
    if (effectiveData === clinicalData) {
      const fileNo = appt.patient_case_id;
      const phone = appt.patient?.mobile_no;
      if (fileNo || phone) {
        const { rows } = await findAppointmentWithNotes(fileNo, phone, healthrayId);
        if (rows?.[0]?.healthray_id) {
          try {
            const prevNotes = await fetchClinicalNotes(rows[0].healthray_id, doctorId);
            const prevSel = (prevNotes || []).reduce(
              (sum, m) =>
                sum +
                (m.categories || []).reduce((s, c) => s + (c.topics?.selected?.length || 0), 0),
              0,
            );
            if (prevSel > 0) {
              log("Enrich", `${healthrayId}: Using DB previous appt ${rows[0].healthray_id}`);
              effectiveData = prevNotes;
            }
          } catch {}
        }
      }
    }
  }

  const sections = extractClinicalText(effectiveData);

  return Object.values(sections).join("\n\n---\n\n");
}

// ── Sync documents for an appointment ───────────────────────────────────────
async function syncAppointmentDocs(healthrayId, patientId, apptDate) {
  try {
    const records = await fetchMedicalRecords(healthrayId);
    if (records?.length > 0) await syncDocuments(patientId, records, apptDate, healthrayId);
  } catch {}
}

// ── Sync a single appointment ───────────────────────────────────────────────
async function syncAppointment(appt, localDoctorName) {
  const healthrayId = String(appt.id);
  const doctorId = appt.doctor_id || appt.doctor?.id;
  const apptDate = toISTDate(appt.app_date_time);
  const fileNo = appt.patient_case_id || null;
  const existing = await findAppointment(healthrayId, fileNo, apptDate);
  const status = mapStatus(appt.status);
  const isCompleted = status === "completed";

  // ── FAST PATH: completed appointment with notes — only sync new docs ──
  // Skip re-enrichment ONLY if diagnoses AND medications were already extracted.
  // If either JSONB is empty despite having notes, fall through to re-parse.
  const alreadyEnriched =
    existing?.healthray_diagnoses?.length > 0 && existing?.healthray_medications?.length > 0;
  if (existing && isCompleted && existing.healthray_clinical_notes && alreadyEnriched) {
    if (existing.patient_id) await syncAppointmentDocs(healthrayId, existing.patient_id, apptDate);
    // Auto-mark as seen if not already done
    await markAppointmentAsSeen(existing.id);
    return { skipped: true, id: existing.id };
  }

  // ── Build patient & vitals ──
  const patientData = buildPatientData(appt);
  const patientId = await upsertPatient(patientData);
  const { opdVitals, biomarkers } = buildVitalsAndBiomarkers(appt);

  // ── Fetch clinical text ──
  // API calls: 1 fetchClinicalNotes + (maybe 1 fetchPreviousAppointmentData if show_previous)
  let clinical = {
    clinicalRaw: null,
    parsedClinical: null,
    healthrayDiagnoses: [],
    healthrayMedications: [],
    healthrayStoppedMedications: [],
    healthrayLabs: [],
    healthrayAdvice: null,
    healthrayInvestigations: [],
    healthrayFollowUp: null,
  };

  if (doctorId) {
    try {
      const rawText = await fetchClinicalText(appt, healthrayId, doctorId);

      if (rawText && rawText.trim().length > 20) {
        // Skip AI if text unchanged
        if (rawText === (existing?.healthray_clinical_notes || "")) {
          await syncAppointmentDocs(healthrayId, patientId, apptDate);
          return { skipped: true, id: existing.id };
        }

        // Parse with AI
        const parsed = await parseClinicalWithAI(rawText);
        clinical.clinicalRaw = rawText;
        if (parsed) {
          clinical.parsedClinical = parsed;
          clinical.healthrayDiagnoses = parsed.diagnoses || [];
          clinical.healthrayMedications = parsed.medications || [];
          clinical.healthrayStoppedMedications = parsed.previous_medications || [];
          clinical.healthrayLabs = parsed.labs || [];
          clinical.healthrayAdvice = parsed.advice || null;
          clinical.healthrayInvestigations = parsed.investigations_to_order || [];
          clinical.healthrayFollowUp = parsed.follow_up || null;

          // Merge vitals — parseFloat to strip units like "137 mmHg" → 137
          const v = parsed.vitals || {};
          const cleanNum = (val) => {
            const n = parseFloat(val);
            return isNaN(n) ? null : n;
          };
          if (v.height && !opdVitals.height) {
            const n = cleanNum(v.height);
            if (n) opdVitals.height = n;
          }
          if (v.weight && !opdVitals.weight) {
            const n = cleanNum(v.weight);
            if (n) opdVitals.weight = n;
          }
          if (v.bmi && !opdVitals.bmi) {
            const n = cleanNum(v.bmi);
            if (n) opdVitals.bmi = n;
          }
          if (v.bpSys) {
            const n = cleanNum(v.bpSys);
            if (n) opdVitals.bpSys = n;
          }
          if (v.bpDia) {
            const n = cleanNum(v.bpDia);
            if (n) opdVitals.bpDia = n;
          }
          if (v.waist) {
            const n = cleanNum(v.waist);
            if (n) opdVitals.waist = n;
          }
          if (v.bodyFat) {
            const n = cleanNum(v.bodyFat);
            if (n) opdVitals.bodyFat = n;
          }

          if (opdVitals.weight) biomarkers.weight = opdVitals.weight;
          if (opdVitals.waist) biomarkers.waist = opdVitals.waist;
          if (opdVitals.bpSys) biomarkers.bpSys = opdVitals.bpSys;
          if (opdVitals.bpDia) biomarkers.bpDia = opdVitals.bpDia;

          // Lab values (hba1c, fg, ldl, etc.) are synced to lab_results by syncLabResults()
          // and then merged into appointments.biomarkers by syncBiomarkersFromLatestLabs().
          // No direct mapLabsToBiomarkers() call needed — avoids duplicate writes.

          log(
            "Enrich",
            `${healthrayId}: ${clinical.healthrayDiagnoses.length} dx, ${clinical.healthrayLabs.length} labs, ${clinical.healthrayMedications.length} meds`,
          );
        }
      }
    } catch (e) {
      error("Enrich", `${healthrayId}: ${e.message}`);
    }
  }

  // ── Build compliance ──
  const compliance = buildCompliance(
    clinical.parsedClinical,
    clinical.healthrayMedications,
    clinical.healthrayAdvice,
  );
  if (Object.keys(compliance).length > 0) {
    log("Compliance", `${healthrayId}: ${Object.keys(compliance).join(",")}`);
  }

  // ── Stamp source & prescription date on vitals so UI can show origin ──
  if (Object.keys(opdVitals).length > 0) {
    opdVitals._source = "healthray";
    opdVitals._prescriptionDate = apptDate; // date the prescription carrying these vitals is from
  }

  // ── Save appointment ──
  const localApptId = await upsertAppointment(existing?.id || null, {
    patientId,
    name: appt.patient_name || patientData.name,
    fileNo: patientData.fileNo,
    phone: patientData.phone,
    localDoctorName,
    apptDate,
    timeSlot: extractTimeSlot(appt.app_date_time),
    visitType: mapVisitType(appt.reason),
    status,
    isWalkin: appt.tag === "Walk-in" || appt.booking_type === "Walk-in",
    age: patientData.age,
    sex: patientData.sex,
    notes: [appt.reason, appt.rmo_doctor ? `RMO: ${appt.rmo_doctor}` : null]
      .filter(Boolean)
      .join(" | "),
    healthrayId,
    opdVitals,
    biomarkers,
    compliance,
    clinicalRaw: clinical.clinicalRaw,
    healthrayDiagnoses: clinical.healthrayDiagnoses,
    healthrayMedications: clinical.healthrayMedications,
    healthrayPreviousMedications: clinical.healthrayStoppedMedications,
    healthrayLabs: clinical.healthrayLabs,
    healthrayAdvice: clinical.healthrayAdvice,
    healthrayInvestigations: clinical.healthrayInvestigations,
    healthrayFollowUp: clinical.healthrayFollowUp,
  });
  // ── Sync to normalized tables + documents ──
  await syncVitals(patientId, localApptId, apptDate, opdVitals);
  await syncLabResults(patientId, localApptId, apptDate, clinical.healthrayLabs);
  await syncBiomarkersFromLatestLabs(patientId, localApptId);
  await syncMedications(patientId, healthrayId, apptDate, clinical.healthrayMedications);
  await syncStoppedMedications(
    patientId,
    healthrayId,
    clinical.healthrayStoppedMedications,
    clinical.healthrayMedications,
  );
  await stopStaleHealthrayMeds(patientId, healthrayId, apptDate);
  await syncDiagnoses(patientId, healthrayId, clinical.healthrayDiagnoses);
  await syncSymptoms(patientId, localApptId, clinical.parsedClinical?.symptoms);
  await syncAppointmentDocs(healthrayId, patientId, apptDate);

  // ── Auto-mark status based on HealthRay data ──
  if (isCompleted && clinical.healthrayDiagnoses?.length > 0) {
    // Prescription exists → mark as "seen" (creates consultation + fills prep steps)
    await markAppointmentAsSeen(localApptId);
  } else if (!isCompleted && status !== "cancelled" && status !== "no_show") {
    // Appointment exists in HealthRay but no prescription yet → patient checked in
    await markAppointmentAsCheckedIn(localApptId);
  }

  return { skipped: false, id: localApptId, enriched: !!clinical.parsedClinical };
}

// ── Helper: run async tasks with limited concurrency ────────────────────────
async function runBatch(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = await Promise.allSettled(items.slice(i, i + concurrency).map(fn));
    results.push(...batch);
  }
  return results;
}

// ── Run sync for a given date ───────────────────────────────────────────────
// Accepts optional pre-fetched doctors to avoid redundant API calls in range sync
async function runSync(date, prefetched = null) {
  const startTime = Date.now();
  log("Sync", `Starting for ${date}...`);

  try {
    await ensureSyncColumns();

    const rayDoctors = prefetched?.rayDoctors || (await fetchDoctors());
    const doctorMap = prefetched?.doctorMap || (await syncDoctors(rayDoctors));
    if (!prefetched) log("Sync", `${doctorMap.size} doctors mapped`);

    let totalCreated = 0,
      totalSkipped = 0,
      totalEnriched = 0,
      totalErrors = 0;

    const activeDoctors = rayDoctors.filter((doc) => !doc.is_deactivated);

    // Fetch all doctors' appointments in parallel
    const apptFetches = await Promise.allSettled(
      activeDoctors.map(async (doc) => {
        const localName = doctorMap.get(doc.id) || doc.doctor_name;
        const appointments = await fetchAppointments(doc.id, date);
        return { localName, appointments: appointments || [] };
      }),
    );

    // Process each doctor's appointments in batches of 5
    for (const settled of apptFetches) {
      if (settled.status === "rejected") {
        error("Sync", settled.reason?.message);
        continue;
      }
      const { localName, appointments } = settled.value;
      if (!appointments.length) continue;
      log("Sync", `${localName}: ${appointments.length} appointments`);

      const results = await runBatch(appointments, 5, (appt) => syncAppointment(appt, localName));
      for (const r of results) {
        if (r.status === "rejected") {
          totalErrors++;
          error("Sync", r.reason?.message);
        } else if (r.value.skipped) {
          totalSkipped++;
        } else {
          totalCreated++;
          if (r.value.enriched) totalEnriched++;
        }
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(
      "Sync",
      `Done ${date} in ${elapsed}s — created: ${totalCreated}, enriched: ${totalEnriched}, skipped: ${totalSkipped}, errors: ${totalErrors}`,
    );

    return { date, totalCreated, totalEnriched, totalSkipped, totalErrors };
  } catch (e) {
    error("Sync", `Fatal: ${e.message}`);
    throw e;
  }
}

// ── Date-range backfill ─────────────────────────────────────────────────────
// Runs in the background; caller gets a status object to poll via rangeStatus.
const rangeStatus = { running: false, from: null, to: null, done: 0, total: 0, errors: 0 };

export function getRangeSyncStatus() {
  return { ...rangeStatus };
}

export async function syncDateRange(from, to) {
  if (rangeStatus.running) throw new Error("Range sync already in progress");

  // Build list of dates (inclusive)
  const dates = [];
  const cursor = new Date(from);
  const end = new Date(to);
  while (cursor <= end) {
    dates.push(cursor.toISOString().split("T")[0]);
    cursor.setDate(cursor.getDate() + 1);
  }

  Object.assign(rangeStatus, { running: true, from, to, done: 0, total: dates.length, errors: 0 });
  log("Range", `Starting backfill ${from} → ${to} (${dates.length} days)`);

  // Run async in background — don't await
  (async () => {
    // Fetch doctors once for the entire range — avoids 450 redundant API calls
    const rayDoctors = await fetchDoctors();
    const doctorMap = await syncDoctors(rayDoctors);
    const prefetched = { rayDoctors, doctorMap };
    log("Range", `${doctorMap.size} doctors cached for range`);

    // Process 3 dates concurrently
    for (let i = 0; i < dates.length; i += 3) {
      const batch = dates.slice(i, i + 3);
      await Promise.allSettled(
        batch.map(async (date) => {
          try {
            await runSync(date, prefetched);
          } catch (e) {
            error("Range", `${date}: ${e.message}`);
            rangeStatus.errors++;
          }
          rangeStatus.done++;
        }),
      );
    }
    log("Range", `Backfill complete — ${dates.length} days, ${rangeStatus.errors} errors`);
    rangeStatus.running = false;
  })();

  return { started: true, total: dates.length };
}

// ── Daily OPD re-parse: fixes diagnoses + medicines for today's patients ─────
// Re-parses clinical notes for all patients with today's appointments.
// Corrects stale "Absent" diagnoses in JSONB and keeps normalized tables current.
// Runs once per day — does NOT use the fast-path skip.
import pool from "../../config/db.js";

export async function runDailyOpdBackfill(dateStr) {
  const date = dateStr || toISTDate(new Date().toISOString());
  log("Daily Backfill", `Starting OPD re-parse for ${date}...`);

  const { rows: patients } = await pool.query(
    `SELECT DISTINCT patient_id FROM appointments
     WHERE appointment_date = $1 AND patient_id IS NOT NULL`,
    [date],
  );

  if (!patients.length) {
    log("Daily Backfill", `No patients found for ${date}`);
    return { date, total: 0, done: 0, errors: 0 };
  }

  let done = 0,
    errors = 0,
    fixed = 0;

  for (const { patient_id } of patients) {
    try {
      // Find latest appointment with clinical notes for this patient
      const { rows } = await pool.query(
        `SELECT id, healthray_id, appointment_date, healthray_clinical_notes
         FROM appointments
         WHERE patient_id = $1
           AND healthray_clinical_notes IS NOT NULL
           AND LENGTH(healthray_clinical_notes) > 20
         ORDER BY appointment_date DESC LIMIT 1`,
        [patient_id],
      );

      if (!rows[0]) {
        done++;
        continue;
      }
      const appt = rows[0];

      const parsed = await parseClinicalWithAI(appt.healthray_clinical_notes);
      if (!parsed) {
        errors++;
        done++;
        continue;
      }

      const diagnoses = parsed.diagnoses || [];
      const medications = parsed.medications || [];
      const previousMeds = parsed.previous_medications || [];

      // Update JSONB on appointment
      await pool.query(
        `UPDATE appointments
         SET healthray_diagnoses = $1::jsonb,
             healthray_medications = $2::jsonb,
             updated_at = NOW()
         WHERE id = $3`,
        [JSON.stringify(diagnoses), JSON.stringify(medications), appt.id],
      );

      // Sync to normalized tables
      if (diagnoses.length > 0) {
        await syncDiagnoses(patient_id, appt.healthray_id, diagnoses);
      }
      if (medications.length > 0) {
        await syncMedications(patient_id, appt.healthray_id, appt.appointment_date, medications);
        await stopStaleHealthrayMeds(patient_id, appt.healthray_id, appt.appointment_date);
      }
      if (previousMeds.length > 0) {
        await syncStoppedMedications(patient_id, appt.healthray_id, previousMeds, medications);
      }

      fixed++;
    } catch (e) {
      error("Daily Backfill", `Patient ${patient_id}: ${e.message}`);
      errors++;
    }
    done++;
    // Small delay to avoid connection pressure during long backfill runs
    await new Promise((r) => setTimeout(r, 200));
  }

  log("Daily Backfill", `Done ${date} — ${done} patients, ${fixed} re-parsed, ${errors} errors`);
  return { date, total: patients.length, done, fixed, errors };
}

// ── Public API ──────────────────────────────────────────────────────────────

export function syncWalkingAppointmentsByDate(date) {
  return runSync(date);
}

export function syncWalkingAppointments() {
  return runSync(toISTDate(new Date().toISOString()));
}

export const syncTodayWalkingAppointments = syncWalkingAppointments;
