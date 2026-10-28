import "../loadEnv.js";
import pool from "../config/db.js";
import { setItemActive } from "../services/billing/serviceItems.js";

const CODES = ["MAC-PKG-ABI-VPT-FUNDUS", "MAC-PKG-ABI-VPT"];

try {
  const { rows } = await pool.query(
    `SELECT id, code, name, base_price, is_active FROM service_items WHERE code = ANY($1::text[])`,
    [CODES],
  );
  if (rows.length !== CODES.length) throw new Error("Package services not found, nothing changed");
  for (const row of rows) {
    const after = await setItemActive(row.id, true, { actorId: null });
    console.log(row.code, row.name, `₹${row.base_price}`, row.is_active, "->", after.is_active);
  }
} finally {
  await pool.end();
}
