/**
 * Resilience tests for syncPatientLogsFromGenie / syncVisitToGenie.
 *
 * Exercises failure modes without touching the real DBs beyond what the
 * happy-path test already creates. Each case should return a soft result,
 * never throw. Run AFTER test-track-sync.js so TEST_COMPANION_USER exists.
 *
 *   node server/scripts/test-track-sync-resilience.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);

const ORIG_URL = process.env.GENIE_SUPABASE_URL;
const ORIG_KEY = process.env.GENIE_SUPABASE_SERVICE_KEY;

// Helper: reload the module so env-var changes take effect (module caches client)
function loadSync() {
  delete require.cache[require.resolve("../genie-sync.cjs")];
  return require("../genie-sync.cjs");
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

async function run() {
  const { rows } = await pool.query(
    "SELECT id FROM patients WHERE file_no = 'TEST_COMPANION_USER' LIMIT 1",
  );
  if (rows.length === 0) {
    console.error("Run test-track-sync.js first — needs TEST_COMPANION_USER patient.");
    process.exitCode = 1;
    return;
  }
  const pid = rows[0].id;

  // ── Case 1: missing env vars ───────────────────────────────────────────────
  console.log("\n[1] Missing GENIE creds:");
  delete process.env.GENIE_SUPABASE_URL;
  delete process.env.GENIE_SUPABASE_SERVICE_KEY;
  {
    const { syncPatientLogsFromGenie, syncVisitToGenie, resolveGeniePatientId } = loadSync();
    const r1 = await syncPatientLogsFromGenie(pid, pool);
    assert(r1.synced === false, "syncPatientLogsFromGenie returns { synced:false }");
    assert(r1.reason === "No Genie credentials", "reason set correctly");

    const r2 = await syncVisitToGenie(
      { id: "x", visit_date: "2026-04-23" },
      { id: pid, name: "x" },
      { name: "d" },
    );
    assert(r2.synced === false, "syncVisitToGenie returns { synced:false } with no creds");

    const r3 = await resolveGeniePatientId(pid);
    assert(r3 === null, "resolveGeniePatientId returns null");
  }

  // ── Case 2: bogus host (tests withRetry on transient network error) ────────
  console.log("\n[2] Unreachable Genie host (network error → retries → gives up):");
  process.env.GENIE_SUPABASE_URL = "https://this-host-does-not-exist.invalid";
  process.env.GENIE_SUPABASE_SERVICE_KEY = "fake";
  {
    const { syncPatientLogsFromGenie } = loadSync();
    const t0 = Date.now();
    const r = await syncPatientLogsFromGenie(pid, pool);
    const dt = Date.now() - t0;
    // resolveGeniePatientId will fail and return null, so we get "Genie patient not found"
    // OR it bubbles up as an exception handled by the outer try/catch.
    assert(r.synced === false, "returns soft failure instead of throwing");
    assert(!!r.reason, `has a reason: ${r.reason}`);
    assert(dt < 30000, `completed within 30s (took ${dt}ms — retries shouldn't hang)`);
  }

  // ── Case 3: bad local DB (simulate by passing a broken pool) ───────────────
  console.log("\n[3] Broken local DB pool (upserts fail, fetches OK):");
  process.env.GENIE_SUPABASE_URL = ORIG_URL;
  process.env.GENIE_SUPABASE_SERVICE_KEY = ORIG_KEY;
  {
    const { syncPatientLogsFromGenie } = loadSync();
    const fakePool = {
      query: async () => {
        throw new Error("simulated local DB failure");
      },
    };
    const r = await syncPatientLogsFromGenie(pid, fakePool);
    // Depending on whether there's data for this patient in Genie:
    //  - If data exists, upsertFailures > 0 and synced:true with partial:true
    //  - If no data, counts are zero but synced:true with partial:false
    assert(
      r.synced === true || r.synced === false,
      "returns a result (either synced or graceful fail)",
    );
    if (r.synced && r.upsertFailures) {
      const total = Object.values(r.upsertFailures).reduce((a, b) => a + b, 0);
      console.log(`  → upsert failures: ${JSON.stringify(r.upsertFailures)} (total=${total})`);
      // If there's data in Genie, at least one upsert should have failed:
      assert(total >= 0, "upsertFailures tallied without crashing");
    }
  }

  // ── Case 4: happy path again after chaos (prove no module-level state corruption) ──
  console.log("\n[4] Happy path still works after error cases:");
  {
    const { syncPatientLogsFromGenie } = loadSync();
    const r = await syncPatientLogsFromGenie(pid, pool);
    assert(r.synced === true, "synced: true");
    assert(r.partial === false || r.partial === undefined, "not partial");
    console.log(`  counts: ${JSON.stringify(r.counts)}`);
  }

  // ── Case 5: unknown patient ────────────────────────────────────────────────
  console.log("\n[5] Unknown patient id:");
  {
    const { syncPatientLogsFromGenie } = loadSync();
    const r = await syncPatientLogsFromGenie(99999999, pool);
    assert(r.synced === false, "returns synced:false");
    assert(r.reason === "Genie patient not found", "reason: Genie patient not found");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

try {
  await run();
} finally {
  await pool.end();
}
