import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestDatabase } from "./guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..");
export const e2eRoot = path.resolve(here, "..");
export const NETWORK_LOG = path.join(e2eRoot, ".artifacts", "outbound-calls.log");

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function productionEnvKeys() {
  return Object.keys(parseEnvFile(path.join(repoRoot, ".env")));
}

export function e2eValues() {
  return parseEnvFile(path.join(e2eRoot, ".env.e2e"));
}

export function buildTestEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of productionEnvKeys()) env[key] = "";
  delete env.RUN_CRON_IN_API;
  Object.assign(env, e2eValues(), extra);
  assertTestDatabase(env.DATABASE_URL);
  return env;
}

export const API_PORT = Number(e2eValues().E2E_API_PORT || 3101);
export const WEB_PORT = Number(e2eValues().E2E_WEB_PORT || 3100);
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
