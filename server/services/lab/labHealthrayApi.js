// ── Lab HealthRay API Client ─────────────────────────────────────────────────
// Separate system from node.healthray.com — JWT auth with auto-refresh on 401

import { createLogger } from "../logger.js";
const { log } = createLogger("Lab Auth");

const LAB_API_BASE = "https://labapi.healthray.com/api/v1";

// In-memory token cache — seeded from .env, refreshed automatically on 401
let authToken = process.env.LAB_HEALTHRAY_AUTH_TOKEN || null;
let accessToken = process.env.LAB_HEALTHRAY_ACCESS_TOKEN || null;

// Device token is fixed per device/browser (Firebase push token) — never changes
const DEVICE_TOKEN = process.env.LAB_HEALTHRAY_DEVICE_TOKEN;

// Fixed lab admin user ID for read-only API calls
const LAB_USER_ID = process.env.LAB_HEALTHRAY_USER_ID;

const LAB_HEADERS = () => ({
  accept: "*/*",
  "content-type": "application/json",
  origin: "https://lab.healthray.com",
  "x-auth-token": authToken,
  "x-device-token": DEVICE_TOKEN,
  "x-healthray-access-token": accessToken,
});

// ── Auto-login using credentials from .env ───────────────────────────────────
export async function labLogin() {
  const mobile = process.env.LAB_HEALTHRAY_MOBILE;
  const password = process.env.LAB_HEALTHRAY_PASSWORD;
  const countryCode = process.env.LAB_HEALTHRAY_COUNTRY_CODE || "+91";

  if (!mobile || !password || !DEVICE_TOKEN) {
    throw new Error(
      "Lab credentials missing — set LAB_HEALTHRAY_MOBILE, LAB_HEALTHRAY_PASSWORD, LAB_HEALTHRAY_DEVICE_TOKEN in .env",
    );
  }

  log("Login", `Logging in as ${mobile}...`);

  const res = await fetch(`${LAB_API_BASE}/user/sign_in`, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      origin: "https://lab.healthray.com",
      "x-auth-token": "null",
      "x-device-token": DEVICE_TOKEN,
    },
    body: JSON.stringify({
      mobile_number: mobile,
      country_code: countryCode,
      password,
    }),
  });

  const json = await res.json().catch(() => ({}));

  if (json.status !== 200) {
    throw new Error(`Lab login failed: ${json.message || `HTTP ${res.status}`}`);
  }

  // Tokens are in json.data
  const data = json.data || json;
  const newAuthToken = data.authentication_token || data.healthray_auth_token || null;
  const newAccessToken = data.healthray_access_token || null;

  if (!newAuthToken) {
    log("Login", `Response keys: ${Object.keys(data).join(", ")}`);
    throw new Error("Lab login succeeded but could not find auth token in response");
  }

  authToken = newAuthToken;
  if (newAccessToken) accessToken = newAccessToken;

  log("Login", "Tokens refreshed successfully");
  return { authToken, accessToken };
}

// ── Core fetch with auto-retry on 401 ───────────────────────────────────────
async function labFetch(path, isRetry = false) {
  // Auto-login if no token in memory yet
  if (!authToken) {
    await labLogin();
  }

  const res = await fetch(`${LAB_API_BASE}${path}`, { headers: LAB_HEADERS() });

  // 401 = token expired → re-login once and retry
  if (res.status === 401 && !isRetry) {
    log("Auth", "401 received — refreshing tokens...");
    await labLogin();
    return labFetch(path, true);
  }

  if (!res.ok) throw new Error(`Lab API HTTP ${res.status} at ${path}`);

  const json = await res.json();
  if (json.status !== 200) throw new Error(`Lab API error: ${json.message}`);
  return json.data;
}

// ── IST date → UTC range for API ─────────────────────────────────────────────
// IST = UTC+5:30, so IST midnight = UTC 18:30 previous day
function istDateToUtcRange(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, d - 1, 18, 30, 0));
  const to = new Date(Date.UTC(y, m - 1, d, 18, 29, 59));
  return {
    from_date: from.toISOString(),
    to_date: to.toISOString(),
  };
}

// ── Fetch today's lab cases (IST date), paginated ────────────────────────────
export async function fetchLabCasesForDate(dateStr) {
  const { from_date, to_date } = istDateToUtcRange(dateStr);
  const cases = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const params = new URLSearchParams({
      page,
      per_page: perPage,
      report_type: "lab,outsource_lab",
      from_date,
      to_date,
      order_by: "is_urgent_case",
      is_healthray_case: "true",
    });

    const data = await labFetch(`/patient_case?${params}`);

    const rows = Array.isArray(data) ? data : data?.rows || [];
    cases.push(...rows);

    if (rows.length < perPage) break;
    page++;
  }

  return cases;
}

// ── Fetch full case detail including all test results ─────────────────────────
export async function fetchLabCaseDetail(caseUid, caseId, userId) {
  return labFetch(
    `/patient_case/case_detail/${caseUid}?case_id=${caseId}&user_id=${userId || LAB_USER_ID}`,
  );
}

// ── Binary fetch with auto-retry on 401 (for PDF downloads) ─────────────────
async function labFetchBinary(path, isRetry = false) {
  if (!authToken) {
    await labLogin();
  }

  const res = await fetch(`${LAB_API_BASE}${path}`, { headers: LAB_HEADERS() });

  if (res.status === 401 && !isRetry) {
    log("Auth", "401 (binary) — refreshing tokens...");
    await labLogin();
    return labFetchBinary(path, true);
  }

  if (!res.ok) throw new Error(`Lab API HTTP ${res.status} at ${path}`);

  const ct = res.headers.get("content-type") || "";
  const buffer = Buffer.from(await res.arrayBuffer());

  // Reject JSON error bodies disguised as 200 OK
  if (ct.includes("application/json") || (buffer.length < 2000 && buffer[0] === 0x7b)) {
    try {
      const parsed = JSON.parse(buffer.toString("utf8"));
      if (parsed.status && parsed.status !== 200) {
        throw new Error(`Lab API error (binary): ${parsed.message || "unknown"}`);
      }
    } catch (e) {
      if (e.message.startsWith("Lab API")) throw e;
    }
  }

  return { buffer, contentType: ct.split(";")[0].trim() || "application/pdf" };
}

// ── Fetch lab report PDF for a case ─────────────────────────────────────────
// Endpoint TBD — update the path once the exact HealthRay Lab API URL is confirmed.
export async function fetchLabReportPdf(caseUid, caseId, userId) {
  try {
    return await labFetchBinary(
      `/patient_case/generate_report/${caseUid}?case_id=${caseId}&user_id=${userId || LAB_USER_ID}`,
    );
  } catch (e) {
    log("PDF", `fetchLabReportPdf failed for ${caseUid}: ${e.message}`);
    return null;
  }
}
