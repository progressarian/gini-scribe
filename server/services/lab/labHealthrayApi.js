// ── Lab HealthRay API Client ─────────────────────────────────────────────────
// Separate system from node.healthray.com — JWT auth with auto-refresh on 401

import { createLogger } from "../logger.js";
import { fetchWithTimeout } from "../cron/lowPriority.js";
const { log } = createLogger("Lab Auth");

const LAB_API_BASE = "https://labapi.healthray.com/api/v1";

// Upstream call timeout — prevents a stalled lab API from holding a sync
// worker (or a user request) indefinitely.
const LAB_TIMEOUT_MS = 20000;

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

  const res = await fetchWithTimeout(
    `${LAB_API_BASE}/user/sign_in`,
    {
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
    },
    LAB_TIMEOUT_MS,
  );

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

  const res = await fetchWithTimeout(
    `${LAB_API_BASE}${path}`,
    { headers: LAB_HEADERS() },
    LAB_TIMEOUT_MS,
  );

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

// ── Puppeteer singleton ─────────────────────────────────────────────────────
let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  const puppeteer = await import("puppeteer");
  browserInstance = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const cleanup = () => {
    if (browserInstance) browserInstance.close().catch(() => {});
    browserInstance = null;
  };
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  return browserInstance;
}

// ── Capture the exact HealthRay PDF via authenticated headless browser ───────
// The report page generates a PDF client-side but needs auth tokens for its
// internal API calls. We inject tokens via localStorage + request interception,
// then capture the resulting blob from the <iframe src="blob:...">.
export async function fetchLabReportPdf(caseUid, caseId) {
  const reportUrl = `https://lab.healthray.com/download-report/pt/1/${caseUid}/${caseId}`;
  let page;
  try {
    // Ensure we have fresh auth tokens
    if (!authToken) await labLogin();

    const browser = await getBrowser();
    page = await browser.newPage();

    // ── Step 1: Intercept all API requests and inject auth headers ────
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url().includes("labapi.healthray.com")) {
        req.continue({
          headers: {
            ...req.headers(),
            "x-auth-token": authToken,
            "x-device-token": DEVICE_TOKEN || "",
            "x-healthray-access-token": accessToken || "",
          },
        });
      } else {
        req.continue();
      }
    });

    // ── Step 2: Hook blob creation to capture the PDF ─────────────────
    await page.evaluateOnNewDocument(() => {
      window.__pdfBlob = null;
      window.__pdfBlobUrl = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = function (blob) {
        const url = orig.call(URL, blob);
        if (blob && blob.size > 5000) {
          window.__pdfBlob = blob;
          window.__pdfBlobUrl = url;
        }
        return url;
      };
    });

    // ── Step 3: Navigate to lab.healthray.com to set domain context ───
    await page.goto("https://lab.healthray.com", { waitUntil: "domcontentloaded", timeout: 30000 });

    // ── Step 4: Inject auth tokens into localStorage ──────────────────
    await page.evaluate(
      (tokens) => {
        // Try all common key patterns HealthRay might use
        const keys = [
          "auth_token",
          "access_token",
          "authToken",
          "accessToken",
          "healthray_auth_token",
          "healthray_access_token",
          "x-auth-token",
          "x-healthray-access-token",
          "token",
          "user_token",
        ];
        for (const k of keys) {
          if (k.includes("access")) {
            localStorage.setItem(k, tokens.accessToken || "");
          } else {
            localStorage.setItem(k, tokens.authToken || "");
          }
        }
        // Also store as a user object (common pattern)
        try {
          const existing = JSON.parse(localStorage.getItem("user") || "{}");
          existing.authentication_token = tokens.authToken;
          existing.healthray_access_token = tokens.accessToken;
          existing.healthray_auth_token = tokens.authToken;
          localStorage.setItem("user", JSON.stringify(existing));
        } catch {}
        try {
          const existing = JSON.parse(localStorage.getItem("persist:root") || "{}");
          if (typeof existing === "object") {
            existing.auth_token = JSON.stringify(tokens.authToken);
            existing.access_token = JSON.stringify(tokens.accessToken);
            localStorage.setItem("persist:root", JSON.stringify(existing));
          }
        } catch {}
      },
      { authToken, accessToken },
    );

    // ── Step 5: Navigate to the report page ───────────────────────────
    log("PDF", `Navigating to ${reportUrl} (with auth)`);
    await page.goto(reportUrl, { waitUntil: "networkidle2", timeout: 90000 });

    // ── Step 6: Wait for blob capture or iframe ───────────────────────
    log("PDF", `Waiting for PDF for case ${caseId}...`);
    try {
      await page.waitForFunction(
        () =>
          window.__pdfBlobUrl ||
          document.querySelector('iframe[src^="blob:"]') ||
          document.querySelector('iframe[src^="data:application/pdf"]'),
        { timeout: 60000 },
      );
    } catch {
      const debug = await page.evaluate(() => ({
        bodySnippet: document.body?.innerText?.slice(0, 500),
        iframes: [...document.querySelectorAll("iframe")].map((f) => f.src?.slice(0, 120)),
        blobUrl: window.__pdfBlobUrl,
        localStorage: Object.keys(localStorage).join(", "),
      }));
      log("PDF", `Timeout for case ${caseId}: ${JSON.stringify(debug)}`);
      return null;
    }

    await new Promise((r) => setTimeout(r, 2000));

    // ── Step 7: Extract the PDF blob ──────────────────────────────────
    const pdfArray = await page.evaluate(async () => {
      // Try hooked blob first
      if (window.__pdfBlob) {
        try {
          const ab = await window.__pdfBlob.arrayBuffer();
          if (ab.byteLength > 1000) return Array.from(new Uint8Array(ab));
        } catch {}
      }
      if (window.__pdfBlobUrl) {
        try {
          const r = await fetch(window.__pdfBlobUrl);
          const ab = await r.arrayBuffer();
          if (ab.byteLength > 1000) return Array.from(new Uint8Array(ab));
        } catch {}
      }
      const iframe = document.querySelector('iframe[src^="blob:"]');
      if (iframe?.src) {
        try {
          const r = await fetch(iframe.src);
          const ab = await r.arrayBuffer();
          if (ab.byteLength > 1000) return Array.from(new Uint8Array(ab));
        } catch {}
      }
      // Try data: URI iframe (HealthRay sometimes embeds PDF as base64 data URI)
      const dataIframe = document.querySelector('iframe[src^="data:application/pdf"]');
      if (dataIframe?.src) {
        try {
          const commaIdx = dataIframe.src.indexOf(",");
          if (commaIdx !== -1) {
            const b64 = dataIframe.src.substring(commaIdx + 1);
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            if (bytes.byteLength > 1000) return Array.from(bytes);
          }
        } catch {}
      }
      return null;
    });

    if (!pdfArray || pdfArray.length === 0) {
      log("PDF", `No PDF data extracted for case ${caseId}`);
      return null;
    }

    const buffer = Buffer.from(pdfArray);
    log("PDF", `Captured ${buffer.length} bytes for case ${caseId} (exact HealthRay PDF)`);
    return { buffer, contentType: "application/pdf" };
  } catch (e) {
    log("PDF", `FAIL case ${caseId}: ${e.message}`);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
