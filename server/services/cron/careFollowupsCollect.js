import { cronPool } from "../../config/db.js";
import { collectFollowups } from "../careFollowups/collect.js";

const TICK_MS = 15 * 60 * 1000;
const FIRST_RUN_MS = 60 * 1000;

let timer = null;

const enabled = () => process.env.CARE_FOLLOWUPS_COLLECT === "1";

async function tick() {
  try {
    const result = await collectFollowups({ db: cronPool });
    const added = Object.values(result.sources || {}).reduce((n, s) => n + (s.added || 0), 0);
    if (added || result.moved) {
      console.log(`[Care Follow-ups] added ${added}, moved ${result.moved || 0}`);
    }
  } catch (e) {
    console.error("[Care Follow-ups] collect failed:", e.message);
  } finally {
    if (timer) timer = setTimeout(tick, TICK_MS);
  }
}

export function startCareFollowupsCron() {
  if (!enabled() || timer) return;
  timer = setTimeout(tick, FIRST_RUN_MS);
  console.log("[Care Follow-ups] collect every 15 min");
}

export function stopCareFollowupsCron() {
  if (timer) clearTimeout(timer);
  timer = null;
}
