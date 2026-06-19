import { cronPool } from "../../config/db.js";

// Per-family Postgres advisory-lock keys. Each background job family has its
// own key so jobs of *different* families never block each other — only a job
// of the same family (e.g. a still-running HealthRay sync) blocks the next
// run of that same family. This prevents the OPD appointment tick from being
// starved by Lab Sync / Backfill / Recovery jobs.
export const CRON_LOCK_KEYS = {
  HEALTHRAY_SYNC: 918273645,
  LAB_SYNC: 918273646,
  LAB_RECOVERY: 918273647,
  DAILY_OPD_BACKFILL: 918273648,
  STUCK_STATUS_RECOVERY: 918273649,
  MISSING_MEDS_RECOVERY: 918273650,
  SHEETS_SYNC: 918273651,
  TODAYS_SHOW_SYNC: 918273652,
  LAB_PDF_RETRY: 918273653,
  LAB_BLANK_SWEEP: 918273654,
  LAB_PARTIAL_RETRY: 918273655,
};

/**
 * Try to acquire a per-family cron advisory lock. Returns a release() fn on success,
 * or null if another run of the *same family* already holds it (caller should skip).
 * The lock is session-scoped to the checked-out client, so the client must be released after unlock.
 */
export async function tryAcquireCronLock(label = "cron", key) {
  if (!Number.isFinite(key)) {
    throw new Error(`tryAcquireCronLock(${label}): numeric key is required`);
  }
  const client = await cronPool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS got", [key]);
    if (!rows[0]?.got) {
      client.release();
      console.log(`[Cron] ${label} skipped — previous ${label} run still holds its lock`);
      return null;
    }
    return async () => {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [key]);
      } catch (e) {
        console.error(`[Cron] ${label} unlock failed:`, e.message);
      } finally {
        client.release();
      }
    };
  } catch (e) {
    client.release();
    throw e;
  }
}

/**
 * Yield the event loop so user-facing HTTP requests can be serviced between sync batches.
 * Background sync should sprinkle these between every item it processes.
 */
export function yieldToApp(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a fetch() call with an AbortController timeout so a slow upstream
 * can't hold a background worker indefinitely.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Outbound rate limiter — the permanent fix for HealthRay's WAF 403 IP-block.
 *
 * The sync loops fan out ~29 appointment requests in parallel (Promise.allSettled
 * over every doctor) every few seconds with nothing spacing them, which reads as
 * a bot/scrape burst and gets the server IP rate-limited/blocklisted. Funnelling
 * every outbound call for an upstream through ONE shared limiter converts those
 * bursts into a smooth, capped stream WITHOUT changing any call site — the
 * fan-out still works, it just drains at `ratePerSec` with at most
 * `maxConcurrent` requests in flight.
 *
 * Usage:
 *   const limiter = createRateLimiter({ ratePerSec: 3, maxConcurrent: 2 });
 *   const release = await limiter.acquire();
 *   try { return await fetchWithTimeout(url, opts, ms); } finally { release(); }
 *
 * acquire() resolves with a release() fn once a slot is free and the minimum
 * spacing since the previous start has elapsed. release() MUST be called (use
 * try/finally) or the limiter will leak slots.
 */
export function createRateLimiter({ ratePerSec = 3, maxConcurrent = 2 } = {}) {
  const minIntervalMs = ratePerSec > 0 ? 1000 / ratePerSec : 0;
  let active = 0;
  let lastStartAt = 0;
  let timer = null;
  const queue = [];

  const release = () => {
    active = Math.max(0, active - 1);
    pump();
  };

  function pump() {
    if (timer) return; // a wake-up is already scheduled
    if (!queue.length || active >= maxConcurrent) return;
    const wait = Math.max(0, lastStartAt + minIntervalMs - Date.now());
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, wait);
      return;
    }
    active++;
    lastStartAt = Date.now();
    queue.shift()(); // grant one waiter (resolves its acquire())
    if (queue.length) pump(); // schedule the next grant (will hit the spacing wait)
  }

  return {
    acquire() {
      return new Promise((resolve) => {
        queue.push(() => resolve(release));
        pump();
      });
    },
  };
}
