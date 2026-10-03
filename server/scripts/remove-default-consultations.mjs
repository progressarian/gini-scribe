import "../loadEnv.js";
import pool from "../config/db.js";
import { deleteItem, setItemActive } from "../services/billing/serviceItems.js";

const APPLY = process.argv.includes("--apply");

const { rows: items } = await pool.query(
  `SELECT i.id, i.code, i.name, i.visit_type, i.base_price, i.is_active,
          (SELECT COUNT(*)::int FROM bill_lines l WHERE l.service_item_id = i.id) AS lines,
          (SELECT COUNT(*)::int FROM bill_lines l JOIN bills b ON b.id = l.bill_id
            WHERE l.service_item_id = i.id AND l.is_live AND b.status = 'draft') AS draft_lines
     FROM service_items i
    WHERE i.kind = 'consultation' AND i.doctor_id IS NULL
    ORDER BY i.code`,
);

for (const item of items) {
  const where = `${item.code} | ${item.name} ₹${item.base_price} · on ${item.lines} bill line(s), ${item.draft_lines} on open drafts`;
  if (!APPLY) {
    console.log("[dry]", where);
    continue;
  }
  try {
    await deleteItem(item.id, {});
    console.log("deleted", where);
  } catch (error) {
    if (!item.is_active) {
      console.log("kept switched off", where, "—", error.message);
      continue;
    }
    await setItemActive(item.id, false, {});
    console.log("switched off (still on bills, so it can't be deleted)", where);
  }
}
console.log(APPLY ? "APPLIED" : "DRY RUN — rerun with --apply", `· ${items.length} item(s)`);
await pool.end();
