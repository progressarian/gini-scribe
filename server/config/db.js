import pg from "pg";

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
  idleTimeoutMillis: 30000,
  max: 15,
  allowExitOnIdle: true,
});

// Log unexpected pool errors (prevents unhandled rejection crashes)
pool.on("error", (err) => {
  console.error("Unexpected DB pool error:", err.message);
});

console.log("DB:", !!dbUrl, "internal:", isInternal, "ssl:", needsSsl);

export default pool;
export { dbUrl, needsSsl };
