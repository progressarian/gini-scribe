import fs from "node:fs";
import path from "node:path";
import { getPool } from "./db.mjs";
import { repoRoot } from "../setup/testEnv.mjs";

export const AUDIT_COLUMNS = ["created_at", "created_by", "updated_at", "updated_by"];

export function readMigration(fileName) {
  return fs.readFileSync(path.join(repoRoot, "server", "migrations", fileName), "utf8");
}

export function tablesCreatedBy(sql) {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1]);
}

export async function openFreshCopy(sql, { undo = "", before = null } = {}) {
  const client = await getPool().connect();
  await client.query("BEGIN");
  const snapshot = before ? await before(client) : null;
  if (undo) await client.query(undo);
  const tables = tablesCreatedBy(sql);
  if (tables.length) await client.query(`DROP TABLE IF EXISTS ${tables.join(", ")} CASCADE`);
  await client.query(sql);
  await client.query(sql);
  const refused = async (statement, params = []) => {
    await client.query("SAVEPOINT attempt");
    try {
      await client.query(statement, params);
      await client.query("RELEASE SAVEPOINT attempt");
      return null;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT attempt");
      return error.code ?? "unknown";
    }
  };
  const close = async () => {
    await client.query("ROLLBACK");
    client.release();
  };
  return { client, refused, close, snapshot };
}

export async function columnsOf(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.map((r) => r.column_name).sort();
}

export async function indexesOf(client, tables) {
  const { rows } = await client.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [tables],
  );
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
}

export async function lockdownOf(client, tables) {
  const rls = await client.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = ANY($1) AND relkind = 'r'`,
    [tables],
  );
  const grants = await client.query(
    `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_name = ANY($1) AND grantee IN ('anon', 'authenticated')`,
    [tables],
  );
  return { rls: rls.rows, publicGrants: grants.rows };
}

export async function allowedValuesOf(client, table, column) {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conrelid = $1::regclass AND c.contype = 'c'
        AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                               WHERE attrelid = $1::regclass AND attname = $2)]::int2[]`,
    [table, column],
  );
  if (rows.length !== 1)
    throw new Error(`${table}.${column}: expected one check, found ${rows.length}`);
  return [...rows[0].def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
}

export const REFUSED = {
  duplicate: "23505",
  rule: "23514",
  missingParent: "23503",
  stillUsed: "23503",
  appendOnly: "42501",
};

export const SEEDS_ROWS = /^\s*(INSERT|COPY|UPDATE|DELETE)\b/im;
export const HAS_COMMENTS = /--|\/\*/;
