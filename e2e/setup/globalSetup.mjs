import fs from "node:fs";
import { TEST_DATABASE_URL, assertTestDatabase } from "./guard.mjs";
import { resetDatabase } from "./reset.mjs";
import { NETWORK_LOG, buildTestEnv } from "./testEnv.mjs";
import { closePool } from "../helpers/db.mjs";

export default async function globalSetup() {
  assertTestDatabase(buildTestEnv().DATABASE_URL);
  assertTestDatabase(TEST_DATABASE_URL);
  await resetDatabase();
  await closePool();
  fs.rmSync(NETWORK_LOG, { force: true });
}
