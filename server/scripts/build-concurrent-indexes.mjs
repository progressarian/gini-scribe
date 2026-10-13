import "../loadEnv.js";
import fs from "fs";
import path from "path";
import pg from "pg";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/build-concurrent-indexes.mjs <migration.sql>");
  process.exit(1);
}

const statements = fs
  .readFileSync(path.resolve(file), "utf8")
  .split(";")
  .map((part) => part.trim())
  .filter(Boolean);

const sessionUrl = new URL(process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, ""));
if (sessionUrl.port === "6543") sessionUrl.port = "5432";

const client = new pg.Client({
  connectionString: sessionUrl.toString(),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
});
await client.connect();
await client.query("SET statement_timeout = 0");

const validity = async (name) =>
  (
    await client.query(
      `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = $1`,
      [name],
    )
  ).rows[0]?.valid;

try {
  for (const sql of statements) {
    const name = sql.match(/IF NOT EXISTS\s+(\w+)/i)?.[1];
    if ((await validity(name)) === false) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      console.log(`${name}: dropped the invalid leftover from an earlier attempt`);
    }
    const started = Date.now();
    await client.query(sql);
    console.log(
      `${name}: ${(await validity(name)) ? "built" : "INVALID — rerun this script"} in ${Math.round((Date.now() - started) / 1000)}s`,
    );
  }
} finally {
  await client.end();
}
