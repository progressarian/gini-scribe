import "../loadEnv.js";
import pool from "../config/db.js";
import { addAlias } from "../services/billing/serviceItemAliases.js";
import { createItem } from "../services/billing/serviceItems.js";
import { addCatalogTest } from "../services/giniflow/testCatalog.js";

const BLOOD_GLUCOSE_ITEM = 336;
const BIOCHEMISTRY_SUBGROUP = 5;
const ctx = {};

const alias = await addAlias(BLOOD_GLUCOSE_ITEM, { name: "Glucose Fasting" }, ctx);
console.log("alias", alias.id, alias.name);

await addCatalogTest("HOMA-B", { category: "lab" });
const { rows: catalog } = await pool.query(
  `SELECT id, test_name FROM giniflow_test_catalog WHERE test_name IN ('HOMA-IR', 'HOMA-B')`,
);
const catalogId = Object.fromEntries(catalog.map((row) => [row.test_name, row.id]));

for (const [code, name] of [
  ["LAB-HOMA-IR", "HOMA-IR"],
  ["LAB-HOMA-B", "HOMA-B"],
]) {
  const item = await createItem(
    {
      code,
      name,
      kind: "test",
      subgroup_id: BIOCHEMISTRY_SUBGROUP,
      base_price: 0,
      test_catalog_id: catalogId[name],
    },
    ctx,
  );
  console.log("item", item.id, item.name, item.base_price);
}
await pool.end();
