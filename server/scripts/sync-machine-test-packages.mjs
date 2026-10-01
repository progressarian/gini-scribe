import "../loadEnv.js";
import pool from "../config/db.js";
import { createSubgroup } from "../services/billing/serviceGroups.js";
import { createItem, updateItem } from "../services/billing/serviceItems.js";

const ctx = {};
const REASON = "Synced from OPD Billing Master Machine test Package sheet";
const one = async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null;

for (const [code, price] of [
  ["MAC-ECG", 200],
  ["MAC-VPT", 300],
]) {
  const item = await one(`SELECT id, base_price FROM service_items WHERE code = $1`, [code]);
  if (Number(item.base_price) === price) continue;
  await updateItem(item.id, { base_price: price, reason: REASON }, ctx);
  console.log("price", code, Number(item.base_price), "→", price);
}

const group = await one(`SELECT id FROM service_groups WHERE code = 'MACHINE'`);
let sub = await one(`SELECT id FROM service_subgroups WHERE group_id = $1 AND name = 'Packages'`, [
  group.id,
]);
if (!sub) {
  sub = await createSubgroup(
    { group_id: group.id, code: "MACHINE-PKG", name: "Packages", sort_order: 10 },
    ctx,
  );
  console.log("subgroup Packages");
}

for (const [code, name, price] of [
  ["MAC-PKG-ABI-VPT", "ABI + VPT", 600],
  ["MAC-PKG-ABI-VPT-FUNDUS", "ABI + VPT + Fundus", 800],
]) {
  if (await one(`SELECT 1 FROM service_items WHERE code = $1`, [code])) continue;
  await createItem({ code, name, kind: "procedure", subgroup_id: sub.id, base_price: price }, ctx);
  console.log("create", code, name, price);
}
await pool.end();
