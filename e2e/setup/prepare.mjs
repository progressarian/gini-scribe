import { buildSchema } from "./buildSchema.mjs";
import { closePool, one } from "../helpers/db.mjs";

export async function schemaReady() {
  try {
    const row = await one(`SELECT to_regclass('public.e2e_reference_snapshot') AS t`);
    return Boolean(row?.t);
  } catch {
    return false;
  } finally {
    await closePool();
  }
}

export async function prepareDatabase({ rebuild = process.env.E2E_REBUILD === "1" } = {}) {
  if (rebuild || !(await schemaReady())) buildSchema({ log: () => {} });
}
