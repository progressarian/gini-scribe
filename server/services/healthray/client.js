// ── HealthRay API Client — auth, session, fetch ─────────────────────────────

import { createLogger } from "../logger.js";
const { log } = createLogger("HealthRay Sync");

const HEALTHRAY_BASE = "https://node.healthray.com/api/v1";
const HEALTHRAY_LOGIN_URL = "https://node.healthray.com/api/v2/users/sign_in";
export const ORG_ID = process.env.HEALTHRAY_ORG_ID || "1528";

let sessionCookie = process.env.HEALTHRAY_SESSION || "";
let authToken = ""; // x-auth-token from login response

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
  const body = await res.json().catch(() => ({}));
  if (!match) {
    throw new Error(`HealthRay login failed: ${body.message || "no session cookie returned"}`);
  }

  sessionCookie = match[1];
  // Capture auth token from login response for download endpoints
  if (body.data?.auth_token || body.data?.token) {
    authToken = body.data.auth_token || body.data.token;
    log("Auth", `Auth token captured: ${authToken.slice(0, 8)}...`);
  }
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

  // HealthRay returns 200 + HTML when session expires (redirect to login page).
  // Detect this before trying to parse JSON, otherwise the parse throws and the
  // retry logic below is never reached.
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    if (isRetry) throw new Error("HealthRay session expired — re-login failed, check credentials");
    log("Auth", "Session expired (HTML response) — re-logging in");
    await healthrayLogin();
    return healthrayFetch(path, true);
  }

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

// Fetch any HealthRay URL with auth (e.g. thumbnail/preview URLs stored in file_url).
// Returns { buffer, contentType } or null on failure.
export async function healthrayRawFetch(url, isRetry = false) {
  if (!sessionCookie) await healthrayLogin();

  const headers = { Cookie: `connect.sid=${sessionCookie}` };
  if (authToken) headers["x-auth-token"] = authToken;

  const res = await fetch(url, { headers, redirect: "follow" });
  const ct = res.headers.get("content-type") || "";

  if (!res.ok || ct.includes("text/html")) {
    if (isRetry) return null;
    await healthrayLogin();
    return healthrayRawFetch(url, true);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) return null;

  // Reject JSON error responses
  if (ct.includes("application/json") || (buffer.length < 2000 && buffer[0] === 0x7b)) {
    try {
      const parsed = JSON.parse(buffer.toString("utf8"));
      if (parsed.data !== undefined && Object.keys(parsed.data || {}).length === 0) return null;
    } catch {}
  }

  return { buffer, contentType: ct.split(";")[0].trim() || "application/octet-stream" };
}

// Download the actual PDF/file (not thumbnail) for a medical record attachment.
// Returns { buffer, contentType } or null on failure.
// Endpoint: GET /medical_records/download/{attachmentId}?record_type=...&medical_record_id=...
export async function downloadMedicalRecordFile(attachmentId, recordType, medicalRecordId) {
  if (!sessionCookie) await healthrayLogin();

  // Build URL — omit medical_record_id if not available (attachment ID in path is the primary key)
  const mrParam = medicalRecordId ? `&medical_record_id=${medicalRecordId}` : "";
  const url = `${HEALTHRAY_BASE}/medical_records/download/${attachmentId}?record_type=${encodeURIComponent(recordType)}${mrParam}`;
  const headers = { Cookie: `connect.sid=${sessionCookie}` };
  if (authToken) headers["x-auth-token"] = authToken;

  const res = await fetch(url, { headers, redirect: "follow" });

  // Log response details for debugging
  const ct = res.headers.get("content-type") || "";
  log("Download", `${res.status} ${ct.slice(0, 40)} for attachment ${attachmentId}`);

  // 422 = real API error (e.g. missing medical_record_id) — don't retry
  if (res.status === 422) {
    const body = await res.json().catch(() => ({}));
    log(
      "Download",
      `422 for attachment ${attachmentId}: ${body.message || JSON.stringify(body.data)}`,
    );
    return null;
  }

  // HTML response = session expired — retry after login
  if (!res.ok || ct.includes("text/html")) {
    await healthrayLogin();
    const retryHeaders = { Cookie: `connect.sid=${sessionCookie}` };
    if (authToken) retryHeaders["x-auth-token"] = authToken;
    const retry = await fetch(url, { headers: retryHeaders, redirect: "follow" });
    if (!retry.ok) {
      const errBody = await retry.text().catch(() => "");
      log("Download", `Retry failed ${retry.status}: ${errBody.slice(0, 200)}`);
      return null;
    }
    const buffer = Buffer.from(await retry.arrayBuffer());
    const contentType =
      retry.headers.get("content-type")?.split(";")[0].trim() || "application/pdf";
    return { buffer, contentType };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = ct.split(";")[0].trim() || "application/pdf";

  // HealthRay sometimes returns HTTP 200 with a JSON error body like
  // {"status":200,"message":"no record found by given id","data":{}}
  // Detect and reject these — they are not real files.
  if (
    contentType === "application/json" ||
    (buffer.length < 2000 && buffer.slice(0, 1).toString() === "{")
  ) {
    try {
      const parsed = JSON.parse(buffer.toString("utf8"));
      if (
        parsed.data !== undefined &&
        (Object.keys(parsed.data || {}).length === 0 ||
          (parsed.message || "").toLowerCase().includes("no record") ||
          (parsed.statusState === "success" && !parsed.data?.url))
      ) {
        log(
          "Download",
          `JSON 'no record found' response for attachment ${attachmentId}: ${parsed.message}`,
        );
        return null;
      }
    } catch {}
  }

  return { buffer, contentType };
}
