import "../loadEnv.js";
import pool from "../config/db.js";
import { addAlias } from "../services/billing/serviceItemAliases.js";

const PAIRS = [
  ["FT3", "Triiodothyronine Free (FT3)"],
  ["FT4", "Thyroxine Free (Ft4)"],
  ["hs-CRP", "H S CRP"],
  ["LDL", "Cholesterol - LDL Direct"],
  ["Vit D", "Vitamin D25 HYDROXY"],
  ["eGFR", "CREATININE EGFR Serum"],
  ["Post-meal", "Glucose Post Prandial - PP"],
];

for (const [alias, itemName] of PAIRS) {
  const { rows } = await pool.query(
    `SELECT id, code FROM service_items WHERE is_active AND kind = 'test' AND lower(name) = lower($1)`,
    [itemName],
  );
  if (rows.length !== 1) {
    console.log("SKIPPED", alias, "— found", rows.length, "items named", itemName);
    continue;
  }
  try {
    await addAlias(rows[0].id, { name: alias }, {});
    console.log("alias", alias, "→", rows[0].code, itemName);
  } catch (error) {
    console.log("SKIPPED", alias, "—", error.message);
  }
}
await pool.end();
