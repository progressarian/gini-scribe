import "../loadEnv.js";
import pool from "../config/db.js";
import { createItem } from "../services/billing/serviceItems.js";
import { RECENT_FOLLOW_UP } from "../../shared/billingVocab.js";
import { LAB_ONLY_DOCTOR } from "../../shared/labOnly.js";

const apply = process.argv.includes("--apply");

try {
  const { rows: doctors } = await pool.query(
    `SELECT d.id, d.name,
            (SELECT i.subgroup_id FROM service_items i
              WHERE i.kind = 'consultation' AND i.is_active AND i.doctor_id = d.id
              ORDER BY i.visit_type = 'Follow Up' DESC, i.id LIMIT 1) AS subgroup_id
       FROM doctors d
      WHERE d.role = 'consultant' AND COALESCE(d.is_active, TRUE)
        AND lower(btrim(d.name)) <> lower($1)
        AND EXISTS (SELECT 1 FROM service_items i
                     WHERE i.kind = 'consultation' AND i.is_active AND i.doctor_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM service_items i
                         WHERE i.kind = 'consultation' AND i.is_active
                           AND i.doctor_id = d.id AND i.visit_type = $2)
      ORDER BY d.name, d.id`,
    [LAB_ONLY_DOCTOR, RECENT_FOLLOW_UP],
  );
  const { rows: taken } = await pool.query(
    `SELECT lower(code) AS code FROM service_items WHERE lower(code) = ANY($1)`,
    [doctors.map((d) => `cons-${d.id}-fu3`)],
  );
  const busy = new Set(taken.map((r) => r.code));

  console.log(
    `${apply ? "APPLY" : "DRY RUN"} — ${doctors.length} priced consultants without a ${RECENT_FOLLOW_UP} item`,
  );
  let created = 0;
  for (const doctor of doctors) {
    const item = {
      code: `CONS-${doctor.id}-FU3`,
      name: `Follow-up within 3 days — ${doctor.name}`,
      kind: "consultation",
      visit_type: RECENT_FOLLOW_UP,
      doctor_id: doctor.id,
      base_price: 0,
      ...(doctor.subgroup_id ? { subgroup_id: doctor.subgroup_id } : {}),
    };
    if (busy.has(item.code.toLowerCase())) {
      console.log(`  skip  ${item.code} ${doctor.name} — code already used`);
      continue;
    }
    if (!apply) {
      console.log(`  would ${item.code} ${item.name} ₹0`);
      continue;
    }
    const saved = await createItem(item, { actorId: null });
    created += 1;
    console.log(`  made  ${saved.code} ${saved.name} ₹${saved.base_price}`);
  }
  if (apply) console.log(`${created} items created.`);
  else if (doctors.length) console.log("Dry run, nothing written. Re-run with --apply.");
} catch (error) {
  console.error(`Stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
