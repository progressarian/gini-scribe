import "../loadEnv.js";
import pool from "../config/db.js";
import { createGroup, createSubgroup } from "../services/billing/serviceGroups.js";
import { createItem } from "../services/billing/serviceItems.js";

const XRAY_CATALOG_ID = "e53c7c20-8c12-4e98-be43-5e89d49a5d38";
const ctx = {};

const group = await createGroup({ code: "RAD", name: "Radiology", sort_order: 3 }, ctx);
const subgroup = await createSubgroup(
  { group_id: group.id, code: "RAD-XRAY", name: "X-Ray", sort_order: 1 },
  ctx,
);
const item = await createItem(
  {
    code: "RAD-XRAY-CHEST",
    name: "X-Ray Chest",
    kind: "test",
    subgroup_id: subgroup.id,
    base_price: 300,
    test_catalog_id: XRAY_CATALOG_ID,
  },
  ctx,
);
console.log({ group: group.id, subgroup: subgroup.id, item: item.id, name: item.name, price: item.base_price });
await pool.end();
