/**
 * One-shot: hard re-sync the patient-app (Genie) side for TEST_COMPANION_USER.
 *
 *   1. Wipe Genie child rows (vitals, labs, meds, conditions, goals, appts,
 *      timeline, care_team, alert_channel, conversations + messages,
 *      activity_logs, meal_logs, symptom_logs, documents, reminders, etc.)
 *      — keeps the patients row so the patient stays logged in.
 *   2. Re-link/create the Genie patients row from scribe profile.
 *   3. Push every scribe-side data set: diagnoses, medications, labs,
 *      documents, next appointment, care team (doctor name).
 *   4. Print before/after row counts on the Genie side.
 *
 * Run:
 *   node server/scripts/resync-test-companion-app.mjs
 *   node server/scripts/resync-test-companion-app.mjs --file-no FOO
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const {
  getGenieDb,
  syncPatientToGenie,
  resolveGeniePatientId,
  syncDiagnosesToGenie,
  syncMedicationsToGenie,
  syncLabsToGenie,
  syncDocumentsToGenie,
  syncAppointmentToGenie,
  syncCareTeamToGenie,
  syncVitalsRowToGenie,
} = require("../genie-sync.cjs");

const fileNoIdx = process.argv.indexOf("--file-no");
const FILE_NO = fileNoIdx > -1 ? process.argv[fileNoIdx + 1] : "TEST_COMPANION_USER";

// Same set delete-test-patient.js wipes, minus the patients row.
const GENIE_CHILD_TABLES = [
  "medications",
  "lab_results",
  "conditions",
  "goals",
  "appointments",
  "vitals",
  "timeline_events",
  "care_team",
  "alert_channel",
  "patient_messages",
  "conversations",
  "activity_logs",
  "meal_logs",
  "symptom_logs",
  "vitals_logs",
  "chat_messages",
  "patient_documents",
  "documents",
  "reminders",
  "notifications",
];

async function clearGenieChildren(db, genieUUID) {
  // medication_logs FKs medication_id, not patient_id — clear before medications
  try {
    const { data: meds } = await db
      .from("medications")
      .select("id")
      .eq("patient_id", genieUUID);
    if (meds?.length) {
      const ids = meds.map((m) => m.id);
      const { data: logs, error } = await db
        .from("medication_logs")
        .delete()
        .in("medication_id", ids)
        .select("id");
      if (error) console.warn(`  medication_logs        — skip (${error.message})`);
      else console.log(`  genie.medication_logs   deleted ${logs?.length || 0}`);
    }
  } catch (e) {
    console.warn(`  medication_logs        — skip (${e.message})`);
  }

  let total = 0;
  for (const t of GENIE_CHILD_TABLES) {
    try {
      const { data, error } = await db
        .from(t)
        .delete()
        .eq("patient_id", genieUUID)
        .select("id");
      if (error) {
        console.warn(`  ${t.padEnd(22)} — skip (${error.message})`);
        continue;
      }
      const n = data?.length || 0;
      console.log(`  genie.${t.padEnd(18)} deleted ${n}`);
      total += n;
    } catch (e) {
      console.warn(`  ${t.padEnd(22)} — skip (${e.message})`);
    }
  }
  console.log(`  genie children total    ${total}`);
  return total;
}

async function genieCounts(db, genieUUID) {
  const out = {};
  for (const t of [
    "medications",
    "lab_results",
    "conditions",
    "goals",
    "appointments",
    "vitals",
    "patient_documents",
  ]) {
    try {
      const { count, error } = await db
        .from(t)
        .select("*", { count: "exact", head: true })
        .eq("patient_id", genieUUID);
      out[t] = error ? `err:${error.message}` : count ?? 0;
    } catch (e) {
      out[t] = `err:${e.message}`;
    }
  }
  return out;
}

async function main() {
  const db = getGenieDb();
  if (!db) {
    console.error("GENIE_SUPABASE_URL / GENIE_SUPABASE_SERVICE_KEY not set in server/.env");
    process.exit(1);
  }

  const p = await pool.query(
    "SELECT id, name, file_no, phone, dob, sex, blood_group FROM patients WHERE file_no=$1",
    [FILE_NO],
  );
  if (p.rows.length === 0) {
    console.error(`No scribe patient with file_no=${FILE_NO}. Run create-test-patient.js first.`);
    process.exit(1);
  }
  const sp = p.rows[0];
  console.log(
    `Scribe patient: id=${sp.id}  file_no=${sp.file_no}  name=${sp.name}  phone=${sp.phone}`,
  );

  // 1. Ensure Genie patient row (idempotent — gini_link_patient upserts).
  console.log("\n[1/4] Ensuring Genie patient row (gini_link_patient)…");
  const linkRes = await syncPatientToGenie(sp);
  if (!linkRes.synced) {
    console.error(`  link failed: ${linkRes.reason}`);
    process.exit(1);
  }
  console.log(`  ok — mhgPatientId=${linkRes.mhgPatientId}`);

  const genieUUID = await resolveGeniePatientId(sp.id);
  if (!genieUUID) {
    console.error("Could not resolve Genie UUID after link. Aborting.");
    process.exit(1);
  }
  console.log(`  Genie UUID: ${genieUUID}`);

  // 2. Snapshot before.
  const before = await genieCounts(db, genieUUID);
  console.log("\nBEFORE (Genie):", before);

  // 3. Wipe Genie child rows.
  console.log("\n[2/4] Clearing Genie child rows…");
  await clearGenieChildren(db, genieUUID);

  const cleared = await genieCounts(db, genieUUID);
  console.log("\nAFTER WIPE (Genie):", cleared);

  // 4. Push every scribe-side data set.
  console.log("\n[3/4] Pushing scribe data to Genie…");
  const [dx, meds, labs, docs, appt, ct] = await Promise.all([
    syncDiagnosesToGenie(sp.id, pool).catch((e) => ({ errors: [{ error: e.message }] })),
    syncMedicationsToGenie(sp.id, pool).catch((e) => ({ errors: [{ error: e.message }] })),
    syncLabsToGenie(sp.id, pool).catch((e) => ({ errors: [{ error: e.message }] })),
    syncDocumentsToGenie(sp.id, pool).catch((e) => ({ errors: [{ error: e.message }] })),
    syncAppointmentToGenie(sp.id, pool).catch((e) => ({ errors: [{ error: e.message }] })),
    syncCareTeamToGenie(sp.id, pool).catch((e) => ({ errors: [{ error: e.message }] })),
  ]);
  console.log("  diagnoses:    ", JSON.stringify(dx));
  console.log("  medications:  ", JSON.stringify(meds));
  console.log("  labs:         ", JSON.stringify(labs));
  console.log("  documents:    ", JSON.stringify(docs));
  console.log("  appointment:  ", JSON.stringify(appt));
  console.log("  care_team:    ", JSON.stringify(ct));

  // Appointment-biomarkers: scribe /visit synthesizes extra lab_history rows
  // from appointments.biomarkers (HbA1c/FBS/LDL/TSH/Hb/etc. typed into a visit
  // form without a separate lab report). Push the same set to Genie so the
  // app's biomarker trends match the website 1:1.
  const LAB_MAP = {
    hba1c: { test_name: 'HbA1c', panel: 'Diabetes', unit: '%', canonical: 'HbA1c' },
    fg: { test_name: 'Fasting Glucose', panel: 'Diabetes', unit: 'mg/dL', canonical: 'FBS' },
    ldl: { test_name: 'LDL', panel: 'Lipid Profile', unit: 'mg/dL', canonical: 'LDL' },
    tg: { test_name: 'Triglycerides', panel: 'Lipid Profile', unit: 'mg/dL', canonical: 'Triglycerides' },
    uacr: { test_name: 'UACR', panel: 'Renal', unit: 'mg/g', canonical: 'UACR' },
    creatinine: { test_name: 'Creatinine', panel: 'Renal', unit: 'mg/dL', canonical: 'Creatinine' },
    tsh: { test_name: 'TSH', panel: 'Thyroid', unit: 'mIU/L', canonical: 'TSH' },
    hb: { test_name: 'Hemoglobin', panel: 'CBC', unit: 'g/dL', canonical: 'Haemoglobin' },
  };
  const dayOf = (d) => (d ? String(d).slice(0, 10) : null);
  const apptBio = await pool.query(
    `SELECT id, appointment_date::text AS d, biomarkers
       FROM appointments
      WHERE patient_id=$1 AND biomarkers IS NOT NULL AND appointment_date IS NOT NULL
      ORDER BY appointment_date ASC, created_at ASC`,
    [sp.id],
  );
  // Existing lab_results (canonical + date) to skip duplicates.
  const existing = await pool.query(
    `SELECT canonical_name, test_date::text AS test_date FROM lab_results WHERE patient_id=$1`,
    [sp.id],
  );
  const haveKey = new Set(existing.rows.map((r) => `${r.canonical_name}|${dayOf(r.test_date)}`));
  // HealthRay copies biomarker values forward into every appt; honour only the
  // first appearance of each (canonical, value) carry-forward (matches visit.js).
  const firstSeenCarry = new Set();
  let bioPushed = 0;
  const bioErrors = [];
  for (const row of apptBio.rows) {
    const bio = row.biomarkers || {};
    const labDates = bio._lab_dates || {};
    for (const [bioKey, meta] of Object.entries(LAB_MAP)) {
      const raw = bio[bioKey];
      if (raw == null) continue;
      const v = parseFloat(raw);
      if (!Number.isFinite(v)) continue;
      const labDate = labDates[bioKey];
      let date;
      if (labDate) {
        date = labDate;
      } else {
        const ckey = `${meta.canonical}|${v}`;
        if (firstSeenCarry.has(ckey)) continue;
        firstSeenCarry.add(ckey);
        date = row.d;
      }
      const dKey = dayOf(date);
      if (haveKey.has(`${meta.canonical}|${dKey}`)) continue;
      haveKey.add(`${meta.canonical}|${dKey}`);
      const sourceId = `gini-appt-bio-${row.id}-${bioKey}`;
      const { error } = await db.rpc('gini_sync_lab', {
        p_gini_patient_id: String(sp.id),
        p_source_id: sourceId,
        p_test_name: meta.test_name,
        p_value: v,
        p_unit: meta.unit,
        p_reference_range: null,
        p_status: 'normal',
        p_test_date: dKey,
        p_lab_name: meta.panel,
      });
      if (error) bioErrors.push({ key: bioKey, date: dKey, error: error.message });
      else bioPushed++;
    }
  }
  console.log(`  appt_bio:     {"pushed":${bioPushed},"errors":${bioErrors.length}}`);
  if (bioErrors.length) console.log("    appt_bio errors:", bioErrors);

  // Vitals: no batch helper, iterate scribe rows via syncVitalsRowToGenie.
  const vRows = await pool.query(
    `SELECT id, recorded_at, bp_sys, bp_dia, pulse, spo2, weight, height, temp, rbs, meal_type
       FROM vitals WHERE patient_id=$1 ORDER BY recorded_at`,
    [sp.id],
  );
  let vPushed = 0;
  const vErrors = [];
  for (const row of vRows.rows) {
    const r = await syncVitalsRowToGenie(sp.id, row).catch((e) => ({ synced: false, reason: e.message }));
    if (r?.synced) vPushed++;
    else vErrors.push({ id: row.id, reason: r?.reason });
  }
  console.log(`  vitals:       {"pushed":${vPushed},"total":${vRows.rows.length},"errors":${vErrors.length}}`);
  if (vErrors.length) console.log("    vitals errors:", vErrors);

  // Patient-origin vitals: rows in patient_vitals_log were originally inserted
  // into Genie `vitals` from the app's LogModal. Wiping Genie vitals removed
  // them; re-create as `source='patient'` rows so the app sees its own logs
  // again. Update patient_vitals_log.genie_id to the new UUID so the next
  // pull doesn't insert duplicates.
  const pvl = await pool.query(
    `SELECT id, recorded_date::text AS recorded_date, reading_time, bp_systolic, bp_diastolic,
            pulse, spo2, weight_kg, rbs, meal_type, created_at
       FROM patient_vitals_log
      WHERE patient_id=$1
      ORDER BY recorded_date, id`,
    [sp.id],
  );
  let pvlPushed = 0;
  const pvlErrors = [];
  for (const row of pvl.rows) {
    const payload = {
      patient_id: genieUUID,
      recorded_date: row.recorded_date,
      reading_time: row.reading_time || null,
      bp_systolic: row.bp_systolic ?? null,
      bp_diastolic: row.bp_diastolic ?? null,
      pulse: row.pulse ?? null,
      spo2: row.spo2 ?? null,
      weight_kg: row.weight_kg ?? null,
      rbs: row.rbs ?? null,
      meal_type: row.meal_type || null,
      source: 'patient',
      source_id: `gini-pvl-${row.id}`,
      created_at: row.created_at?.toISOString?.() ?? row.created_at ?? null,
    };
    let newId = null;
    const up = await db
      .from('vitals')
      .upsert(payload, { onConflict: 'source_id' })
      .select('id')
      .single();
    if (up.error) {
      const ins = await db.from('vitals').insert(payload).select('id').single();
      if (ins.error) { pvlErrors.push({ id: row.id, error: ins.error.message }); continue; }
      newId = ins.data?.id;
    } else {
      newId = up.data?.id;
    }
    if (newId) {
      await pool.query(
        `UPDATE patient_vitals_log SET genie_id=$1 WHERE id=$2`,
        [newId, row.id],
      );
      pvlPushed++;
    }
  }
  console.log(`  pvl_vitals:   {"pushed":${pvlPushed},"total":${pvl.rows.length},"errors":${pvlErrors.length}}`);
  if (pvlErrors.length) console.log("    pvl errors:", pvlErrors.slice(0, 5));

  // 5. Snapshot after.
  console.log("\n[4/4] Verifying…");
  const after = await genieCounts(db, genieUUID);
  console.log("AFTER PUSH (Genie):", after);

  const totalErrs =
    (dx.errors?.length || 0) +
    (meds.errors?.length || 0) +
    (labs.errors?.length || 0) +
    (docs.errors?.length || 0) +
    (appt.errors?.length || 0) +
    (ct.errors?.length || 0) +
    vErrors.length +
    bioErrors.length +
    pvlErrors.length;
  console.log(`\nDone. push errors=${totalErrs}`);
  if (totalErrs > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
