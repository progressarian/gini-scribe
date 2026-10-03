import "../loadEnv.js";
import pool from "../config/db.js";
import { createItem } from "../services/billing/serviceItems.js";

const CODE = "CONS-1-ADDL";
const existing = (
  await pool.query(`SELECT code, base_price FROM service_items WHERE code = $1`, [CODE])
).rows[0];
if (existing) {
  console.log("SKIPPED —", CODE, "already exists at", `₹${existing.base_price}`);
} else {
  const subgroup = (await pool.query(`SELECT id FROM service_subgroups WHERE code = 'OPD-CONS'`))
    .rows[0];
  const saved = await createItem(
    {
      code: CODE,
      name: "Dr. Bhansali Additional Fees",
      kind: "other",
      base_price: 500,
      subgroup_id: subgroup.id,
    },
    {},
  );
  console.log("created", saved.code, "|", saved.name, `₹${saved.base_price}`);
}
await pool.end();
