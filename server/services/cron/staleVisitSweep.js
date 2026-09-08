// ── Stale visit sweep — closes yesterday's visits nobody closed ──────────────
//
// The floor still works much of the day on HealthRay, so visits are left in a
// live chain status when the patient has long gone home. Left alone they read
// as "still on the floor" for ever and drag every average with them.
//
// Runs shortly after midnight IST — the day being swept is over by definition,
// so nothing it touches can still be worked. Same self-rescheduling tick as the
// analytics snapshot rather than a cron library, and the same advisory lock, so
// two worker instances cannot both sweep.

import { cronPool } from "../../config/db.js";
import { createLogger } from "../logger.js";
import { tryAcquireCronLock, CRON_LOCK_KEYS } from "./lowPriority.js";
import { sweepStaleVisits } from "../giniflow/staleVisits.js";

const { log, error } = createLogger("Stale Visit Sweep");

const TICK_MS = 30 * 60 * 1000;
const WINDOW_START_HOUR_IST = 0;
const WINDOW_END_HOUR_IST = 3;

let timer = null;

const istHour = () =>
  Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );

export async function runStaleVisitSweep() {
  const release = await tryAcquireCronLock("stale-visit-sweep", CRON_LOCK_KEYS.STALE_VISIT_SWEEP);
  if (!release) return { skipped: "locked" };
  try {
    const { found, changed, changes } = await sweepStaleVisits({ db: cronPool });
    if (changed) {
      const byTarget = changes.reduce((a, c) => ({ ...a, [c.to]: (a[c.to] || 0) + 1 }), {});
      log(`closed ${changed} of ${found} stale visits — ${JSON.stringify(byTarget)}`);
    }
    return { found, changed };
  } catch (e) {
    error("sweep failed:", e.message);
    return { error: e.message };
  } finally {
    await release();
  }
}

async function tick() {
  const hour = istHour();
  if (hour >= WINDOW_START_HOUR_IST && hour < WINDOW_END_HOUR_IST) await runStaleVisitSweep();
}

export function startStaleVisitSweepCron() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((e) => error("tick failed:", e.message));
  }, TICK_MS);
  log(
    `started — checks every ${TICK_MS / 60000} min, sweeps between 0${WINDOW_START_HOUR_IST}:00 and 0${WINDOW_END_HOUR_IST}:00 IST`,
  );
}

export function stopStaleVisitSweepCron() {
  if (timer) clearInterval(timer);
  timer = null;
}
