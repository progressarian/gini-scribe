import "../loadEnv.js";
import pool from "../config/db.js";
import { addAlias, listAliases } from "../services/billing/serviceItemAliases.js";
import { setItemActive } from "../services/billing/serviceItems.js";

const APPLY = process.argv.includes("--apply");
const KEEP = "LAB-CA15-3-BREAST-CANCER-MARKER";
const DUPLICATE = "HR-CA-15-3";
const ALIAS = "CA 15.3";
const ctx = { actorId: 11, role: "admin", ip: null };

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query(
    `SELECT id, code, name, base_price, is_active, is_outsourced FROM service_items
      WHERE code = ANY($1::text[]) ORDER BY code`,
    [[KEEP, DUPLICATE]],
  );
  console.table(rows);
  const keep = rows.find((row) => row.code === KEEP);
  const duplicate = rows.find((row) => row.code === DUPLICATE);
  if (!keep?.is_active || !duplicate) throw new Error("Items aren't as expected, nothing changed");

  const aliases = await listAliases(keep.id, client);
  if (aliases.some((alias) => alias.name.toLowerCase() === ALIAS.toLowerCase())) {
    console.log(`"${ALIAS}" is already a name of ${KEEP}`);
  } else {
    await addAlias(keep.id, { name: ALIAS }, ctx, client);
    console.log(`Added "${ALIAS}" as a name of ${KEEP}`);
  }
  if (duplicate.is_active) {
    await setItemActive(duplicate.id, false, ctx, client);
    console.log(`Deactivated ${DUPLICATE}`);
  } else {
    console.log(`${DUPLICATE} is already inactive`);
  }

  if (APPLY) {
    await client.query("COMMIT");
    console.log("COMMITTED");
  } else {
    await client.query("ROLLBACK");
    console.log("DRY RUN — rolled back. Pass --apply to write.");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("ROLLED BACK:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
