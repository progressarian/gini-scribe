import pool from "../../config/db.js";

const HEALTHRAY_BASE = "https://node.healthray.com/api/v1";
const HEALTHRAY_LOGIN_URL = "https://node.healthray.com/api/v2/users/sign_in";
const ORG_ID = process.env.HEALTHRAY_ORG_ID || "1528";

// ── Session state — refreshed automatically on 401 ─────────────────────────
let sessionCookie = process.env.HEALTHRAY_SESSION || "";

// ── Ensure sync columns exist ───────────────────────────────────────────────
let columnsReady = false;
async function ensureSyncColumns() {
  if (columnsReady) return;
  await pool.query(`
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS healthray_id TEXT;
    ALTER TABLE doctors
      ADD COLUMN IF NOT EXISTS healthray_id INTEGER;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_healthray
      ON appointments(healthray_id) WHERE healthray_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_healthray
      ON doctors(healthray_id) WHERE healthray_id IS NOT NULL;
  `);
  columnsReady = true;
}

// ── Auto-login to HealthRay and get fresh session cookie ────────────────────
async function healthrayLogin() {
  const mobile = process.env.HEALTHRAY_MOBILE;
  const password = process.env.HEALTHRAY_PASSWORD;
  const captcha = process.env.HEALTHRAY_CAPTCHA;

  if (!mobile || !password || !captcha) {
    throw new Error(
      "HealthRay login credentials missing — set HEALTHRAY_MOBILE, HEALTHRAY_PASSWORD, HEALTHRAY_CAPTCHA in .env",
    );
  }

  console.log("[HealthRay Auth] Session expired, logging in...");

  const res = await fetch(HEALTHRAY_LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      captchaToken: captcha,
      user: {
        mobile_no: mobile,
        password: password,
        platform: "Web",
        user_type: "Doctor",
      },
    }),
  });

  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/connect\.sid=([^;]+)/);
  if (!match) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`HealthRay login failed: ${body.message || "no session cookie returned"}`);
  }

  sessionCookie = match[1];
  console.log("[HealthRay Auth] Login successful, new session obtained");
  return sessionCookie;
}

// ── Cookie-based fetch with auto-relogin on 401 ────────────────────────────
async function healthrayFetch(path, isRetry = false) {
  if (!sessionCookie) {
    await healthrayLogin();
  }

  const res = await fetch(`${HEALTHRAY_BASE}${path}`, {
    headers: { Cookie: `connect.sid=${sessionCookie}` },
  });

  const json = await res.json();

  if (json.status === 401 && !isRetry) {
    await healthrayLogin();
    return healthrayFetch(path, true);
  }

  if (json.status === 401) {
    throw new Error("HealthRay auth failed after re-login — check credentials in .env");
  }
  if (json.status !== 200) {
    throw new Error(`HealthRay API error: ${json.message}`);
  }
  return json.data;
}

// ── API calls ───────────────────────────────────────────────────────────────
function fetchDoctors() {
  return healthrayFetch(`/organization/get_doctors/${ORG_ID}`);
}

