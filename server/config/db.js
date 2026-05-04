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

const pool = new pg.Pool({
  connectionString: finalDbUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 20000, // close idle connections before Railway's 30s server timeout
  max: 15,
  allowExitOnIdle: true,
  keepAlive: true, // send TCP keepalives — prevents Railway from closing idle connections
  keepAliveInitialDelayMillis: 10000,
});

// Dedicated low-priority pool for background cron/sync jobs.
// Kept small so background sync can never starve user-facing requests on the main pool.
const cronPool = new pg.Pool({
  connectionString: finalDbUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 20000,
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
  "ETIMEDOUT",
  "EPIPE",
  "read ECONNRESET",
  "server closed the connection unexpectedly",
];
function isTransient(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
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

export default pool;
export { dbUrl, needsSsl, cronPool };
