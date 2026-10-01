import "../loadEnv.js";
import pool from "../config/db.js";
import { createDiscountRule } from "../services/billing/discountRules.js";
import { setItemActive } from "../services/billing/serviceItems.js";

const ctx = {};
const idOf = async (code) =>
  (await pool.query(`SELECT id FROM service_items WHERE code = $1`, [code])).rows[0].id;
const [abi, vpt, fundus] = await Promise.all(["MAC-ABI", "MAC-VPT", "MAC-FUNDUS"].map(idOf));

for (const [name, items, price] of [
  ["ABI + VPT package", [abi, vpt], 600],
  ["ABI + VPT + Fundus package", [abi, vpt, fundus], 800],
]) {
  const exists = await pool.query(`SELECT 1 FROM discount_rules WHERE name = $1`, [name]);
  if (exists.rows.length) continue;
  const rule = await createDiscountRule(
    {
      name,
      method: "auto",
      kind: "fixed_price",
      value: price,
      applies_per: "bill",
      service_item_ids: items,
      requires_all_items: true,
      priority: 10,
    },
    ctx,
  );
  console.log("rule", rule.id, name, price);
}

for (const code of ["MAC-PKG-ABI-VPT", "MAC-PKG-ABI-VPT-FUNDUS"]) {
  await setItemActive(await idOf(code), false, ctx);
  console.log("switched off", code);
}
await pool.end();
