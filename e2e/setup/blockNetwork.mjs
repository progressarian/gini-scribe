import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const logFile = process.env.E2E_NETWORK_LOG;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", ""]);

function record(target) {
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${target}\n`);
}

function blocked(target) {
  record(target);
  const error = new Error(`E2E blocked outbound connection to ${target}`);
  error.code = "E2E_OUTBOUND_BLOCKED";
  return error;
}

function hostOf(rawArgs) {
  const args = Array.isArray(rawArgs[0]) ? rawArgs[0] : rawArgs;
  const [first, second] = args;
  if (first && typeof first === "object") {
    if (first.path) return { host: "", target: first.path };
    const host = first.host || first.hostname || "localhost";
    return { host, target: `${host}:${first.port ?? ""}` };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return { host: "", target: first };
  const host = typeof second === "string" ? second : "localhost";
  return { host, target: `${host}:${first}` };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const { host, target } = hostOf(args);
  if (!LOCAL_HOSTS.has(host)) {
    const error = blocked(target);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
if (originalFetch) {
  globalThis.fetch = async function fetch(input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!LOCAL_HOSTS.has(url.hostname)) throw blocked(url.origin);
    return originalFetch(input, init);
  };
}
