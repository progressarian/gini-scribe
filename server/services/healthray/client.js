// ── HealthRay API Client — auth, session, fetch ─────────────────────────────

import { createLogger } from "../logger.js";
import { fetchWithTimeout, createRateLimiter } from "../cron/lowPriority.js";
import pool from "../../config/db.js";
const { log } = createLogger("HealthRay Sync");

// Upstream call timeout — a slow Healthray API must not stall a sync worker
// (or a user request) indefinitely. 20s covers the slowest observed responses.
const HEALTHRAY_TIMEOUT_MS = 20000;

const HEALTHRAY_BASE = "https://node.healthray.com/api/v1";
const HEALTHRAY_LOGIN_URL = "https://node.healthray.com/api/v2/users/sign_in";
export const ORG_ID = process.env.HEALTHRAY_ORG_ID || "1528";

let sessionCookie = process.env.HEALTHRAY_SESSION || "";
let authToken = ""; // x-auth-token from login response
// The logged-in account's own user id (the org "owner" we authenticate as).
// Several HealthRay endpoints (e.g. get_previous_appt_data) scope results by
// doctor_id as a PERMISSION filter, not by the appointment's treating doctor —
// passing a specific doctor's id returns a narrower set that can omit today's
// visit. Using our own account id (what the floor app uses) returns the full
// set. Captured at login; overridable via env.
let orgDoctorId = process.env.HEALTHRAY_DOCTOR_ID || "";
export function getOrgDoctorId() {
  return orgDoctorId;
}

// All HealthRay traffic funnels through ONE shared limiter so the per-doctor
// fan-out (Promise.allSettled over ~29 doctors) drains as a smooth, capped
// stream instead of a burst that trips HealthRay's WAF and gets the server IP
// 403-blocklisted. Tunable via env without a code change. See createRateLimiter.
const healthrayLimiter = createRateLimiter({
  // Default to a gentle, strictly-serial stream (1 concurrent = no bursts, which
  // is what most often trips the WAF). Raise via env once the egress IP is
  // allowlisted (HEALTHRAY_PROXY_URL) and bursts are safe again.
  ratePerSec: Number(process.env.HEALTHRAY_MAX_RPS) || 2,
  maxConcurrent: Number(process.env.HEALTHRAY_MAX_CONCURRENT) || 1,
});

// Drop-in for fetchWithTimeout that first waits for a limiter slot, then
// releases it the moment the response headers return. Used for every outbound
// HealthRay call below.
async function gatedFetch(url, options, timeoutMs) {
  const release = await healthrayLimiter.acquire();
  try {
    return await fetchWithTimeout(url, options, timeoutMs);
  } finally {
    release();
  }
}

// ── Login resilience (the permanent fix for the 403 IP-block loop) ──────────
// The sync runs in TWO processes (API + worker), each polling on a loop. When
// HealthRay's web login rejects us — typically a 403 HTML page once its WAF
// rate-limits the IP — naive per-process retry hammers the endpoint and keeps
// the limiter tripped forever (403 → no session → re-login → 403). Three guards
// stop the server from being the thing that triggers/sustains the block:
//   1. Single-flight: concurrent callers share ONE in-flight login.
//   2. Shared cooldown in app_kv: BOTH processes (and restarts) honour one
//      backoff window — so the cluster makes one login attempt, not N.
//   3. A detected block (403/429/HTML) → a long cooldown (not a fast retry),
//      because a 403 means "you're blocked", and retrying fast deepens it.
// On success the session cookie is persisted so the other process and the next
// restart REUSE it instead of each logging in afresh.
let loginFailCount = 0;
let loginBackoffUntil = 0; // in-memory mirror of the shared cooldown
let blockCount = 0; // consecutive WAF 403/HTML blocks — escalates the cooldown
let loginPromise = null; // single-flight guard
let stateLoadPromise = null;
const LOGIN_BACKOFF_BASE_MS = 60_000; // 1 min, doubles each consecutive failure
const LOGIN_BACKOFF_MAX_MS = 10 * 60_000; // capped at 10 min
const BLOCK_COOLDOWN_MS = 30 * 60_000; // base WAF-block cooldown (30 min)
// A flat 30-min cooldown oscillates forever if the WAF ban outlasts it (probe →
// re-ban → wait 30 → probe …), which is why it needed a manual redeploy. Escalate
// the cooldown on CONSECUTIVE blocks (30m → 1h → 2h, capped) so it waits long
// enough for the ban to clear and recovers on its own. Resets on first success.
const BLOCK_COOLDOWN_MAX_MS = 2 * 60 * 60_000; // 2 h cap
const KV_SESSION = "healthray_session";
const KV_COOLDOWN = "healthray_login_cooldown";

