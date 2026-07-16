import pg from "pg";

// Return DATE columns as plain strings ("2024-03-15") instead of JS Date objects
// This prevents timezone-related off-by-one day issues on the frontend
pg.types.setTypeParser(1082, (val) => val); // 1082 = DATE type OID

const dbUrl = process.env.DATABASE_URL || "";
const isInternal = dbUrl.includes(".railway.internal");
const isLocal = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");
const needsSsl = !!dbUrl && !isInternal && !isLocal;

const cleanDbUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, "");
const finalDbUrl = cleanDbUrl || undefined;

// ── Cron connection — MUST be SESSION mode ──────────────────────────────────
// Cron families coordinate via session-scoped advisory locks (see
// lowPriority.js tryAcquireCronLock → pg_try_advisory_lock). Those locks belong
// to a backend SESSION, so they only work if a checked-out client stays pinned
// to one backend for its whole lifetime. Supavisor's TRANSACTION mode (port
// 6543) multiplexes clients across backends: the lock lands on backend A, the
// later pg_advisory_unlock runs on backend B and silently no-ops (returns
// false), and the lock is stranded on A. Every later run then logs "skipped —
// previous run still holds its lock" and does nothing, forever. It survives app
// restarts too, because A lives in the POOLER's pool, not ours.
// Fix: point cron at a SESSION-mode connection (Supavisor port 5432), which
// pins the backend so lock/unlock always hit the same session.
const cronDbUrl = process.env.CRON_DATABASE_URL || dbUrl;
const cronIsInternal = cronDbUrl.includes(".railway.internal");
const cronIsLocal = cronDbUrl.includes("localhost") || cronDbUrl.includes("127.0.0.1");
const cronNeedsSsl = !!cronDbUrl && !cronIsInternal && !cronIsLocal;
const finalCronDbUrl = cronDbUrl.replace(/[?&]sslmode=[^&]*/g, "") || undefined;

const pool = new pg.Pool({
  connectionString: finalDbUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 20000, // close idle connections before Railway's 30s server timeout
  // Never let a single query hang forever: a stuck query (e.g. blocked on a row
  // lock held by a hung cron job) with no timeout silently freezes the sync
  // loops. statement_timeout kills it server-side; query_timeout is the
  // client-side backstop. 60s is far above any legitimate sync query.
  statement_timeout: 60000,
  query_timeout: 60000,
  max: 15,
  allowExitOnIdle: true,
  keepAlive: true, // send TCP keepalives — prevents Railway from closing idle connections
  keepAliveInitialDelayMillis: 10000,
});

// Dedicated low-priority pool for background cron/sync jobs.
// Kept small so background sync can never starve user-facing requests on the main pool.
// Uses the SESSION-mode connection (CRON_DATABASE_URL) — advisory locks require
// a pinned backend; see the cronDbUrl note above.
const cronPool = new pg.Pool({
  connectionString: finalCronDbUrl,
  ssl: cronNeedsSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 20000,
  statement_timeout: 60000, // see pool above — no background query may hang forever
  query_timeout: 60000,
  max: 4,
  allowExitOnIdle: true,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Log unexpected pool errors (prevents unhandled rejection crashes)
pool.on("error", (err) => {
  console.error("Unexpected DB pool error:", err.message);
});
cronPool.on("error", (err) => {
  console.error("Unexpected cron DB pool error:", err.message);
});

// Pool-level handlers only fire for idle clients. When a checked-out client's
// underlying socket dies (Supabase pooler drop, network blip), pg emits 'error'
// on the Client itself — unhandled, that crashes the process. Attach a logger
// to every client on checkout so the error is logged and the in-flight query
// rejects normally.
function attachClientErrorHandler(p, label) {
  p.on("connect", (client) => {
    client.on("error", (err) => {
      console.error(`${label} client error:`, err.message);
    });
  });
}
attachClientErrorHandler(pool, "DB");
attachClientErrorHandler(cronPool, "cron DB");

// Wrap pool.query with transient-error retry. Only retries on connection-level
// failures (Supabase pooler drop, ECONNRESET, admin shutdown). Query errors
// like syntax or constraint violations pass through immediately so callers
// still see real bugs. Skipped for client-checkout (pool.connect) callers
// because they manage transactions and retrying mid-tx is unsafe.
const TRANSIENT_CODES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
]);
const TRANSIENT_MESSAGES = [
  "Connection terminated",
  "Client has encountered a connection error",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "read ECONNRESET",
  "server closed the connection unexpectedly",
  "DbHandler exited", // Supabase pooler killed the backend handler mid-query
  "EDBHANDLEREXITED",
];
// Node socket errno codes that should be treated as transient. pg surfaces
// these as `err.code` (not a SQLSTATE), so they bypass TRANSIENT_CODES.
const TRANSIENT_ERRNOS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
function isTransient(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  if (err.code && TRANSIENT_ERRNOS.has(err.code)) return true;
  const msg = err.message || "";
  return TRANSIENT_MESSAGES.some((m) => msg.includes(m));
}
function wrapQueryWithRetry(p, label, { maxAttempts = 3, baseDelayMs = 150 } = {}) {
  const original = p.query.bind(p);
  p.query = async (...args) => {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await original(...args);
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts || !isTransient(err)) throw err;
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `${label} transient error (attempt ${attempt}/${maxAttempts}): ${err.message} — retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  };
}
wrapQueryWithRetry(pool, "DB");
wrapQueryWithRetry(cronPool, "cron DB");

console.log("DB:", !!dbUrl, "internal:", isInternal, "ssl:", needsSsl);

// Guard the advisory-lock invariant. A transaction-mode pooler (Supavisor port
// 6543 / pgbouncer) silently strands cron locks and wedges every job family with
// only a "skipped — previous run still holds its lock" line to show for it, so
// make the misconfiguration loud instead of letting it fail silently.
if (/:6543\b/.test(cronDbUrl) || /pgbouncer=true/.test(cronDbUrl)) {
  console.warn(
    "⚠️  cron DB is on a TRANSACTION-mode pooler (port 6543) — advisory locks will leak and " +
      "cron families will wedge. Set CRON_DATABASE_URL to the SESSION-mode connection (port 5432).",
  );
} else if (process.env.CRON_DATABASE_URL) {
  console.log("✓ cron DB: separate session-mode connection (advisory locks safe)");
}

export default pool;
export { dbUrl, needsSsl, cronPool };
