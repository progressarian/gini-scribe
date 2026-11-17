import { cronPool } from "../../config/db.js";
import { CRON_LOCK_KEYS, tryAcquireCronLock } from "./lowPriority.js";
import { runPharmacyAlertSweep } from "../pharmacy/alerts.js";

const TICK_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_MS = 2 * 60 * 1000;

let timer = null;

const enabled = () => process.env.PHARMACY_ALERTS !== "0";

async function tick() {
  const release = await tryAcquireCronLock(
    "pharmacy-alerts-sweep",
    CRON_LOCK_KEYS.PHARMACY_ALERTS_SWEEP,
  ).catch(() => null);
  try {
    if (release) {
      const result = await runPharmacyAlertSweep(cronPool);
      console.log(`[Pharmacy Alerts] ${JSON.stringify(result)}`);
    }
  } catch (e) {
    console.error("[Pharmacy Alerts] sweep failed:", e.message);
  } finally {
    if (release) await release();
    if (timer) timer = setTimeout(tick, TICK_MS);
  }
}

export function startPharmacyAlertsCron() {
  if (!enabled() || timer) return;
  timer = setTimeout(tick, FIRST_RUN_MS);
  console.log("[Pharmacy Alerts] sweep every 6 h");
}

export function stopPharmacyAlertsCron() {
  if (timer) clearTimeout(timer);
  timer = null;
}