async function kvGet(key) {
  try {
    const r = await pool.query("SELECT value FROM app_kv WHERE key=$1", [key]);
    return r.rows[0]?.value ?? null;
  } catch {
    return null; // app_kv missing / DB blip → fall back to in-memory only
  }
}
async function kvSet(key, value) {
  try {
    await pool.query(
      `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
  } catch {
    /* best-effort — never let persistence break a sync */
  }
}

// Pull a session cookie + cooldown another process may have already established
// (runs once per process). Lets a restart reuse a live session instead of
// logging in again.
function loadPersistedState() {
  if (!stateLoadPromise) {
    stateLoadPromise = (async () => {
      const s = await kvGet(KV_SESSION);
      if (s?.cookie && !sessionCookie) {
        sessionCookie = s.cookie;
        authToken = s.authToken || "";
      }
      // Reuse the logged-in account id even when the session is reused (no fresh
      // doLogin runs to re-capture it). env override always wins.
      if (s?.orgDoctorId && !orgDoctorId) orgDoctorId = String(s.orgDoctorId);
      const c = await kvGet(KV_COOLDOWN);
      if (c?.until) {
        loginBackoffUntil = c.until;
        loginFailCount = c.failCount || 0;
        blockCount = c.blockCount || 0;
      }
    })();
  }
  return stateLoadPromise;
}

// Milliseconds left on the login cooldown (0 when clear). The cron loops read
// this to stop poking HealthRay's data endpoints while we're blocked — without
// it they'd keep eating 403s every ~10s and sustain the WAF block.
export function getLoginCooldownMs() {
  return Math.max(0, loginBackoffUntil - Date.now());
}

// Public entry: single-flight wrapper so a burst of callers triggers ONE login.
async function healthrayLogin() {
  if (loginPromise) return loginPromise;
  loginPromise = doLogin().finally(() => {
    loginPromise = null;
  });
  return loginPromise;
}

async function doLogin() {
  const mobile = process.env.HEALTHRAY_MOBILE;
  const password = process.env.HEALTHRAY_PASSWORD;
  // HealthRay's sign_in only requires captchaToken to be NON-EMPTY — it does
  // not validate the token's value. A constant placeholder lets the app
  // re-login on its own when the connect.sid session expires. Optional
  // HEALTHRAY_CAPTCHA env value overrides if set.
  const captcha = process.env.HEALTHRAY_CAPTCHA || "auto";

  if (!mobile || !password) {
    throw new Error(
      "HealthRay login credentials missing — set HEALTHRAY_MOBILE, HEALTHRAY_PASSWORD in .env",
    );
  }

  await loadPersistedState();
  // Honour the SHARED cooldown — re-read it so we respect a block the OTHER
  // process just hit. While cooling down, fail fast WITHOUT touching the
  // network, so we stop hammering a rate-limited endpoint.
  const shared = await kvGet(KV_COOLDOWN);
  const until = Math.max(loginBackoffUntil, shared?.until || 0);
  if (Date.now() < until) {
    loginBackoffUntil = until;
    loginFailCount = shared?.failCount ?? loginFailCount;
    blockCount = shared?.blockCount ?? blockCount;
    const waitS = Math.round((until - Date.now()) / 1000);
    const why = shared?.reason ? `, ${shared.reason}` : "";
    throw new Error(
      `HealthRay login backing off (${loginFailCount} consecutive failures${why}) — next attempt in ~${waitS}s`,
    );
  }
  // Another process may have refreshed the session while we waited — reuse it.
  if (shared == null) {
    const fresh = await kvGet(KV_SESSION);
    if (fresh?.cookie && fresh.cookie !== sessionCookie) {
      sessionCookie = fresh.cookie;
      authToken = fresh.authToken || "";
      log("Auth", "Reusing session established by another process");
      return sessionCookie;
    }
  }

  log("Auth", "Session expired, logging in...");

  const res = await gatedFetch(
    HEALTHRAY_LOGIN_URL,
    {
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
    },
    HEALTHRAY_TIMEOUT_MS,
  );

  // Extract the connect.sid session cookie. getSetCookie() is the correct API
  // for Set-Cookie under Node's undici fetch (plain get("set-cookie") can drop
  // it); fall back to get() for older runtimes.
  const setCookieList =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") || ""];
  const setCookie = setCookieList.join("; ");
  const match = setCookie.match(/connect\.sid=([^;]+)/);

  // Read the body once as text, then try to parse JSON from it — so that when
  // an unexpected (non-JSON) response comes back (e.g. a WAF / IP-block HTML
  // page), we can log the raw content instead of hiding behind a generic
  // "no session cookie returned".
  const rawBody = await res.text().catch(() => "");
  let body = {};
  try {
    body = JSON.parse(rawBody);
  } catch {
    /* non-JSON response (HTML block page, gateway error, etc.) */
  }

  if (!match) {
    loginFailCount += 1;
    const ct = res.headers.get("content-type") || "?";
    // A 403/429 or an HTML body means HealthRay's edge/WAF is blocking us, not
    // a wrong password (which returns JSON). Treat it as "blocked → wait long",
    // never a fast retry — that's what sustains the block.
    const blocked = res.status === 403 || res.status === 429 || ct.includes("text/html");
    let backoff;
    if (blocked) {
      // Escalate on consecutive blocks so we wait long enough for the WAF ban to
      // clear instead of oscillating on a flat cooldown (the old manual-redeploy
      // trap). 30m → 1h → 2h (capped).
      blockCount += 1;
      backoff = Math.min(BLOCK_COOLDOWN_MAX_MS, BLOCK_COOLDOWN_MS * 2 ** (blockCount - 1));
    } else {
      backoff = Math.min(LOGIN_BACKOFF_MAX_MS, LOGIN_BACKOFF_BASE_MS * 2 ** (loginFailCount - 1));
    }
    loginBackoffUntil = Date.now() + backoff;
    const reason = blocked ? `IP likely blocked (http=${res.status})` : "";
    await kvSet(KV_COOLDOWN, {
      until: loginBackoffUntil,
      failCount: loginFailCount,
      blockCount,
      reason,
    });
    if (blocked) {
      log(
        "Auth",
        `⚠ BLOCKED by HealthRay (http=${res.status}) — block #${blockCount}, cooling down ${Math.round(backoff / 60000)}min (auto-recovers, no redeploy needed). ` +
          `Permanent fix: set HEALTHRAY_PROXY_URL to a static egress IP and have HealthRay allowlist it.`,
      );
    }
    const snippet = body.message ? "" : ` body="${rawBody.slice(0, 200).replace(/\s+/g, " ")}"`;
    throw new Error(
      `HealthRay login failed: ${body.message || "no session cookie returned"} ` +
        `[http=${res.status} type=${ct}${snippet}] — backing off ${Math.round(backoff / 1000)}s`,
    );
  }

  // Success — clear the circuit-breaker and persist the session for reuse by
  // the other process / the next restart.
  loginFailCount = 0;
  loginBackoffUntil = 0;
  blockCount = 0;
  sessionCookie = match[1];
  if (body.data?.auth_token || body.data?.token) {
    authToken = body.data.auth_token || body.data.token;
    log("Auth", `Auth token captured: ${authToken.slice(0, 8)}...`);
  }
  if (!process.env.HEALTHRAY_DOCTOR_ID && body.data?.id) orgDoctorId = String(body.data.id);
  await kvSet(KV_SESSION, { cookie: sessionCookie, authToken, orgDoctorId, at: Date.now() });
  await kvSet(KV_COOLDOWN, { until: 0, failCount: 0, blockCount: 0, reason: "" });
  log("Auth", "Login successful, new session obtained");
  return sessionCookie;
}

