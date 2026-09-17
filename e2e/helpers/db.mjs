import pg from "pg";
import { TEST_DATABASE_URL, assertTestDatabase } from "../setup/guard.mjs";

pg.types.setTypeParser(1082, (value) => value);

let pool = null;

export function getPool(url = TEST_DATABASE_URL) {
  assertTestDatabase(url);
  if (!pool) pool = new pg.Pool({ connectionString: url, max: 4, ssl: false });
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function one(text, params = []) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

export async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
