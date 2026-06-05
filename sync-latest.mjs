// ─────────────────────────────────────────────────────────────────────────────
// sync-latest.mjs
//
// Pulls the LATEST appointment data from HealthRay into the database for a
// forward window of dates (so upcoming appointments — e.g. Jun 9+ — appear on
// the /ghm sheet). Uses the app's own HealthRay sync engine, which fetches
// appointments per-doctor per-day in pages of 100 and upserts them into the DB.
//
// Each date is synced (100-per-page batches internally) and the DB is updated.
//
// Usage:
//   node sync-latest.mjs                 # today → today + 30 days
//   node sync-latest.mjs 2026-06-08 2026-06-30   # explicit range
//   node sync-latest.mjs --days 14       # today → today + 14 days
//
// Requires (already in .env): HEALTHRAY_MOBILE, HEALTHRAY_PASSWORD,
//   HEALTHRAY_CAPTCHA, HEALTHRAY_ORG_ID, and ANTHROPIC_API_KEY (for note parse).
// ─────────────────────────────────────────────────────────────────────────────

import "./server/loadEnv.js";

const todayStr = () => new Date().toISOString().split("T")[0];
const addDays = (s, n) => {
  const d = new Date(s + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
};

// ── Resolve the date range from args ────────────────────────────────────────
let from, to;
const args = process.argv.slice(2);
if (args[0] === "--days") {
  from = todayStr();
  to = addDays(from, parseInt(args[1] || "30", 10));
} else if (args[0] && args[1]) {
  from = args[0];
  to = args[1];
} else {
  from = todayStr();
  to = addDays(from, 30);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "WARN: ANTHROPIC_API_KEY not set — future appointments usually have no clinical notes, " +
      "so this is normally fine, but past visits won't re-parse.",
  );
}

console.log(`\n=== HealthRay latest-data sync ===`);
console.log(`Range: ${from} → ${to}\n`);

const { syncDateRange, getRangeSyncStatus } = await import(
  "./server/services/cron/healthraySync.js"
);
const { default: pool } = await import("./server/config/db.js");

// Snapshot counts before
async function countRange() {
  const r = await pool.query(
    `SELECT appointment_date::text dt, COUNT(*)::int c
     FROM appointments WHERE appointment_date BETWEEN $1 AND $2
     GROUP BY appointment_date ORDER BY appointment_date`,
    [from, to],
  );
  return r.rows;
}

const before = await countRange();
const beforeTotal = before.reduce((a, r) => a + r.c, 0);
console.log(`Before: ${beforeTotal} appointments already in DB for this range.\n`);

// ── Kick off the range sync (runs in background) and poll until done ────────
try {
  const { total } = await syncDateRange(from, to);
  console.log(`Syncing ${total} day(s) from HealthRay…\n`);
} catch (e) {
  console.error("Could not start sync:", e.message);
  await pool.end();
  process.exit(1);
}

// Poll status until the background range job finishes
await new Promise((resolve) => {
  let lastDone = -1;
  const timer = setInterval(() => {
    const s = getRangeSyncStatus();
    if (s.done !== lastDone) {
      console.log(`  progress: ${s.done}/${s.total} days synced, ${s.errors} errors`);
      lastDone = s.done;
    }
    if (!s.running) {
      clearInterval(timer);
      resolve();
    }
  }, 2000);
});

// Snapshot counts after
const after = await countRange();
const afterTotal = after.reduce((a, r) => a + r.c, 0);

console.log(`\n=== Done ===`);
console.log(`Total appointments in range:  ${beforeTotal} → ${afterTotal}  (+${afterTotal - beforeTotal})\n`);
console.log(`Per-date counts now:`);
for (const r of after) console.log(`  ${r.dt}: ${r.c}`);

await pool.end();
process.exit(0);
