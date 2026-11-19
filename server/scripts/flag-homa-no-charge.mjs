import "../loadEnv.js";
import pool from "../config/db.js";
import { updateItem } from "../services/billing/serviceItems.js";

const CODES = { 416: "LAB-HOMA-IR", 417: "LAB-HOMA-B" };
const APPLY = process.argv.includes("--apply");

try {
  const { rows } = await pool.query(
    `SELECT id, code, name, base_price, price_per_patient, no_charge, is_active
       FROM service_items WHERE id = ANY($1::int[]) ORDER BY id`,
    [Object.keys(CODES).map(Number)],
  );
  console.table(rows);
  const unexpected = rows.length !== 2 || rows.some((row) => CODES[row.id] !== row.code);
  if (unexpected) throw new Error("Unexpected items, nothing changed");
  if (rows.some((row) => Number(row.base_price) !== 0 || row.price_per_patient)) {
    throw new Error("An item has a price or is priced per patient, nothing changed");
  }
  const due = rows.filter((row) => !row.no_charge);
  console.log(`${due.length} to flag${APPLY ? "" : " (dry run, pass --apply to write)"}`);
  if (APPLY) {
    for (const row of due) {
      const saved = await updateItem(row.id, { no_charge: true }, { actorId: null });
      console.log("flagged", { id: saved.id, code: saved.code, no_charge: saved.no_charge });
    }
  }
} finally {
  await pool.end();
}