export async function healthrayFetch(path, isRetry = false) {
  if (!sessionCookie) {
    await loadPersistedState(); // a live session may already exist (other process / pre-restart)
  }
  if (!sessionCookie) {
    await healthrayLogin();
  }

  const res = await gatedFetch(
    `${HEALTHRAY_BASE}${path}`,
    { headers: { Cookie: `connect.sid=${sessionCookie}` } },
    HEALTHRAY_TIMEOUT_MS,
  );

  // HealthRay returns 200 + HTML when session expires (redirect to login page).
  // Detect this before trying to parse JSON, otherwise the parse throws and the
  // retry logic below is never reached.
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    if (isRetry) throw new Error("HealthRay session expired — re-login failed, check credentials");
    // The other process may have already refreshed the session — pick that up
    // first so we don't trigger a redundant login (and more login traffic).
    const fresh = await kvGet(KV_SESSION);
    if (fresh?.cookie && fresh.cookie !== sessionCookie) {
      sessionCookie = fresh.cookie;
      authToken = fresh.authToken || "";
      log("Auth", "Session refreshed by another process — reusing it");
      return healthrayFetch(path, true);
    }
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

// All recent visits for a patient (newest first, incl. TODAY's in-progress one),
// each with its filled clinical menus. Unlike fetchPreviousAppointmentData
// (copy_previous=1 → the PREVIOUS visit, for copy-forward), is_all=1 returns the
// list so the caller can pick the entry dated today — the only freshness-safe
// source for "vitals taken today" (the vitals station writes Observation→Vitals
// here before the doctor opens the note). Same endpoint the floor app polls.
export function fetchPatientRecentVisits(patientId, doctorId, perPage = 5) {
  return healthrayFetch(
    `/appointment/get_previous_appt_data?patient_id=${patientId}&organization_id=${ORG_ID}&is_cpt_cncl=1&is_all=1&page=1&per_page=${perPage}&is_opd=1&doctor_id=${doctorId}`,
  );
}

// Patient's OPD billing transactions (newest-first), each with billing_items
// carrying category_type (OPD / PATHOLOGY / RADIOLOGY) → maps to journey steps.
// Structured JSON — no PDF/AI needed. POST endpoint, so it can't use the GET
// helper; mirrors healthrayFetch's session + re-login-on-HTML retry.
export async function fetchPatientTransactions(
  patientId,
  { txnType = "OPD", limit = 25 } = {},
  isRetry = false,
) {
  if (!sessionCookie) await loadPersistedState();
  if (!sessionCookie) await healthrayLogin();
  const url =
    `${HEALTHRAY_BASE}/appointment/get_transactions?patient_id=${patientId}` +
    `&organization_id=${ORG_ID}&txn_type=${txnType}&is_agiGrid=1`;
  const res = await gatedFetch(
    url,
    {
      method: "POST",
      headers: { Cookie: `connect.sid=${sessionCookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startRow: 0, endRow: limit }),
    },
    HEALTHRAY_TIMEOUT_MS,
  );
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    if (isRetry) throw new Error("HealthRay session expired — re-login failed");
    await healthrayLogin();
    return fetchPatientTransactions(patientId, { txnType, limit }, true);
  }
  const json = await res.json();
  if (json.status === 401 && !isRetry) {
    await healthrayLogin();
    return fetchPatientTransactions(patientId, { txnType, limit }, true);
  }
  if (json.status !== 200) throw new Error(`HealthRay get_transactions error: ${json.message}`);
  return json.rows || [];
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

  const res = await gatedFetch(url, { headers, redirect: "follow" }, HEALTHRAY_TIMEOUT_MS);
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

  const res = await gatedFetch(url, { headers, redirect: "follow" }, HEALTHRAY_TIMEOUT_MS);

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
    const retry = await gatedFetch(
      url,
      { headers: retryHeaders, redirect: "follow" },
      HEALTHRAY_TIMEOUT_MS,
    );
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
