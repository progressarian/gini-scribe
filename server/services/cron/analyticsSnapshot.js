// ── Population analytics snapshot — nightly rebuild of the /analytics report ──
//
// The full report scans lab_results (540k rows) and medications (178k rows) and
// takes ~90s. That is far too slow for a request, and the API and worker are
// separate Railway services so an in-process cache would not be shared between
// them. The worker therefore builds it once a night into analytics_snapshots and
// every reader serves from there.
//
// Cadence is a 30-minute tick that only fires the build inside the 02:00–03:59
// local window, and only when today's snapshot does not already exist. That keeps
// the heavy scan away from clinic hours without needing a cron library — the
// repo deliberately uses self-rescheduling timers everywhere else.

import { cronPool } from "../../config/db.js";
import { createLogger } from "../logger.js";
import { tryAcquireCronLock, CRON_LOCK_KEYS } from "./lowPriority.js";
import { latestSnapshotMeta, rebuildSnapshot } from "../analytics/snapshot.js";

const { log, error } = createLogger("Analytics Snapshot");

const TICK_MS = 30 * 60 * 1000;
const BUILD_WINDOW_START_HOUR = 2;
const BUILD_WINDOW_END_HOUR = 4;

let timer = null;

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function runAnalyticsSnapshot({ force = false } = {}) {
  const release = await tryAcquireCronLock("analytics-snapshot", CRON_LOCK_KEYS.ANALYTICS_SNAPSHOT);
  if (!release) return { skipped: "locked" };
  try {
    const asOf = today();
    if (!force) {
      const latest = await latestSnapshotMeta(cronPool);
      if (latest && String(latest.as_of) === asOf) return { skipped: "already-built" };
    }
    log(`building snapshot for ${asOf}...`);
    const started = Date.now();
    const { id, report } = await rebuildSnapshot(cronPool, { asOf });
    log(`snapshot ${id} written in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { id, as_of: report.meta.as_of, build_ms: report.meta.build_ms };
  } catch (e) {
    error("snapshot build failed:", e.message);
    return { error: e.message };
  } finally {
    await release();
  }
}

async function tick() {
  const hour = new Date().getHours();
  if (hour >= BUILD_WINDOW_START_HOUR && hour < BUILD_WINDOW_END_HOUR) {
    await runAnalyticsSnapshot();
  }
}

export function startAnalyticsSnapshotCron() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((e) => error("tick failed:", e.message));
  }, TICK_MS);
  log(
    `started — checks every ${TICK_MS / 60000} min, builds between 0${BUILD_WINDOW_START_HOUR}:00 and 0${BUILD_WINDOW_END_HOUR}:00`,
  );
}

export function stopAnalyticsSnapshotCron() {
  if (timer) clearInterval(timer);
  timer = null;
}
