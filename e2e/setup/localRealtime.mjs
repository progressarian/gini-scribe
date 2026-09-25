import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NETWORK_LOG, buildTestEnv, repoRoot } from "./testEnv.mjs";

export const RT_NETWORK = "gini-rt-e2e";
export const RT_DB_CONTAINER = "gini-rt-e2e-db";
export const RT_CONTAINER = "gini-rt-e2e-realtime";
export const RT_DB_PORT = 54470;
export const RT_PORT = 54471;
export const RT_PROXY_PORT = 54472;
export const RT_API_PORT = 3111;
export const RT_WEB_PORT = 3110;
export const RT_API_URL = `http://localhost:${RT_API_PORT}`;
export const RT_WEB_URL = `http://localhost:${RT_WEB_PORT}`;
export const RT_SUPABASE_URL = `http://localhost:${RT_PROXY_PORT}`;

const DB_IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.132";
const RT_IMAGE = "public.ecr.aws/supabase/realtime:v2.124.2";
const DB_PASSWORD = "local-realtime-only";
const TENANT_HOST = "realtime-dev.localhost";
const RLS_MIGRATION = path.join(
  repoRoot,
  "server",
  "migrations",
  "2026-09-02_giniflow_realtime_rls.sql",
);

const require = createRequire(path.join(repoRoot, "server", "package.json"));
const jwt = require("jsonwebtoken");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const quietly = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export function assertLocalSupabase(url) {
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refused: realtime tests only run against a local Supabase, not ${host}`);
  }
}

export function mintKeys(secret) {
  const iat = Math.floor(Date.now() / 1000);
  const key = (role) => jwt.sign({ role, iss: "local-realtime", iat, exp: iat + 86400 }, secret);
  return { anonKey: key("anon"), serviceKey: key("service_role") };
}

function psql(sql) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      RT_DB_CONTAINER,
      "psql",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-h",
      "localhost",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
    ],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}

async function until(label, check, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await quietly(check)) return;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function removeContainers() {
  quietly(() => docker("rm", "-f", RT_CONTAINER));
  quietly(() => docker("rm", "-f", RT_DB_CONTAINER));
  quietly(() => docker("network", "rm", RT_NETWORK));
}

const rewrite = (url) =>
  url.replace(/^\/realtime\/v1\/websocket/, "/socket/websocket").replace(/^\/realtime\/v1\//, "/");

function startProxy() {
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: RT_PORT,
        method: req.method,
        path: rewrite(req.url),
        headers: { ...req.headers, host: TENANT_HOST },
      },
      (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(RT_PORT, "127.0.0.1", () => {
      const lines = [`${req.method} ${rewrite(req.url)} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        lines.push(
          `${name}: ${name.toLowerCase() === "host" ? TENANT_HOST : req.rawHeaders[i + 1]}`,
        );
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", (e) =>
      reject(
        e.code === "EADDRINUSE"
          ? new Error(
              `Refused: port ${RT_PROXY_PORT} is taken, so another local realtime stack is already running; its containers were left alone`,
            )
          : e,
      ),
    );
    server.listen(RT_PROXY_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function touchTenant(anonKey) {
  const { createClient } = createRequire(path.join(repoRoot, "package.json"))(
    "@supabase/supabase-js",
  );
  const client = createClient(RT_SUPABASE_URL, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const channel = client.channel("warmup");
  await new Promise((resolve) => {
    channel.subscribe((status) => status !== "CLOSED" && resolve(status));
    setTimeout(resolve, 10000);
  });
  await client.removeAllChannels();
}

let ownsStack = false;

export async function up({ secret = crypto.randomBytes(32).toString("hex") } = {}) {
  assertLocalSupabase(RT_SUPABASE_URL);
  const proxy = await startProxy();
  ownsStack = true;
  removeContainers();
  docker("network", "create", RT_NETWORK);
  docker(
    "run",
    "-d",
    "--name",
    RT_DB_CONTAINER,
    "--network",
    RT_NETWORK,
    "-p",
    `127.0.0.1:${RT_DB_PORT}:5432`,
    "-e",
    `POSTGRES_PASSWORD=${DB_PASSWORD}`,
    DB_IMAGE,
  );
  await until("the local Supabase Postgres", () => psql("select 1") === "1");
  psql(`
    create schema if not exists _realtime;
    alter schema _realtime owner to supabase_admin;
    create or replace function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                      nullif(current_setting('request.jwt.claims', true), ''))::jsonb
    $$;
    grant execute on function auth.jwt() to anon, authenticated, service_role;
  `);
  docker(
    "run",
    "-d",
    "--name",
    RT_CONTAINER,
    "--network",
    RT_NETWORK,
    "-p",
    `127.0.0.1:${RT_PORT}:4000`,
    "-e",
    "PORT=4000",
    "-e",
    `DB_HOST=${RT_DB_CONTAINER}`,
    "-e",
    "DB_PORT=5432",
    "-e",
    "DB_USER=supabase_admin",
    "-e",
    `DB_PASSWORD=${DB_PASSWORD}`,
    "-e",
    "DB_NAME=postgres",
    "-e",
    "DB_AFTER_CONNECT_QUERY=SET search_path TO _realtime",
    "-e",
    "DB_ENC_KEY=supabaserealtime",
    "-e",
    `API_JWT_SECRET=${secret}`,
    "-e",
    `METRICS_JWT_SECRET=${crypto.randomBytes(16).toString("hex")}`,
    "-e",
    `SECRET_KEY_BASE=${crypto.randomBytes(48).toString("base64")}`,
    "-e",
    "ERL_AFLAGS=-proto_dist inet_tcp",
    "-e",
    "DNS_NODES=''",
    "-e",
    "RLIMIT_NOFILE=10000",
    "-e",
    "APP_NAME=realtime",
    "-e",
    "SEED_SELF_HOST=true",
    "-e",
    "REGION=local",
    RT_IMAGE,
  );
  const { anonKey, serviceKey } = mintKeys(secret);
  await until("the local Realtime server", async () => {
    const r = await fetch(`${RT_SUPABASE_URL}/realtime/v1/api/ping`);
    return r.ok;
  });
  await until(
    "Realtime's tenant migrations",
    async () => {
      await touchTenant(anonKey);
      return psql("select to_regclass('realtime.messages') is not null") === "t";
    },
    120000,
  );
  psql(fs.readFileSync(RLS_MIGRATION, "utf8"));
  return {
    proxy,
    env: {
      SUPABASE_URL: RT_SUPABASE_URL,
      SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_KEY: serviceKey,
      SUPABASE_JWT_SECRET: secret,
    },
  };
}

export function startApi(supabaseEnv) {
  assertLocalSupabase(supabaseEnv.SUPABASE_URL);
  const blocker = pathToFileURL(path.join(repoRoot, "e2e", "setup", "blockNetwork.mjs")).href;
  const env = buildTestEnv({
    ...supabaseEnv,
    PORT: String(RT_API_PORT),
    E2E_NETWORK_LOG: NETWORK_LOG,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${blocker}`].filter(Boolean).join(" "),
  });
  return spawn(process.execPath, [path.join(repoRoot, "server", "index.js")], {
    cwd: path.join(repoRoot, "server"),
    env,
    stdio: "inherit",
  });
}

export async function startWeb(cacheDir) {
  Object.assign(
    process.env,
    buildTestEnv({ VITE_API_URL: RT_API_URL, VITE_DEV_API_URL: RT_API_URL }),
  );
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.join(repoRoot, "vite.config.js"),
    root: repoRoot,
    cacheDir,
    server: { port: RT_WEB_PORT, strictPort: true },
  });
  await server.listen();
  return server;
}

async function main() {
  const cacheDir =
    process.env.RT_VITE_CACHE_DIR || path.join(repoRoot, "e2e", ".artifacts", "vite-realtime");
  let proxy = null;
  let api = null;
  let web = null;
  let closing = false;
  const down = async (code = 0) => {
    if (closing) return;
    closing = true;
    api?.kill("SIGTERM");
    proxy?.close();
    if (ownsStack) {
      removeContainers();
      console.log("[local realtime] stopped and removed");
    }
    await quietly(() => web?.close());
    process.exit(code);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => down(0));
  process.on("uncaughtException", (e) => {
    console.error("[local realtime] crashed:", e.message);
    down(1);
  });
  try {
    const stack = await up();
    proxy = stack.proxy;
    api = startApi(stack.env);
    api.on("exit", () => down(1));
    web = await startWeb(cacheDir);
    console.log(
      `[local realtime] ready — web ${RT_WEB_URL}, api ${RT_API_URL}, realtime ${RT_SUPABASE_URL}`,
    );
  } catch (e) {
    console.error("[local realtime] failed:", e.message);
    await down(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
