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
let lastLoginAt = 0;
let loginInFlight = null; // Promise singleton — coalesces concurrent logins

// Tokens have empirically lasted well over an hour, but long batch runs
// (the resync script) can outlast them. Refresh proactively before that
// becomes a problem — the puppeteer path can't auto-401-retry like labFetch.
const TOKEN_MAX_AGE_MS = 30 * 60 * 1000; // 30 min

// HealthRay's PDF renderer falls over under heavy concurrent load — multiple
// simultaneous /download-report requests get stuck on "Generating PDF preview..."
// because the backend serialises generation. Default to 1 (strictly serial)
// so the outer concurrency (case_detail fetches) can stay high without
// overwhelming HealthRay's PDF service. Override via LAB_PUPPETEER_CONCURRENCY
// once steady-state cron resumes (e.g. =2 for incremental syncs).
const PUPPETEER_MAX_CONCURRENT = parseInt(process.env.LAB_PUPPETEER_CONCURRENCY || "1", 10);
let puppeteerInFlight = 0;
const puppeteerWaiters = [];

async function acquirePuppeteerSlot() {
  if (puppeteerInFlight < PUPPETEER_MAX_CONCURRENT) {
    puppeteerInFlight++;
    return;
  }
  await new Promise((resolve) => puppeteerWaiters.push(resolve));
  puppeteerInFlight++;
}

function releasePuppeteerSlot() {
  puppeteerInFlight--;
  const next = puppeteerWaiters.shift();
  if (next) next();
}

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
// Coalesces concurrent calls so 10 parallel workers don't all hit /sign_in.
export async function labLogin() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = doLogin().finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}

async function doLogin() {
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
  lastLoginAt = Date.now();

  log("Login", "Tokens refreshed successfully");
  return { authToken, accessToken };
}

