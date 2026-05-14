/**
 * One-time script: Map legacy free-text `medications.timing` into the new
 * `when_to_take` column, constrained to the 11 patient-facing pill values:
 *   Fasting, Before breakfast, After breakfast, Before lunch, After lunch,
 *   Before dinner, After dinner, At bedtime, With milk, SOS only, Any time.
 *
 * Run: node server/scripts/backfill-when-to-take.js
 * Dry run (no writes): node server/scripts/backfill-when-to-take.js --dry
 * Custom batch size:   node server/scripts/backfill-when-to-take.js --batch=500
 *
 * Processes rows in keyset-paginated batches (id > lastId LIMIT N). Each
 * batch is one transaction and logs progress + ETA so long runs are
 * observable. Default batch size is 10000. The script is idempotent:
 * rows whose existing `when_to_take` already matches what we'd write are
 * skipped, so re-running after a partial run only touches the remainder.
 */
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

const DRY = process.argv.includes("--dry");
const BATCH_SIZE = (() => {
  const arg = process.argv.find((a) => a.startsWith("--batch="));
  const n = arg ? Number(arg.slice("--batch=".length)) : 10000;
  return Number.isFinite(n) && n > 0 ? n : 10000;
})();

const PILLS = [
  "Fasting",
  "Before breakfast",
  "After breakfast",
  "Before lunch",
  "After lunch",
  "Before dinner",
  "After dinner",
  "At bedtime",
  "With milk",
  "SOS only",
  "Any time",
];

// Map a single free-text token (already lowercased + trimmed) to one or more
// pill values. Order of checks matters — most specific first.
function tokenToPills(raw, frequency) {
  const s = raw.toLowerCase().trim();
  if (!s) return [];
  const freq = (frequency || "").toUpperCase();

  // Exact pill match (case-insensitive)
  const exact = PILLS.find((p) => p.toLowerCase() === s);
  if (exact) return [exact];

  // Empty stomach / fasting
  if (/empty stomach|khaali pet|on empty|before food.*30|30.*before/.test(s)) return ["Fasting"];
  if (/^fast(ing)?$/.test(s)) return ["Fasting"];

  // Bedtime / night
  if (/bedtime|at bed|sleep|before sleep/.test(s)) return ["At bedtime"];
  if (/\bnight\b|at night|night time/.test(s) && !/before/.test(s)) return ["At bedtime"];

  // SOS / PRN / as needed
  if (/\bsos\b|\bprn\b|as ?needed|when ?needed|when ?required/.test(s)) return ["SOS only"];

  // With milk
  if (/with milk|in milk/.test(s)) return ["With milk"];

  // Topical / external / local application — patient takes any time
  if (/local application|topical|apply|external|cream|ointment|gel/.test(s)) return ["Any time"];

  // Before / after specific meals
  if (/before breakfast|pre[- ]?breakfast|morning before/.test(s)) return ["Before breakfast"];
  if (/after breakfast|post[- ]?breakfast|morning after/.test(s)) return ["After breakfast"];
  if (/before lunch|pre[- ]?lunch/.test(s)) return ["Before lunch"];
  if (/after lunch|post[- ]?lunch/.test(s)) return ["After lunch"];
  if (/before dinner|pre[- ]?dinner|before supper/.test(s)) return ["Before dinner"];
  if (/after dinner|post[- ]?dinner|after supper/.test(s)) return ["After dinner"];

  // Generic "before meals" / "after meals" — expand by frequency
  if (/before meal|before food|pre[- ]?meal/.test(s)) {
    if (freq === "TDS" || freq === "TID")
      return ["Before breakfast", "Before lunch", "Before dinner"];
    if (freq === "BD" || freq === "BID") return ["Before breakfast", "Before dinner"];
    return ["Before breakfast"];
  }
  if (/after meal|after food|post[- ]?meal|with meal|with food/.test(s)) {
    if (freq === "TDS" || freq === "TID") return ["After breakfast", "After lunch", "After dinner"];
    if (freq === "BD" || freq === "BID") return ["After breakfast", "After dinner"];
    return ["After breakfast"];
  }

  // Morning / afternoon / evening
  if (/^morning$|in the morning|^am$/.test(s)) return ["Before breakfast"];
  if (/^evening$|in the evening/.test(s)) return ["After dinner"];
  if (/afternoon/.test(s)) return ["After lunch"];

  // Unknown → Any time (fallback so we never leave the column blank)
  return ["Any time"];
}

