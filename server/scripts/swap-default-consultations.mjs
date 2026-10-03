import "../loadEnv.js";
import pool from "../config/db.js";
import { consultationForDesk } from "../services/billing/visitLines.js";

const { rows } = await pool.query(
  `SELECT DISTINCT l.visit_id, p.name, v.visit_date::text AS day
     FROM bill_lines l
     JOIN bills b ON b.id = l.bill_id AND b.status = 'draft'
     JOIN service_items i ON i.id = l.service_item_id
     JOIN giniflow_visits v ON v.id = l.visit_id
     JOIN patients p ON p.id = v.patient_id
    WHERE l.is_live AND i.kind = 'consultation' AND i.doctor_id IS NULL
    ORDER BY day, p.name`,
);

let swapped = 0;
for (const row of rows) {
  const result = await consultationForDesk(row.visit_id, {});
  if (result.replaced) {
    swapped += 1;
    console.log("swapped", row.day, row.name, "→", result.added.join(", "));
  } else {
    console.log("NOT swapped", row.day, row.name, "—", result.error ?? JSON.stringify(result));
  }
}
console.log(`${swapped} of ${rows.length} swapped`);
await pool.end();
