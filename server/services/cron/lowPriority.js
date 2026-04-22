import { cronPool } from "../../config/db.js";

// Shared Postgres advisory-lock key space for all background cron jobs.
// Using a single key means only one cron job holds the lock at a time,
// so healthray / lab / backfill / recovery can never pile onto the DB together.
const CRON_LOCK_KEY = 918273645;

/**
 * Try to acquire the global cron advisory lock. Returns a release() fn on success,
 * or null if another cron job already holds it (in which case the caller should skip this run).
 * The lock is session-scoped to the checked-out client, so the client must be released after unlock.
 */
export async function tryAcquireCronLock(label = "cron") {
  const client = await cronPool.connect();
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS got", [CRON_LOCK_KEY]);
    if (!rows[0]?.got) {
      client.release();
      console.log(`[Cron] ${label} skipped — another sync job holds the lock`);
      return null;
    }
    return async () => {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [CRON_LOCK_KEY]);
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
