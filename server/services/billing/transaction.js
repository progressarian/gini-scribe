import pool from "../../config/db.js";

export function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const isClient = (db) => typeof db?.release === "function";

async function joinOuter(work, client) {
  try {
    await client.query("SAVEPOINT billing_unit");
  } catch (error) {
    if (error.code === "25P01") {
      throw new Error(
        "A billing service was given a connection with no open transaction (BEGIN first)",
      );
    }
    throw error;
  }
  try {
    const result = await work(client);
    await client.query("RELEASE SAVEPOINT billing_unit");
    return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT billing_unit").catch(() => {});
    throw error;
  }
}

export async function inTransaction(work, db = pool) {
  if (isClient(db)) return joinOuter(work, db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
