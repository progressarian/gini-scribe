import "../loadEnv.js";
import pool from "../config/db.js";

const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const show = async (label, sql) =>
    console.log(label, JSON.stringify((await client.query(sql)).rows, null, 1));

  await show(
    "package-like items",
    `SELECT id, code, name, kind, base_price, is_active FROM service_items
      WHERE name ~* '(abi|vpt|fundus).*(abi|vpt|fundus)' OR name ~* '\\mpackage'
      ORDER BY is_active DESC, name`,
  );
  await show(
    "package discount rules",
    `SELECT r.id, r.name, r.kind, r.value, r.method, r.applies_per, r.requires_all_items,
            r.is_active, r.service_item_ids,
            ARRAY(SELECT i.name FROM service_items i
                   WHERE i.id = ANY(r.service_item_ids) ORDER BY i.name) AS items
       FROM discount_rules r
      WHERE r.requires_all_items
         OR EXISTS (SELECT 1 FROM service_items i
                     WHERE i.id = ANY(r.service_item_ids) AND i.name ~* '\\m(abi|vpt|fundus)')
      ORDER BY r.is_active DESC, r.name`,
  );
  await client.query("ROLLBACK");
} catch (e) {
  await client.query("ROLLBACK");
  console.error(e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
