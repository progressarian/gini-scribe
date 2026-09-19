import { createLogger } from "../logger.js";
import { fetchWithTimeout, createRateLimiter } from "../cron/lowPriority.js";
import pool from "../../config/db.js";
const { log } = createLogger("HealthRay Sync");

const HEALTHRAY_TIMEOUT_MS = 20000;

const HEALTHRAY_BASE = "https://node.healthray.com/api/v1";
const HEALTHRAY_LOGIN_URL = "https://node.healthray.com/api/v2/users/sign_in";
export const ORG_ID = process.env.HEALTHRAY_ORG_ID || "1528";

let sessionCookie = process.env.HEALTHRAY_SESSION || "";
let authToken = "";
let orgDoctorId = process.env.HEALTHRAY_DOCTOR_ID || "";
export function getOrgDoctorId() {
  return orgDoctorId;
}

const healthrayLimiter = createRateLimiter({
  ratePerSec: Number(process.env.HEALTHRAY_MAX_RPS) || 2,
  maxConcurrent: Number(process.env.HEALTHRAY_MAX_CONCURRENT) || 1,
});

const BLOCK_CHECK_MS = 15_000;
const IGNORE_SHARED_BLOCK = process.env.HEALTHRAY_IGNORE_SHARED_BLOCK === "1";
const COUNT_LOG_MS = 10 * 60_000;
let blockCheckedAt = 0;
let sharedBlockUntil = 0;
let blockedLocallyUntil = 0;
let countsSince = Date.now();
const requestCounts = new Map();

const endpointOf = (url) =>
  String(url)
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/\?.*$/, "")
    .replace(/\/\d+(?=\/|$)/g, "/:id");

