import "../loadEnv.js";
import pool from "../config/db.js";
import { removeLine } from "../services/billing/bills.js";
import { addAlias, removeAlias } from "../services/billing/serviceItemAliases.js";
import { setItemActive } from "../services/billing/serviceItems.js";
import { updateCatalogTest } from "../services/giniflow/testCatalog.js";

const ctx = { actorId: null, role: "admin" };
const itemOf = async (code) =>
  (await pool.query(`SELECT id, test_catalog_id FROM service_items WHERE code = $1`, [code]))
    .rows[0];
const creatinine = await itemOf("LAB-CREATININE");
const egfr = await itemOf("LAB-CREATININE-EGFR-SERUM");
const t3 = await itemOf("LAB-T3");

const { rows: lines } = await pool.query(
  `SELECT l.id, l.bill_id FROM bill_lines l JOIN bills b ON b.id = l.bill_id
    WHERE l.service_item_id = $1 AND l.is_live AND b.status = 'draft'`,
  [egfr.id],
);
for (const line of lines) {
  await removeLine(
    line.bill_id,
    line.id,
    { reason: "Duplicate of CREATININE (lab report name)" },
    ctx,
  );
}
console.log("removed duplicate EGFR lines:", lines.length);

const { rows: aliases } = await pool.query(
  `SELECT id, name FROM service_item_aliases WHERE service_item_id = $1`,
  [egfr.id],
);
for (const alias of aliases) await removeAlias(egfr.id, alias.id, ctx);
await setItemActive(egfr.id, false, ctx);
await updateCatalogTest(egfr.test_catalog_id, { isActive: false });
console.log("switched off LAB-CREATININE-EGFR-SERUM and its catalogue entry");

for (const [itemId, name] of [
  [creatinine.id, "CREATININE EGFR , Serum"],
  [creatinine.id, "eGFR"],
  [creatinine.id, "SERUM CREATININE AND EGFR"],
  [t3.id, "T3 (Triiodothyronine)"],
]) {
  try {
    await addAlias(itemId, { name }, ctx);
    console.log("alias", name);
  } catch (error) {
    console.log("alias skipped", name, "—", error.message);
  }
}
await pool.end();
