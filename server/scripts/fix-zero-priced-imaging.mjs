import "../loadEnv.js";
import pool from "../config/db.js";
import { updateItem } from "../services/billing/serviceItems.js";

const FIXES = [
  { code: "MISC-USG-WHOLE-ABDOMEN", price: 1200 },
  { code: "RAD-X-RAY-PELVIS", price: 300 },
];
const REASON = "Was ₹0; set to HealthRay's usual amount (2026-10-03 price check)";

for (const fix of FIXES) {
  const { rows } = await pool.query(
    `SELECT id, name, base_price, is_active FROM service_items WHERE upper(code) = upper($1)`,
    [fix.code],
  );
  if (rows.length !== 1) {
    console.log("SKIPPED", fix.code, "— found", rows.length);
    continue;
  }
  const [item] = rows;
  if (Number(item.base_price) !== 0) {
    console.log("SKIPPED", fix.code, `— already ₹${item.base_price}`);
    continue;
  }
  const saved = await updateItem(item.id, { base_price: fix.price, reason: REASON }, {});
  console.log("updated", fix.code, "|", item.name, `₹0 → ₹${saved.base_price}`);
}
await pool.end();
