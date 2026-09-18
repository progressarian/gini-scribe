import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DATABASE_URL, assertTestDatabase } from "./guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const migrationsDir = path.join(repoRoot, "server", "migrations");

export const DB_CONTAINER = process.env.E2E_DB_CONTAINER || "gini_scribe_db";
const DB_USER = "user";
const DB_NAME = new URL(TEST_DATABASE_URL).pathname.slice(1);

function docker(args, input) {
  const result = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function runSql(sql, label) {
  const result = docker(
    [
      "exec",
      "-i",
      DB_CONTAINER,
      "psql",
      "-U",
      DB_USER,
      "-d",
      DB_NAME,
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-X",
    ],
    sql,
  );
  if (result.status !== 0) {
    const error = new Error(`Failed applying ${label}\n${result.stderr.trim()}`);
    error.file = label;
    throw error;
  }
}

function runSqlFile(filePath) {
  runSql(fs.readFileSync(filePath, "utf8"), path.relative(repoRoot, filePath));
}

export function baselineMigrations() {
  return new Set(
    fs
      .readFileSync(path.join(here, "baseline-migrations.txt"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

export function migrationFiles() {
  const included = baselineMigrations();
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql") && !name.startsWith("_") && !included.has(name))
    .sort()
    .map((name) => path.join(migrationsDir, name));
}

export function recreateDatabase() {
  assertTestDatabase(TEST_DATABASE_URL);
  const drop = docker([
    "exec",
    DB_CONTAINER,
    "dropdb",
    "-U",
    DB_USER,
    "--if-exists",
    "--force",
    DB_NAME,
  ]);
  if (drop.status !== 0) throw new Error(`dropdb failed: ${drop.stderr.trim()}`);
  const create = docker(["exec", DB_CONTAINER, "createdb", "-U", DB_USER, DB_NAME]);
  if (create.status !== 0) throw new Error(`createdb failed: ${create.stderr.trim()}`);
}

function schemaFiles() {
  return [path.join(here, "init.sql"), path.join(here, "schema-baseline.sql"), ...migrationFiles()];
}

export function schemaFingerprint() {
  const hash = crypto.createHash("sha256");
  for (const file of [
    ...schemaFiles(),
    path.join(here, "snapshot.sql"),
    path.join(here, "baseline-migrations.txt"),
  ]) {
    hash.update(path.basename(file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

export function buildSchema({ log = console.log } = {}) {
  recreateDatabase();
  const files = schemaFiles();
  for (const file of files) {
    runSqlFile(file);
    log(`applied ${path.relative(repoRoot, file)}`);
  }
  runSqlFile(path.join(here, "snapshot.sql"));
  log("saved reference data snapshot");
  runSql(
    `COMMENT ON TABLE e2e_reference_snapshot IS '${schemaFingerprint()}';`,
    "schema fingerprint",
  );
  return files.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const count = buildSchema();
    console.log(`Test database ${DB_NAME} built from ${count} files`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