function mapTiming(timingRaw, frequency) {
  if (!timingRaw) return null;
  const tokens = String(timingRaw)
    .split(/[,;|]|\s+and\s+|\s*\+\s*/i)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  const out = [];
  for (const tok of tokens) {
    for (const p of tokenToPills(tok, frequency)) {
      if (!out.includes(p)) out.push(p);
    }
  }
  return out.length ? out : null;
}

function arraysEqual(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  return A.length === B.length && A.every((v, i) => v === B[i]);
}

function fmtPct(n, total) {
  if (!total) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m${r}s` : `${s}s`;
}

async function run() {
  const startedAt = Date.now();
  console.log(`[backfill-when-to-take] mode=${DRY ? "DRY RUN" : "WRITE"} batchSize=${BATCH_SIZE}`);

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM medications
      WHERE timing IS NOT NULL AND timing <> ''`,
  );
  const total = countRes.rows[0].n;
  console.log(`[backfill-when-to-take] candidates: ${total}`);
  if (total === 0) {
    await pool.end();
    return;
  }

  const stats = { processed: 0, updated: 0, unchanged: 0, skipped: 0, byPill: {} };
  const samples = [];
  let lastId = 0;
  let batchIdx = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT id, timing, frequency, when_to_take
         FROM medications
        WHERE timing IS NOT NULL AND timing <> ''
          AND id > $1
        ORDER BY id ASC
        LIMIT $2`,
      [lastId, BATCH_SIZE],
    );
    if (!rows.length) break;
    batchIdx += 1;

    const batchStart = Date.now();
    const batchStats = { updated: 0, unchanged: 0, skipped: 0 };

    // Run all UPDATE queries in one transaction so a partial failure rolls
    // back the batch (safer for long runs) and we get one COMMIT per batch.
    if (!DRY) await pool.query("BEGIN");
    try {
      for (const m of rows) {
        const mapped = mapTiming(m.timing, m.frequency);
        if (!mapped) {
          batchStats.skipped++;
          continue;
        }
        if (arraysEqual(m.when_to_take, mapped)) {
          batchStats.unchanged++;
          continue;
        }
        for (const p of mapped) stats.byPill[p] = (stats.byPill[p] || 0) + 1;
        if (samples.length < 20) {
          samples.push({
            id: m.id,
            freq: m.frequency,
            from: m.timing,
            to: mapped.join(", "),
          });
        }
        if (!DRY) {
          // node-pg binds a JS array to a Postgres array param. Cast to the
          // enum array type so an empty/legacy column accepts the value.
          await pool.query(
            `UPDATE medications SET when_to_take = $1::when_to_take_pill[] WHERE id = $2`,
            [mapped, m.id],
          );
        }
        batchStats.updated++;
      }
      if (!DRY) await pool.query("COMMIT");
    } catch (e) {
      if (!DRY) await pool.query("ROLLBACK").catch(() => {});
      throw e;
    }

    stats.processed += rows.length;
    stats.updated += batchStats.updated;
    stats.unchanged += batchStats.unchanged;
    stats.skipped += batchStats.skipped;
    lastId = rows[rows.length - 1].id;

    const elapsed = Date.now() - startedAt;
    const rate = stats.processed / (elapsed / 1000);
    const remaining = Math.max(0, total - stats.processed);
    const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
    console.log(
      `[batch ${String(batchIdx).padStart(3)}] ` +
        `rows=${rows.length.toString().padStart(4)} ` +
        `updated=${batchStats.updated.toString().padStart(4)} ` +
        `unchanged=${batchStats.unchanged.toString().padStart(4)} ` +
        `skipped=${batchStats.skipped.toString().padStart(4)} ` +
        `| total ${stats.processed}/${total} (${fmtPct(stats.processed, total)}) ` +
        `lastId=${lastId} ` +
        `took=${fmtDuration(Date.now() - batchStart)} ` +
        `eta=${fmtDuration(etaSec * 1000)}`,
    );
  }

  console.log("\n[backfill-when-to-take] samples:");
  for (const s of samples) {
    console.log(`  #${s.id} [${s.freq || "-"}] "${s.from}" → "${s.to}"`);
  }
  console.log("\n[backfill-when-to-take] pill distribution:");
  for (const [p, n] of Object.entries(stats.byPill).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(18)} ${n}`);
  }
  console.log(
    `\n[backfill-when-to-take] done in ${fmtDuration(Date.now() - startedAt)}. ` +
      `processed=${stats.processed} updated=${stats.updated} unchanged=${stats.unchanged} skipped=${stats.skipped}`,
  );
  await pool.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
