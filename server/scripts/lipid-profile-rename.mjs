import "../loadEnv.js";
import pool from "../config/db.js";
import { addAlias } from "../services/billing/serviceItemAliases.js";
import { updateItem } from "../services/billing/serviceItems.js";
import { addCatalogTest, updateCatalogTest } from "../services/giniflow/testCatalog.js";

const LIPID_ITEM = 364;
const INSULIN_ITEM = 358;
const OLD_LIPID_CATALOG = "68dd6733-dd2f-4265-b63b-7c246baea40a";
const ctx = {};

await addCatalogTest("Lipid Profile", { category: "lab" });
const { rows } = await pool.query(
  `SELECT id FROM giniflow_test_catalog WHERE test_name = 'Lipid Profile'`,
);
const lipidProfile = rows[0].id;
await updateItem(LIPID_ITEM, { test_catalog_id: lipidProfile }, ctx);
await addAlias(LIPID_ITEM, { name: "Lipid panel" }, ctx);
await updateCatalogTest(OLD_LIPID_CATALOG, { isActive: false });
await addAlias(INSULIN_ITEM, { name: "Insulin - Fasting" }, ctx);
console.log("lipid catalog", lipidProfile);
await pool.end();
