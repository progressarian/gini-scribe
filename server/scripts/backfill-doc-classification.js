/**
 * Backfill doc_type for HealthRay documents stuck in the catch-all 'other'
 * bucket.
 *
 * HealthRay files a lot of reports under record_type "Other" and generates
 * the filename from that record type, so mapRecordType() has no signal and
 * everything lands as doc_type='other'. Real ABI Doppler and VPT /
 * biothesiometry studies are therefore invisible in the Labs tab's ABI and
 * VPT buckets. This reads each file and re-types it.
 *
 * It just drives the same sweep the cron runs (runDocumentClassification),
 * in a loop, until the queue drains. Safe to stop and re-run: every row it
 * looks at is marked `autoclass:<result>` in notes, which is also the
 * not-yet-processed filter, so a re-run picks up exactly where it left off
 * and never re-bills a document.
 *
 * COST: one Claude call per document. Roughly 6,000 documents pending at the
 * time of writing. Model defaults to claude-haiku-4-5; override with
 * DOC_CLASSIFIER_MODEL if you want a stronger (and more expensive) model.
 *
 * PACING: --source picks where files are fetched from. `supabase` docs are
 * already cached and free to read. `healthray` docs need a download from
 * HealthRay, whose WAF 403-blocks our IP when it sees bulk volume — and that
 * block also takes out the live OPD sync. Clear `--source=supabase` first,
 * then work the HealthRay pile in paced chunks (--limit) rather than in one
 * burst. Each HealthRay file is downloaded once ever: downloadAndStore caches
 * it to Supabase on the way through.
 *
 * Usage:
 *   node server/scripts/backfill-doc-classification.js                      # dry-run sample
 *   node server/scripts/backfill-doc-classification.js --limit=50           # dry-run, 50 docs
 *   node server/scripts/backfill-doc-classification.js --apply --source=supabase
 *   node server/scripts/backfill-doc-classification.js --apply --source=healthray --limit=300
 *   node server/scripts/backfill-doc-classification.js --apply --patient=18643
 *   node server/scripts/backfill-doc-classification.js --apply              # everything
 *   node server/scripts/backfill-doc-classification.js --apply --reset-other --source=supabase
 *
 * --reset-other re-opens rows already settled as 'other' so they are judged
 * against the current category list. Pass it once after adding a category
 * (it re-bills one call per reopened row), not routinely.
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { runDocumentClassification, countPendingClassification, resetOtherMarkers } =
  await import("../services/cron/documentClassification.js");

const args = process.argv.slice(2);
const DRY = !args.includes("--apply");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 0;
const PATIENT = Number(args.find((a) => a.startsWith("--patient="))?.split("=")[1]) || null;
const SOURCE = args.find((a) => a.startsWith("--source="))?.split("=")[1] || "all";
// Smaller batches keep concurrent DB connections and in-flight downloads low.
// DOC_CLASSIFY_CONCURRENCY (default 4) caps how many of a batch run at once,
// so peak pool usage is roughly that, not the batch size.
const BATCH = Number(args.find((a) => a.startsWith("--batch="))?.split("=")[1]) || 25;
// Breather between batches — lets the connection pool drain and keeps the
// HealthRay request rate well under what its WAF reads as scraping.
const DELAY_MS = Number(args.find((a) => a.startsWith("--delay="))?.split("=")[1]) || 3000;

// Re-open documents previously settled as 'other' so they get re-judged
// against the current category list. Only worth passing after the taxonomy
// gains a type (e.g. "eye") — it costs one classifier call per reopened row.
const RESET_OTHER = args.includes("--reset-other");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  if (RESET_OTHER) {
    if (DRY) {
      console.log("[Backfill] --reset-other ignored on a dry run (it writes). Add --apply.");
    } else {
      const reopened = await resetOtherMarkers(PATIENT, SOURCE);
      console.log(`[Backfill] Reopened ${reopened} document(s) previously classified as 'other'.`);
    }
  }

  const pending = await countPendingClassification(PATIENT, SOURCE);
  const target = LIMIT ? Math.min(LIMIT, pending) : pending;
  if (target === 0) {
    console.log(
      `[Backfill] Nothing pending classification${PATIENT ? ` for patient ${PATIENT}` : ""}.`,
    );
    return;
  }

  // A dry run is a single batch — it writes no autoclass marker, so looping
  // would just re-classify the same rows. Cap it so the count we print is
  // the count we actually process.
  const cap = DRY ? Math.min(target, BATCH) : target;

  console.log(
    `[Backfill] ${pending} document(s) pending classification` +
      (PATIENT ? ` for patient ${PATIENT}` : "") +
      (SOURCE !== "all" ? ` [source=${SOURCE}]` : "") +
      ` — processing ${cap}${DRY ? " (DRY RUN — no writes, one batch only)" : ""}`,
  );

  // No cross-process lock needed: the sweep claims rows atomically with
  // FOR UPDATE SKIP LOCKED, so this and the every-10-min cron simply take
  // disjoint sets and never double-bill a document.
  const totals = { total: 0, retyped: 0, keptOther: 0, unavailable: 0, errors: 0, byType: {} };
  {
    let processed = 0;
    while (processed < cap) {
      const batch = Math.min(BATCH, cap - processed);
      const s = await runDocumentClassification({
        limit: batch,
        patientId: PATIENT,
        dryRun: DRY,
        source: SOURCE,
      });
      if (!s || s.total === 0) break;

      processed += s.total;
      totals.total += s.total;
      totals.retyped += s.retyped;
      totals.keptOther += s.keptOther;
      totals.unavailable += s.unavailable;
      totals.errors += s.errors;
      for (const [k, v] of Object.entries(s.byType)) totals.byType[k] = (totals.byType[k] || 0) + v;

      console.log(`[Backfill] progress ${processed}/${cap}`);

      // Bail out rather than grind through the whole backlog if the source
      // has started refusing us (HealthRay WAF 403 / auth expiry shows up as
      // every doc in the batch going unavailable).
      if (s.total > 0 && s.unavailable === s.total) {
        console.error(
          `[Backfill] ABORT — all ${s.total} docs in this batch were unavailable. ` +
            `Source is likely blocking or auth has expired; stopping before it gets worse.`,
        );
        break;
      }

      if (processed < cap && DELAY_MS) await sleep(DELAY_MS);

      // A dry run writes no autoclass marker, so the same rows stay eligible
      // and the next batch would re-classify (and re-bill) them forever. One
      // batch is the whole dry run.
      if (DRY) break;
    }
  }

  console.log("\n[Backfill] ===== SUMMARY =====");
  console.log(`  processed:   ${totals.total}`);
  console.log(`  re-typed:    ${totals.retyped}`);
  console.log(`  kept 'other':${totals.keptOther}`);
  console.log(`  unavailable: ${totals.unavailable}`);
  console.log(`  errors:      ${totals.errors}`);
  if (Object.keys(totals.byType).length) {
    console.log("  by type:");
    for (const [k, v] of Object.entries(totals.byType).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(12)} ${v}`);
    }
  }
  if (DRY) console.log("\n  DRY RUN — nothing was written. Re-run with --apply.");
}

run()
  .catch((e) => {
    console.error("[Backfill] Fatal:", e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
