import { spawn } from "node:child_process";
import path from "node:path";
import { API_URL, WEB_PORT, buildTestEnv, repoRoot } from "./testEnv.mjs";

const env = buildTestEnv({ VITE_API_URL: API_URL, VITE_DEV_API_URL: API_URL });

const child = spawn(
  process.execPath,
  [
    path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
    "--port",
    String(WEB_PORT),
    "--strictPort",
  ],
  { cwd: repoRoot, env, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
