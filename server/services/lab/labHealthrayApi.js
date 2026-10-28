import pool from "../../config/db.js";
import { createLogger } from "../logger.js";
import { fetchWithTimeout, createRateLimiter } from "../cron/lowPriority.js";
const { log } = createLogger("Lab Auth");

const LAB_API_BASE = "https://labapi.healthray.com/api/v1";

const LAB_TIMEOUT_MS = 20000;

const labLimiter = createRateLimiter({
  ratePerSec: Number(process.env.LAB_HEALTHRAY_MAX_RPS) || 2,
  maxConcurrent: Number(process.env.LAB_HEALTHRAY_MAX_CONCURRENT) || 1,
});
async function gatedFetch(url, options, timeoutMs) {
  const release = await labLimiter.acquire();
  try {
    return await fetchWithTimeout(url, options, timeoutMs);
  } finally {
    release();
  }
}

let authToken = process.env.LAB_HEALTHRAY_AUTH_TOKEN || null;
let accessToken = process.env.LAB_HEALTHRAY_ACCESS_TOKEN || null;
let lastLoginAt = 0;
let loginInFlight = null;
let blockFailCount = 0;
let blockBackoffUntil = 0;
let wafBlockCount = 0; // consecutive WAF 403/429 blocks — escalates the cooldown
let cooldownLoadPromise = null;

const BLOCK_BACKOFF_BASE_MS = 20_000; // non-block failures: 20s, doubles
const BLOCK_BACKOFF_MAX_MS = 10 * 60_000; // …capped at 10 min
const WAF_COOLDOWN_BASE_MS = 45 * 60_000; // WAF block: 45 min base
const WAF_COOLDOWN_MAX_MS = 2 * 60 * 60_000; // …escalates to a 2 h cap
const KV_LAB_COOLDOWN = "lab_login_cooldown";

async function kvGet(key) {
  try {
    return (
      (await pool.query("SELECT value FROM app_kv WHERE key=$1", [key])).rows[0]?.value ?? null
    );
  } catch {
    return null; // app_kv missing / DB blip → in-memory only
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
const COOLDOWN_RECHECK_MS = 15_000;
let cooldownCheckedAt = 0;

function loadPersistedCooldown() {
  if (!cooldownLoadPromise || Date.now() - cooldownCheckedAt > COOLDOWN_RECHECK_MS) {
    cooldownCheckedAt = Date.now();
    cooldownLoadPromise = (async () => {
      const c = await kvGet(KV_LAB_COOLDOWN);
      if (!c) return;
      blockBackoffUntil = c.until || 0;
      blockFailCount = c.failCount || 0;
      wafBlockCount = c.blockCount || 0;
    })();
  }
  return cooldownLoadPromise;
}

function isBackingOff() {
  return Date.now() < blockBackoffUntil;
}
function backoffRemainingS() {
  return Math.round((blockBackoffUntil - Date.now()) / 1000);
}
// `blocked` = a genuine WAF/IP-block (403/429); escalates the long cooldown.
function openBreaker(reason, blocked = false) {
  blockFailCount += 1;
  let ms;
  if (blocked) {
    wafBlockCount += 1;
    ms = Math.min(WAF_COOLDOWN_MAX_MS, WAF_COOLDOWN_BASE_MS * 2 ** (wafBlockCount - 1));
  } else {
    ms = Math.min(BLOCK_BACKOFF_MAX_MS, BLOCK_BACKOFF_BASE_MS * 2 ** (blockFailCount - 1));
  }
  blockBackoffUntil = Date.now() + ms;
  kvSet(KV_LAB_COOLDOWN, {
    until: blockBackoffUntil,
    failCount: blockFailCount,
    blockCount: wafBlockCount,
    reason,
  });
  if (blocked) {
    log(
      "Breaker",
      `⚠ BLOCKED by lab WAF — block #${wafBlockCount}, cooling down ${Math.round(ms / 60000)}min ` +
        `(auto-recovers, no redeploy). Permanent fix: set HEALTHRAY_PROXY_URL to a static egress IP allowlisted by HealthRay.`,
    );
  } else {
    log(
      "Breaker",
      `${reason} — backing off ${Math.round(ms / 1000)}s (${blockFailCount} consecutive failures)`,
    );
  }
}
function resetBreaker() {
  if (blockFailCount || wafBlockCount) log("Breaker", "Lab API recovered — back-off cleared");
  blockFailCount = 0;
  blockBackoffUntil = 0;
  wafBlockCount = 0;
  kvSet(KV_LAB_COOLDOWN, { until: 0, failCount: 0, blockCount: 0, reason: "" });
}
const TOKEN_MAX_AGE_MS = 30 * 60 * 1000; // 30 min

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

  await loadPersistedCooldown();
  if (isBackingOff()) {
    throw new Error(
      `Lab login backing off (${blockFailCount} consecutive failures) — next attempt in ~${backoffRemainingS()}s`,
    );
  }

  log("Login", `Logging in as ${mobile}...`);

  let wafBlocked = false;
  try {
    const res = await gatedFetch(
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

    wafBlocked = res.status === 403 || res.status === 429;
    const json = await res.json().catch(() => ({}));

    if (json.status !== 200) {
      throw new Error(
        `Lab login failed: ${json.message || `HTTP ${res.status}`} [http=${res.status}]`,
      );
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
    resetBreaker();

    log("Login", "Tokens refreshed successfully");
    return { authToken, accessToken };
  } catch (e) {
    openBreaker(`login failed: ${e.message}`, wafBlocked);
    throw e;
  }
}

async function ensureFreshTokens() {
  if (!authToken || Date.now() - lastLoginAt > TOKEN_MAX_AGE_MS) {
    await labLogin();
  }
}

// ── Core fetch with auto-retry on 401 ───────────────────────────────────────
async function labFetch(path, isRetry = false) {
  await loadPersistedCooldown();
  if (isBackingOff()) {
    throw new Error(
      `Lab API backing off (${blockFailCount} consecutive failures) — next attempt in ~${backoffRemainingS()}s`,
    );
  }

  // Auto-login if no token in memory yet
  if (!authToken) {
    await labLogin();
  }

  const res = await gatedFetch(
    `${LAB_API_BASE}${path}`,
    { headers: LAB_HEADERS() },
    LAB_TIMEOUT_MS,
  );

  if (res.status === 401 && !isRetry) {
    log("Auth", "401 received — refreshing tokens...");
    await labLogin();
    return labFetch(path, true);
  }

  if (res.status === 403 || res.status === 429) {
    openBreaker(`HTTP ${res.status} at ${path}`, true);
    throw new Error(`Lab API HTTP ${res.status} at ${path}`);
  }

  if (!res.ok) throw new Error(`Lab API HTTP ${res.status} at ${path}`);

  const json = await res.json();
  if (json.status !== 200) throw new Error(`Lab API error: ${json.message}`);
  resetBreaker(); // a successful fetch proves the block has cleared
  return json.data;
}

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

export async function fetchLabReportPdf(caseUid, caseId) {
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

async function attemptFetchPdf(browser, reportUrl, caseId, attempt) {
  let page;
  let context;
  try {
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
        } catch {}
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
