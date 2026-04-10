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

// Log unexpected pool errors (prevents unhandled rejection crashes)
pool.on("error", (err) => {
  console.error("Unexpected DB pool error:", err.message);
});

console.log("DB:", !!dbUrl, "internal:", isInternal, "ssl:", needsSsl);

export default pool;
export { dbUrl, needsSsl };
