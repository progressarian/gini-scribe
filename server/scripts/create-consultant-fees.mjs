import "../loadEnv.js";
import pool from "../config/db.js";
import { createItem } from "../services/billing/serviceItems.js";

const APPLY = process.argv.includes("--apply");

const FEES = [
  { doctorId: 5, visitType: "Follow Up", price: 1000 },
  { doctorId: 5, visitType: "New", price: 1500 },
  { doctorId: 44, visitType: "Follow Up", price: 700 },
  { doctorId: 44, visitType: "New", price: 700 },
];

const SUFFIX = { "Follow Up": "FU", New: "NEW" };
const TEMPLATE_DOCTOR = 1;

const one = async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null;

let created = 0;
for (const fee of FEES) {
  const doctor = await one(`SELECT id, name FROM doctors WHERE id = $1`, [fee.doctorId]);
  if (!doctor) {
    console.log("SKIPPED — no doctor", fee.doctorId);
    continue;
  }
  const existing = await one(
    `SELECT code, base_price FROM service_items
      WHERE kind = 'consultation' AND doctor_id = $1 AND visit_type = $2`,
    [fee.doctorId, fee.visitType],
  );
  if (existing) {
    console.log(
      "SKIPPED —",
      doctor.name,
      fee.visitType,
      "already has",
      existing.code,
      `₹${existing.base_price}`,
    );
    continue;
  }
  const template = await one(
    `SELECT subgroup_id, unit, tax_code_id, price_includes_tax FROM service_items
      WHERE kind = 'consultation' AND doctor_id = $1 AND visit_type = $2`,
    [TEMPLATE_DOCTOR, fee.visitType],
  );
  const item = {
    code: `CONS-${fee.doctorId}-${SUFFIX[fee.visitType]}`,
    name: `Consultation — ${doctor.name.trim()} (${fee.visitType})`,
    kind: "consultation",
    doctor_id: fee.doctorId,
    visit_type: fee.visitType,
    base_price: fee.price,
    ...(template?.subgroup_id ? { subgroup_id: template.subgroup_id } : {}),
    ...(template?.unit ? { unit: template.unit } : {}),
    ...(template?.tax_code_id ? { tax_code_id: template.tax_code_id } : {}),
    ...(template ? { price_includes_tax: template.price_includes_tax } : {}),
  };
  if (!APPLY) {
    console.log("[dry]", item.code, "|", item.name, `₹${item.base_price}`);
    created += 1;
    continue;
  }
  try {
    const saved = await createItem(item, {});
    console.log("created", saved.code, "|", saved.name, `₹${saved.base_price}`);
    created += 1;
  } catch (error) {
    console.log("SKIPPED", item.code, "—", error.message);
  }
}
console.log(APPLY ? "APPLIED" : "DRY RUN — rerun with --apply", `· ${created} item(s)`);
await pool.end();
