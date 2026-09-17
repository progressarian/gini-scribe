import { spawnSync } from "node:child_process";
import { DB_CONTAINER, buildSchema } from "./buildSchema.mjs";
import { resetDatabase } from "./reset.mjs";
import { closePool } from "../helpers/db.mjs";

function waitForDatabase() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = spawnSync("docker", ["exec", DB_CONTAINER, "pg_isready", "-U", "user"]);
    if (ready.status === 0) return;
    spawnSync("sleep", ["1"]);
  }
  throw new Error(`Database container ${DB_CONTAINER} is not ready`);
}

try {
  waitForDatabase();
  const count = buildSchema({ log: () => {} });
  await resetDatabase();
  await closePool();
  console.log(`Test database rebuilt from ${count} files and reset with fixtures`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
