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
