import "../loadEnv.js";
import pool from "../config/db.js";
import { updateItem } from "../services/billing/serviceItems.js";
import { updateCatalogTest } from "../services/giniflow/testCatalog.js";

const { rows: item } = await pool.query(
  `SELECT i.id, i.test_catalog_id FROM service_items i WHERE i.code = 'LAB-H-S-CRP'`,
);
const { rows: original } = await pool.query(
  `SELECT id FROM giniflow_test_catalog WHERE test_name = 'hs-CRP'`,
);
const duplicate = item[0].test_catalog_id;
await updateItem(item[0].id, { test_catalog_id: original[0].id }, {});
await updateCatalogTest(duplicate, { isActive: false });
console.log("LAB-H-S-CRP now on catalogue 'hs-CRP'; switched off duplicate", duplicate);
await pool.end();
