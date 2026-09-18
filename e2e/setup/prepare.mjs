import { buildSchema, schemaFingerprint } from "./buildSchema.mjs";
import { closePool, one } from "../helpers/db.mjs";

export async function schemaReady() {
  try {
    const row = await one(
      `SELECT obj_description(to_regclass('public.e2e_reference_snapshot'), 'pg_class') AS built`,
    );
    return row?.built === schemaFingerprint();
  } catch {
    return false;
  } finally {
    await closePool();
  }
}

export async function prepareDatabase({ rebuild = process.env.E2E_REBUILD === "1" } = {}) {
  if (rebuild || !(await schemaReady())) buildSchema({ log: () => {} });
}
