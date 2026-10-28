import "../loadEnv.js";
import pool from "../config/db.js";
import { updateItem } from "../services/billing/serviceItems.js";

const PRICES = { "HR-ABI-VPT-FUNDUS": 800, "HR-ABI-VPT": 600 };

try {
  const { rows } = await pool.query(
    `SELECT id, code, name, base_price, price_per_patient, is_active
       FROM service_items WHERE code = ANY($1::text[])`,
    [Object.keys(PRICES)],
  );
  if (rows.length !== Object.keys(PRICES).length) throw new Error("Placeholders not found");
  for (const row of rows) {
    const after = await updateItem(
      row.id,
      {
        base_price: PRICES[row.code],
        price_per_patient: false,
        reason: "Same price as the ABI/VPT/Fundus package in Settings",
      },
      { actorId: null },
    );
    console.log(
      row.code,
      `₹${row.base_price} per-patient ${row.price_per_patient}`,
      "->",
      `₹${after.base_price} per-patient ${after.price_per_patient}`,
    );
  }
} finally {
  await pool.end();
}
