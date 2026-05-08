// One-shot: re-run lab Healthray sync for the last N IST days (default 4).
// Idempotent — insertLabCase ON CONFLICT skips already-processed cases.
//
// Usage:
//   node server/scripts/resync-healthray-last-days.mjs            # last 4 days
//   node server/scripts/resync-healthray-last-days.mjs --days 7
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { runLabSync } = await import("../services/cron/labSync.js");

const daysIdx = process.argv.indexOf("--days");
const DAYS = daysIdx > -1 ? Number(process.argv[daysIdx + 1]) : 4;

function istDateNDaysAgo(n) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - n);
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

const dates = [];
for (let i = DAYS - 1; i >= 0; i--) dates.push(istDateNDaysAgo(i));

console.log(`[Resync] Healthray lab — ${DAYS} day(s): ${dates.join(", ")}`);

// runLabSync acquires the LAB_SYNC advisory lock — the production cron
// (every 5 min) may be holding it. Returns undefined when skipped, so retry
// with backoff until we slot in.
async function runWithRetry(date, attempts = 30, delayMs = 30_000) {
  for (let i = 1; i <= attempts; i++) {
    const r = await runLabSync(date);
    if (r !== undefined) return r;
    if (i === attempts) throw new Error(`lock held after ${attempts} attempts`);
    console.log(`[Resync] ${date} — lock held, waiting ${delayMs / 1000}s (attempt ${i}/${attempts})`);
    await new Promise((res) => setTimeout(res, delayMs));
  }
}

const summary = [];
for (const date of dates) {
  console.log(`\n[Resync] === ${date} ===`);
  try {
    const r = await runWithRetry(date);
    summary.push({ date, ...(r || {}) });
  } catch (e) {
    console.error(`[Resync] ${date} failed:`, e.message);
    summary.push({ date, error: e.message });
  }
}

console.log("\n[Resync] Summary:");
console.table(summary);

await pool.end();
process.exit(0);
