// ── HealthRay API Client — auth, session, fetch ─────────────────────────────

import { createLogger } from "../logger.js";
const { log } = createLogger("HealthRay Sync");

const HEALTHRAY_BASE = "https://node.healthray.com/api/v1";
const HEALTHRAY_LOGIN_URL = "https://node.healthray.com/api/v2/users/sign_in";
export const ORG_ID = process.env.HEALTHRAY_ORG_ID || "1528";

let sessionCookie = process.env.HEALTHRAY_SESSION || "";

async function healthrayLogin() {
  const mobile = process.env.HEALTHRAY_MOBILE;
  const password = process.env.HEALTHRAY_PASSWORD;
  const captcha = process.env.HEALTHRAY_CAPTCHA;

  if (!mobile || !password || !captcha) {
    throw new Error(
      "HealthRay login credentials missing — set HEALTHRAY_MOBILE, HEALTHRAY_PASSWORD, HEALTHRAY_CAPTCHA in .env",
    );
  }

  log("Auth", "Session expired, logging in...");

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
  log("Auth", "Login successful, new session obtained");
  return sessionCookie;
}

export async function healthrayFetch(path, isRetry = false) {
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

// ── API endpoint wrappers ───────────────────────────────────────────────────

export function fetchDoctors() {
  return healthrayFetch(`/organization/get_doctors/${ORG_ID}`);
}

export function fetchAppointments(doctorId, date, page = 1, perPage = 100) {
  return healthrayFetch(
    `/appointment/data?organization_id=${ORG_ID}&doctor_id=${doctorId}&app_date_time=${date}T00:00:00&page=${page}&per_page=${perPage}`,
  );
}

export function fetchClinicalNotes(appointmentId, doctorId) {
  return healthrayFetch(
    `/appointment/medical_clinical_notes?appointmentId=${appointmentId}&organization_id=${ORG_ID}&doctorId=${doctorId}`,
  );
}

export function fetchPreviousAppointmentData(appointmentId, patientId, doctorId) {
  return healthrayFetch(
    `/appointment/get_previous_appt_data?patient_id=${patientId}&organization_id=${ORG_ID}&appointment_id=${appointmentId}&copy_previous=1&is_opd=1&doctor_id=${doctorId}`,
  );
}

export function fetchMedicalRecords(appointmentId) {
  return healthrayFetch(
    `/medical_records?record_type=${encodeURIComponent("Invoice/Bill,Prescription/Rx,Lab Report,X-Rays,Other,Certificate")}&appointment_id=${appointmentId}`,
  );
}