function countRequest(url) {
  const key = endpointOf(url);
  requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
  if (Date.now() - countsSince < COUNT_LOG_MS) return;
  const total = [...requestCounts.values()].reduce((a, b) => a + b, 0);
  const top = [...requestCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  log(
    "Traffic",
    `${total} HealthRay requests in ${Math.round((Date.now() - countsSince) / 60000)}min — ${top}`,
  );
  requestCounts.clear();
  countsSince = Date.now();
}

async function assertNotBlocked() {
  if (!IGNORE_SHARED_BLOCK && Date.now() - blockCheckedAt > BLOCK_CHECK_MS) {
    blockCheckedAt = Date.now();
    const shared = await kvGet(KV_COOLDOWN);
    sharedBlockUntil = String(shared?.reason || "").includes("blocked") ? shared.until || 0 : 0;
    blockCount = shared?.blockCount || 0;
    if (!sharedBlockUntil) {
      blockedLocallyUntil = 0;
      loginBackoffUntil = Math.min(loginBackoffUntil, shared?.until || 0);
    }
  }
  const until = Math.max(sharedBlockUntil, blockedLocallyUntil);
  if (Date.now() < until) {
    throw Object.assign(
      new Error(
        `HealthRay is blocking this server — no requests sent until ${new Date(until).toISOString()}`,
      ),
      { healthrayBlocked: true },
    );
  }
}

async function tripBlock(status, url) {
  if (IGNORE_SHARED_BLOCK) {
    blockedLocallyUntil = Date.now() + BLOCK_COOLDOWN_MS;
    loginBackoffUntil = Math.max(loginBackoffUntil, blockedLocallyUntil);
    log(
      "Auth",
      `⚠ BLOCKED by HealthRay (http=${status} on ${endpointOf(url)}) — this process pauses ${Math.round(BLOCK_COOLDOWN_MS / 60000)}min (shared cooldown not written)`,
    );
    return;
  }
  const shared = await kvGet(KV_COOLDOWN);
  if (shared?.until > Date.now() && String(shared.reason || "").includes("blocked")) {
    sharedBlockUntil = shared.until;
    return;
  }
  blockCount = (shared?.blockCount || 0) + 1;
  const backoff = Math.min(BLOCK_COOLDOWN_MAX_MS, BLOCK_COOLDOWN_MS * 2 ** (blockCount - 1));
  blockedLocallyUntil = Date.now() + backoff;
  loginBackoffUntil = Math.max(loginBackoffUntil, blockedLocallyUntil);
  sharedBlockUntil = blockedLocallyUntil;
  blockCheckedAt = Date.now();
  await kvSet(KV_COOLDOWN, {
    until: blockedLocallyUntil,
    failCount: loginFailCount,
    blockCount,
    reason: `IP likely blocked (http=${status} on ${endpointOf(url)})`,
  });
  log(
    "Auth",
    `⚠ BLOCKED by HealthRay (http=${status} on ${endpointOf(url)}) — all HealthRay requests stop for ${Math.round(backoff / 60000)}min`,
  );
}

const BILL_ENDPOINT = "/api/v1/appointment/get_transactions";
const isBillRead = (url) => endpointOf(url) === BILL_ENDPOINT;
export const KV_BILL_COOLDOWN = "healthray_bill_cooldown";
let billSharedUntil = 0;
let billLocalUntil = 0;
let billBlockCheckedAt = 0;

const billReadsRefused = (status) =>
  Object.assign(
    new Error(
      status
        ? `HealthRay refused the bill read (http=${status}) — appointments keep syncing`
        : `HealthRay bill reads paused until ${new Date(Math.max(billSharedUntil, billLocalUntil)).toISOString()} — appointments keep syncing`,
    ),
    { healthrayBlocked: true, billReadsBlocked: true },
  );

async function assertBillReadsAllowed() {
  if (!IGNORE_SHARED_BLOCK && Date.now() - billBlockCheckedAt > BLOCK_CHECK_MS) {
    billBlockCheckedAt = Date.now();
    billSharedUntil = (await kvGet(KV_BILL_COOLDOWN))?.until || 0;
  }
  if (Date.now() < Math.max(billSharedUntil, billLocalUntil)) throw billReadsRefused();
}

async function tripBillBlock(status, url) {
  if (IGNORE_SHARED_BLOCK) {
    billLocalUntil = Date.now() + BLOCK_COOLDOWN_MS;
    log(
      "Auth",
      `⚠ Bill reads paused by HealthRay (http=${status} on ${endpointOf(url)}) — this process pauses bill reads ${Math.round(BLOCK_COOLDOWN_MS / 60000)}min; appointments keep syncing`,
    );
    return;
  }
  const shared = await kvGet(KV_BILL_COOLDOWN);
  if (shared?.until > Date.now()) {
    billSharedUntil = shared.until;
    return;
  }
  const count = (shared?.blockCount || 0) + 1;
  const backoff = Math.min(BLOCK_COOLDOWN_MAX_MS, BLOCK_COOLDOWN_MS * 2 ** (count - 1));
  billSharedUntil = Date.now() + backoff;
  billBlockCheckedAt = Date.now();
  await kvSet(KV_BILL_COOLDOWN, {
    until: billSharedUntil,
    blockCount: count,
    reason: `bill reads blocked (http=${status} on ${endpointOf(url)})`,
  });
  log(
    "Auth",
    `⚠ Bill reads paused by HealthRay (http=${status} on ${endpointOf(url)}) — block #${count}, no bill reads for ${Math.round(backoff / 60000)}min; appointments keep syncing`,
  );
}

async function clearBillBlock() {
  billLocalUntil = 0;
  if (IGNORE_SHARED_BLOCK) return;
  const shared = await kvGet(KV_BILL_COOLDOWN);
  if (!shared?.blockCount) return;
  billSharedUntil = 0;
  await kvSet(KV_BILL_COOLDOWN, { until: 0, blockCount: 0, reason: "" });
  log("Auth", "Bill reads working again — bill block cleared");
}

async function gatedFetch(url, options, timeoutMs) {
  const billRead = isBillRead(url);
  await assertNotBlocked();
  if (billRead) await assertBillReadsAllowed();
  const release = await healthrayLimiter.acquire();
  try {
    await assertNotBlocked();
    if (billRead) await assertBillReadsAllowed();
    countRequest(url);
    const res = await fetchWithTimeout(url, options, timeoutMs);
    const wafPage =
      res.status === 429 ||
      (res.status === 403 && !(res.headers.get("content-type") || "").includes("json"));
    if (wafPage && billRead) {
      await tripBillBlock(res.status, url);
    } else if (wafPage && url !== HEALTHRAY_LOGIN_URL) {
      await tripBlock(res.status, url);
    }
    return res;
  } finally {
    release();
  }
}

let loginFailCount = 0;
let loginBackoffUntil = 0;
let blockCount = 0;
let loginPromise = null;
let stateLoadPromise = null;
const LOGIN_BACKOFF_BASE_MS = 60_000;
const LOGIN_BACKOFF_MAX_MS = 10 * 60_000;
const BLOCK_COOLDOWN_MS = 30 * 60_000;
const BLOCK_COOLDOWN_MAX_MS = 2 * 60 * 60_000;
const KV_SESSION = "healthray_session";
const KV_COOLDOWN = "healthray_login_cooldown";

async function kvGet(key) {
  try {
    const r = await pool.query("SELECT value FROM app_kv WHERE key=$1", [key]);
    return r.rows[0]?.value ?? null;
  } catch {
    return null;
  }
}
async function kvSet(key, value) {
  try {
    await pool.query(
      `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
  } catch {}
}

function loadPersistedState() {
  if (!stateLoadPromise) {
    stateLoadPromise = (async () => {
      const s = await kvGet(KV_SESSION);
      if (s?.cookie && !sessionCookie) {
        sessionCookie = s.cookie;
        authToken = s.authToken || "";
      }
      if (s?.orgDoctorId && !orgDoctorId) orgDoctorId = String(s.orgDoctorId);
      if (IGNORE_SHARED_BLOCK) return;
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

export function getLoginCooldownMs() {
  return Math.max(0, loginBackoffUntil - Date.now());
}

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
  const captcha = process.env.HEALTHRAY_CAPTCHA || "auto";

  if (!mobile || !password) {
    throw new Error(
      "HealthRay login credentials missing — set HEALTHRAY_MOBILE, HEALTHRAY_PASSWORD in .env",
    );
  }

  await loadPersistedState();
  const shared = IGNORE_SHARED_BLOCK ? null : await kvGet(KV_COOLDOWN);
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

  const setCookieList =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") || ""];
  const setCookie = setCookieList.join("; ");
  const match = setCookie.match(/connect\.sid=([^;]+)/);

  const rawBody = await res.text().catch(() => "");
  let body = {};
  try {
    body = JSON.parse(rawBody);
  } catch {}

  if (!match) {
    loginFailCount += 1;
    const ct = res.headers.get("content-type") || "?";
    const blocked = res.status === 403 || res.status === 429 || ct.includes("text/html");
    let backoff;
    if (blocked) {
      blockCount += 1;
      backoff = Math.min(BLOCK_COOLDOWN_MAX_MS, BLOCK_COOLDOWN_MS * 2 ** (blockCount - 1));
    } else {
      backoff = Math.min(LOGIN_BACKOFF_MAX_MS, LOGIN_BACKOFF_BASE_MS * 2 ** (loginFailCount - 1));
    }
    loginBackoffUntil = Date.now() + backoff;
    const reason = blocked ? `IP likely blocked (http=${res.status})` : "";
    if (!IGNORE_SHARED_BLOCK) {
      await kvSet(KV_COOLDOWN, {
        until: loginBackoffUntil,
        failCount: loginFailCount,
        blockCount,
        reason,
      });
    }
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

  loginFailCount = 0;
  loginBackoffUntil = 0;
  blockedLocallyUntil = 0;
  sharedBlockUntil = 0;
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
    await loadPersistedState();
  }
  if (!sessionCookie) {
    await healthrayLogin();
  }

  const res = await gatedFetch(
    `${HEALTHRAY_BASE}${path}`,
    { headers: { Cookie: `connect.sid=${sessionCookie}` } },
    HEALTHRAY_TIMEOUT_MS,
  );

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    if (isRetry) throw new Error("HealthRay session expired — re-login failed, check credentials");
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

const DOCTORS_TTL_MS = 24 * 60 * 60_000;
let doctorsCache = null;
let doctorsCachedAt = 0;

export async function fetchDoctors() {
  if (doctorsCache && Date.now() - doctorsCachedAt < DOCTORS_TTL_MS) return doctorsCache;
  const doctors = await healthrayFetch(`/organization/get_doctors/${ORG_ID}`);
  doctorsCache = doctors;
  doctorsCachedAt = Date.now();
  return doctors;
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

export function fetchPatientRecentVisits(patientId, doctorId, perPage = 5) {
  return healthrayFetch(
    `/appointment/get_previous_appt_data?patient_id=${patientId}&organization_id=${ORG_ID}&is_cpt_cncl=1&is_all=1&page=1&per_page=${perPage}&is_opd=1&doctor_id=${doctorId}`,
  );
}

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
  if (res.status === 429 || (res.status === 403 && !contentType.includes("json"))) {
    throw billReadsRefused(res.status);
  }
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
  await clearBillBlock();
  return json.rows || [];
}

export function fetchMedicalRecords(appointmentId) {
  return healthrayFetch(
    `/medical_records?record_type=${encodeURIComponent("Invoice/Bill,Prescription/Rx,Lab Report,X-Rays,Other,Certificate")}&appointment_id=${appointmentId}`,
  );
}

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

  if (ct.includes("application/json") || (buffer.length < 2000 && buffer[0] === 0x7b)) {
    try {
      const parsed = JSON.parse(buffer.toString("utf8"));
      if (parsed.data !== undefined && Object.keys(parsed.data || {}).length === 0) return null;
    } catch {}
  }

  return { buffer, contentType: ct.split(";")[0].trim() || "application/octet-stream" };
}

export async function downloadMedicalRecordFile(attachmentId, recordType, medicalRecordId) {
  if (!sessionCookie) await healthrayLogin();

  const mrParam = medicalRecordId ? `&medical_record_id=${medicalRecordId}` : "";
  const url = `${HEALTHRAY_BASE}/medical_records/download/${attachmentId}?record_type=${encodeURIComponent(recordType)}${mrParam}`;
  const headers = { Cookie: `connect.sid=${sessionCookie}` };
  if (authToken) headers["x-auth-token"] = authToken;

  const res = await gatedFetch(url, { headers, redirect: "follow" }, HEALTHRAY_TIMEOUT_MS);

  const ct = res.headers.get("content-type") || "";
  log("Download", `${res.status} ${ct.slice(0, 40)} for attachment ${attachmentId}`);

  if (res.status === 422) {
    const body = await res.json().catch(() => ({}));
    log(
      "Download",
      `422 for attachment ${attachmentId}: ${body.message || JSON.stringify(body.data)}`,
    );
    return null;
  }

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