// Refresh tokens if missing or older than TOKEN_MAX_AGE_MS — used by the
// puppeteer path which has no 401 retry of its own.
async function ensureFreshTokens() {
  if (!authToken || Date.now() - lastLoginAt > TOKEN_MAX_AGE_MS) {
    await labLogin();
  }
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
//
// Returns one of:
//   { buffer, contentType }  — success
//   { unavailable: true }    — HealthRay's UI explicitly says "No Report Found"
//                              (definitive — no PDF exists for this case)
//   null                     — transient failure (nav timeout, render stuck,
//                              extraction failure). Caller may retry later.
export async function fetchLabReportPdf(caseUid, caseId) {
  // Throttle to PUPPETEER_MAX_CONCURRENT — HealthRay's PDF backend serialises
  // generation, so concurrent /download-report navigations stall on
  // "Generating PDF preview..." until the underlying queue drains. Default 1.
  await acquirePuppeteerSlot();
  const reportUrl = `https://lab.healthray.com/download-report/pt/1/${caseUid}/${caseId}`;

  try {
    await ensureFreshTokens();
    const browser = await getBrowser();

    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await attemptFetchPdf(browser, reportUrl, caseId, attempt);

      if (result.outcome === "success") {
        return { buffer: result.buffer, contentType: "application/pdf" };
      }
      if (result.outcome === "no-report") {
        // Definitive — HealthRay has no PDF for this case. Don't retry.
        return { unavailable: true };
      }
      if (result.outcome === "render-stuck") {
        // HealthRay's PDF backend never finished. Retrying queues another
        // generation request behind the slow one — counterproductive.
        return null;
      }
      // 'transient-failure' — falls through to next attempt
      if (attempt < MAX_ATTEMPTS) {
        log(
          "PDF",
          `case ${caseId}: retrying after transient failure (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return null;
  } catch (e) {
    log("PDF", `FAIL case ${caseId}: ${e.message}`);
    return null;
  } finally {
    releasePuppeteerSlot();
  }
}

// One PDF download attempt with a fresh isolated context. Returns a
// discriminated outcome the caller uses to decide whether to retry.
async function attemptFetchPdf(browser, reportUrl, caseId, attempt) {
  let page;
  let context;
  try {
    // Use an isolated browser context per attempt — the HealthRay SPA reads
    // and rewrites localStorage during boot, and concurrent pages in the
    // shared default context were racing to clobber each other's tokens.
    context = await (browser.createBrowserContext
      ? browser.createBrowserContext()
      : browser.createIncognitoBrowserContext());
    page = await context.newPage();

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

    // ── Step 2: Hook blob creation + inject auth tokens BEFORE any page
    // script runs. evaluateOnNewDocument runs on every new document as soon
    // as it's created and BEFORE page scripts execute, so the SPA boots
    // with our tokens already in localStorage on the first navigation.
    await page.evaluateOnNewDocument(
      (tokens) => {
        window.__pdfBlob = null;
        window.__pdfBlobUrl = null;
        const orig = URL.createObjectURL;
        URL.createObjectURL = function (blob) {
          const url = orig.call(URL, blob);
          if (blob && blob.size > 5000) {
            if (!window.__pdfBlob || blob.size > window.__pdfBlob.size) {
              window.__pdfBlob = blob;
              window.__pdfBlobUrl = url;
            }
          }
          return url;
        };

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
        try {
          for (const k of keys) {
            if (k.includes("access")) {
              localStorage.setItem(k, tokens.accessToken || "");
            } else {
              localStorage.setItem(k, tokens.authToken || "");
            }
          }
          try {
            const u = JSON.parse(localStorage.getItem("user") || "{}");
            u.authentication_token = tokens.authToken;
            u.healthray_access_token = tokens.accessToken;
            u.healthray_auth_token = tokens.authToken;
            localStorage.setItem("user", JSON.stringify(u));
          } catch {}
          try {
            const root = JSON.parse(localStorage.getItem("persist:root") || "{}");
            if (typeof root === "object") {
              root.auth_token = JSON.stringify(tokens.authToken);
              root.access_token = JSON.stringify(tokens.accessToken);
              localStorage.setItem("persist:root", JSON.stringify(root));
            }
          } catch {}
        } catch {
          // localStorage unavailable on the bootstrap origin (about:blank);
          // the next document load runs this block again with proper origin.
        }
      },
      { authToken, accessToken },
    );

    // ── Step 3: Navigate directly to the report URL ───────────────────
    log("PDF", `Navigating to ${reportUrl} (attempt ${attempt})`);
    try {
      await page.goto(reportUrl, { waitUntil: "networkidle2", timeout: 90000 });
    } catch (e) {
      log("PDF", `Nav timeout for case ${caseId} (attempt ${attempt}): ${e.message}`);
      return { outcome: "transient-failure" };
    }

    // ── Step 4: Wait for a discriminated outcome ──────────────────────
    // The predicate now distinguishes:
    //   "no-report"  → HealthRay's UI says no PDF exists (definitive)
    //   "pdf-ready"  → blob/iframe ready to extract
    // On timeout, classify as render-stuck (body still says "preparing") or
    // transient-failure (anything else).
    log("PDF", `Waiting for PDF for case ${caseId}...`);
    let tag;
    try {
      const handle = await page.waitForFunction(
        () => {
          const text = document.body?.innerText || "";
          if (/no report found/i.test(text)) return "no-report";
          if (
            window.__pdfBlobUrl ||
            document.querySelector('iframe[src^="blob:"]') ||
            document.querySelector('iframe[src^="data:application/pdf"]')
          )
            return "pdf-ready";
          return false;
        },
        { timeout: 180000 },
      );
      tag = await handle.jsonValue();
    } catch {
      const debug = await page.evaluate(() => ({
        bodySnippet: document.body?.innerText?.slice(0, 500),
        iframes: [...document.querySelectorAll("iframe")].map((f) => f.src?.slice(0, 120)),
        blobUrl: window.__pdfBlobUrl,
        localStorage: Object.keys(localStorage).join(", "),
      }));
      log("PDF", `Timeout for case ${caseId} (attempt ${attempt}): ${JSON.stringify(debug)}`);
      const stuck = /preparing your pdf|generating pdf preview/i.test(debug.bodySnippet || "");
      return { outcome: stuck ? "render-stuck" : "transient-failure" };
    }

    if (tag === "no-report") {
      log("PDF", `No report found for case ${caseId} — marking unavailable`);
      return { outcome: "no-report" };
    }

    // tag === "pdf-ready" — extract the blob.
    // Wait for the blob size to STABILIZE — HealthRay's renderer commonly
    // emits an early empty/header-only PDF then replaces it once test rows
    // are fetched. Poll the largest captured blob's size and only proceed
    // once it stops growing for ~3 consecutive seconds.
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let lastSize = window.__pdfBlob?.size || 0;
      let stableTicks = 0;
      const tickMs = 1000;
      const maxTicks = 30;
      for (let i = 0; i < maxTicks; i++) {
        await sleep(tickMs);
        const size = window.__pdfBlob?.size || 0;
        if (size > 0 && size === lastSize) {
          stableTicks++;
          if (stableTicks >= 3) return;
        } else {
          stableTicks = 0;
          lastSize = size;
        }
      }
    });

    // ── Step 5: Extract the PDF blob ──────────────────────────────────
    const pdfArray = await page.evaluate(async () => {
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
      log("PDF", `No PDF data extracted for case ${caseId} (attempt ${attempt})`);
      return { outcome: "transient-failure" };
    }

    const buffer = Buffer.from(pdfArray);

    // Validate PDF integrity — guard against partial/garbage captures.
    const head = buffer.subarray(0, 5).toString("ascii");
    const tail = buffer.subarray(-1024).toString("ascii");
    if (head !== "%PDF-" || !tail.includes("%%EOF")) {
      log(
        "PDF",
        `Reject case ${caseId}: invalid PDF (head="${head}", hasEOF=${tail.includes("%%EOF")}, bytes=${buffer.length})`,
      );
      return { outcome: "transient-failure" };
    }

    log("PDF", `Captured ${buffer.length} bytes for case ${caseId} (attempt ${attempt})`);
    return { outcome: "success", buffer };
  } catch (e) {
    log("PDF", `attempt ${attempt} fail case ${caseId}: ${e.message}`);
    return { outcome: "transient-failure" };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}
