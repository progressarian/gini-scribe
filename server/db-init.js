import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false });

async function init() {
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf-8");
  try {
    await pool.query(sql);
    console.log("✅ Database schema created successfully");
    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    console.log("Tables:", tables.rows.map(r => r.tablename).join(", "));
  } catch (err) {
    console.error("❌ Schema error:", err.message);
  } finally {
    await pool.end();
  }
}

init();