function fetchAppointments(doctorId, date, page = 1, perPage = 100) {
  return healthrayFetch(
    `/appointment/data?organization_id=${ORG_ID}&doctor_id=${doctorId}&app_date_time=${date}T00:00:00&page=${page}&per_page=${perPage}`,
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function calcAge(birthDateStr) {
  if (!birthDateStr) return null;
  const [dd, mm, yyyy] = birthDateStr.split("-").map(Number);
  if (!dd || !mm || !yyyy) return null;
  const born = new Date(yyyy, mm - 1, dd);
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  if (
    now.getMonth() < born.getMonth() ||
    (now.getMonth() === born.getMonth() && now.getDate() < born.getDate())
  ) {
    age--;
  }
  return age > 0 ? age : null;
}

function buildName(fm) {
  if (!fm) return "Unknown";
  const parts = [fm.first_name, fm.middle_name, fm.last_name].filter(
    (p) => p && p !== "None" && p !== "." && p !== null,
  );
  return parts.join(" ").replace(/\s+/g, " ").trim() || "Unknown";
}

function mapGender(gender) {
  if (!gender) return null;
  const g = gender.toLowerCase();
  if (g === "male") return "Male";
  if (g === "female") return "Female";
  return "Other";
}

function mapVisitType(reason) {
  if (!reason) return "OPD";
  const r = reason.toLowerCase();
  if (r.includes("follow")) return "Follow-Up";
  if (r.includes("new") || r.includes("first")) return "New Patient";
  if (r.includes("online") || r.includes("tele")) return "Tele";
  return "OPD";
}

function mapStatus(rayStatus) {
  if (!rayStatus) return "scheduled";
  const s = rayStatus.toLowerCase();
  if (s === "checkout" || s === "completed") return "completed";
  if (s === "engaged" || s === "in-progress") return "in-progress";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "no_show" || s === "noshow") return "no_show";
  return "scheduled";
}

function extractTimeSlot(appDateTime) {
  if (!appDateTime) return null;
  const d = new Date(appDateTime);
  // Convert UTC → IST (+5:30)
  const istMs = d.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const h = ist.getUTCHours().toString().padStart(2, "0");
  const m = ist.getUTCMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ── Sync HealthRay doctors → local doctors table ────────────────────────────
async function syncDoctors(rayDoctors) {
  const mapping = new Map();

  for (const rd of rayDoctors) {
    if (rd.is_deactivated) continue;

    const hrid = rd.id;
    const rayName = rd.doctor_name;
    const specialty = rd.specialty_name || null;
    const phone = rd.mobile_no || null;

    let local = await pool.query(`SELECT id, name FROM doctors WHERE healthray_id = $1`, [hrid]);

    if (!local.rows[0] && phone) {
      local = await pool.query(`SELECT id, name FROM doctors WHERE phone = $1`, [phone]);
    }

    if (!local.rows[0]) {
      const stripped = rayName
        .replace(/^Dr\.?\s*/i, "")
        .trim()
        .toLowerCase();
      local = await pool.query(
        `SELECT id, name FROM doctors
         WHERE LOWER(REPLACE(name, 'Dr. ', '')) ILIKE $1
            OR LOWER(short_name) ILIKE $1
         LIMIT 1`,
        [`%${stripped}%`],
      );
    }

    if (local.rows[0]) {
      await pool.query(
        `UPDATE doctors SET healthray_id = $2, specialty = COALESCE(specialty, $3) WHERE id = $1`,
        [local.rows[0].id, hrid, specialty],
      );
      mapping.set(hrid, local.rows[0].name);
    } else {
      const res = await pool.query(
        `INSERT INTO doctors (name, specialty, phone, role, healthray_id, is_active)
         VALUES ($1, $2, $3, 'consultant', $4, true)
         ON CONFLICT DO NOTHING
         RETURNING id, name`,
        [rayName, specialty, phone, hrid],
      );
      if (res.rows[0]) {
        mapping.set(hrid, res.rows[0].name);
        console.log(`[HealthRay Sync] New doctor created: ${rayName}`);
      } else {
        mapping.set(hrid, rayName);
      }
    }
  }

  return mapping;
}

// ── Upsert patient from appointment data ────────────────────────────────────
async function upsertPatient(appt) {
  const fm = appt.family_member || {};
  const pat = appt.patient || {};
  const name = buildName(fm);
  const phone = pat.mobile_no || null;
  const sex = mapGender(fm.gender);
  const age = calcAge(fm.birth_date);
  const fileNo = appt.patient_case_id || null;
  const address = appt.address?.address1 || null;

  const existing = await pool.query(
    `SELECT id, file_no FROM patients
     WHERE ($1::text IS NOT NULL AND file_no = $1)
        OR ($2::text IS NOT NULL AND phone = $2)
     ORDER BY (file_no = $1::text) DESC NULLS LAST
     LIMIT 1`,
    [fileNo, phone],
  );

  if (existing.rows[0]) {
    await pool.query(
      `UPDATE patients SET
        age = COALESCE(age, $2),
        sex = COALESCE(sex, $3),
        address = COALESCE(address, $4),
        file_no = COALESCE(file_no, $5),
        updated_at = NOW()
       WHERE id = $1`,
      [existing.rows[0].id, age, sex, address, fileNo],
    );
    return existing.rows[0].id;
  }

  try {
    const res = await pool.query(
      `INSERT INTO patients (name, phone, file_no, age, sex, address)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [name, phone, fileNo, age, sex, address],
    );
    return res.rows[0].id;
  } catch (e) {
    if (e.code === "23505") {
      const dup = await pool.query(
        `SELECT id FROM patients WHERE phone = $1 OR file_no = $2 LIMIT 1`,
        [phone, fileNo],
      );
      return dup.rows[0]?.id || null;
    }
    throw e;
  }
}

// ── Sync a single appointment from HealthRay ────────────────────────────────
async function syncAppointment(appt, localDoctorName) {
  const healthrayId = String(appt.id);

  // Skip if already synced
  const exists = await pool.query(`SELECT id FROM appointments WHERE healthray_id = $1`, [
    healthrayId,
  ]);
  if (exists.rows[0]) return { skipped: true, id: exists.rows[0].id };

  const fm = appt.family_member || {};
  const pat = appt.patient || {};
  const name = appt.patient_name || buildName(fm);
  const phone = pat.mobile_no || null;
  const fileNo = appt.patient_case_id || null;
  const sex = mapGender(fm.gender);
  const age = calcAge(fm.birth_date);
  const apptDate = appt.app_date_time
    ? appt.app_date_time.split("T")[0]
    : new Date().toISOString().split("T")[0];
  const timeSlot = extractTimeSlot(appt.app_date_time);
  const visitType = mapVisitType(appt.reason);
  const status = mapStatus(appt.status);
  const isWalkin = appt.tag === "Walk-in" || appt.booking_type === "Walk-in";
  const notes = [appt.reason, appt.rmo_doctor ? `RMO: ${appt.rmo_doctor}` : null]
    .filter(Boolean)
    .join(" | ");

  // Parse weight/height from HealthRay JSON strings
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

  // Build vitals JSONB
  const opdVitals = {};
  if (weight) opdVitals.weight = weight;
  if (height) opdVitals.height = height;
  if (bmi) opdVitals.bmi = bmi;

  // Build biomarkers JSONB with follow-up and RMO
  const biomarkers = {};
  if (appt.followup_days) biomarkers.followup = appt.followup_days.split("T")[0];
  if (appt.rmo_doctor) biomarkers.rmo = appt.rmo_doctor;
  if (appt.reason) biomarkers.reason = appt.reason;
  if (appt.tag) biomarkers.tag = appt.tag;
  if (appt.engaged_start) biomarkers.engagedStart = appt.engaged_start;
  if (appt.engaged_end) biomarkers.engagedEnd = appt.engaged_end;
  if (appt.appointment_number) biomarkers.appointmentNumber = appt.appointment_number;

  // Upsert patient
  const patientId = await upsertPatient(appt);

  const { rows } = await pool.query(
    `INSERT INTO appointments
       (patient_id, patient_name, file_no, phone, doctor_name,
        appointment_date, time_slot, visit_type, status, is_walkin,
        age, sex, notes, healthray_id, opd_vitals, biomarkers)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)
     RETURNING id`,
    [
      patientId,
      name,
      fileNo,
      phone,
      localDoctorName,
      apptDate,
      timeSlot,
      visitType,
      status,
      isWalkin,
      age,
      sex,
      notes,
      healthrayId,
      JSON.stringify(opdVitals),
      JSON.stringify(biomarkers),
    ],
  );

  return { skipped: false, id: rows[0].id };
}

// ── Main sync: today's appointments across all doctors ──────────────────────
export async function syncWalkingAppointments() {
  const startTime = Date.now();
  const today = new Date().toISOString().split("T")[0];
  console.log(`[HealthRay Sync] Starting appointment sync for ${today}...`);

  try {
    await ensureSyncColumns();

    const rayDoctors = await fetchDoctors();
    const doctorMap = await syncDoctors(rayDoctors);
    console.log(`[HealthRay Sync] ${doctorMap.size} doctors mapped`);

    let totalCreated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const doc of rayDoctors) {
      if (doc.is_deactivated) continue;

      const localName = doctorMap.get(doc.id) || doc.doctor_name;
      try {
        const appointments = await fetchAppointments(doc.id, today);
        if (!appointments || appointments.length === 0) continue;

        console.log(`[HealthRay Sync] ${localName}: ${appointments.length} appointments`);

        for (const appt of appointments) {
          try {
            const result = await syncAppointment(appt, localName);
            if (result.skipped) totalSkipped++;
            else totalCreated++;
          } catch (e) {
            totalErrors++;
            console.error(`[HealthRay Sync] Error syncing appt ${appt.id}:`, e.message);
          }
        }
      } catch (e) {
        console.error(`[HealthRay Sync] Error for ${localName}:`, e.message);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[HealthRay Sync] Done in ${elapsed}s — created: ${totalCreated}, skipped: ${totalSkipped}, errors: ${totalErrors}`,
    );

    return { totalCreated, totalSkipped, totalErrors };
  } catch (e) {
    console.error(`[HealthRay Sync] Fatal error:`, e.message);
    throw e;
  }
}

// ── Alias for cron (same as main sync — always today) ───────────────────────
export const syncTodayWalkingAppointments = syncWalkingAppointments;
