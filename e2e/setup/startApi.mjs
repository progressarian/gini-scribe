import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NETWORK_LOG, buildTestEnv, repoRoot } from "./testEnv.mjs";
import { prepareDatabase } from "./prepare.mjs";

await prepareDatabase();

const blocker = pathToFileURL(path.join(repoRoot, "e2e", "setup", "blockNetwork.mjs")).href;

const env = buildTestEnv({
  E2E_NETWORK_LOG: NETWORK_LOG,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${blocker}`].filter(Boolean).join(" "),
});

const child = spawn(process.execPath, [path.join(repoRoot, "server", "index.js")], {
  cwd: path.join(repoRoot, "server"),
  env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
