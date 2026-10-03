import "../loadEnv.js";
import pool from "../config/db.js";
import { removeLine } from "../services/billing/bills.js";
import { setItemActive } from "../services/billing/serviceItems.js";
import { addAlias } from "../services/billing/serviceItemAliases.js";

const APPLY = process.argv.includes("--apply");

const DRAFT = { fileNo: "P_181879", codes: ["HR-CHEST-X-RAY", "LAB-SODIUM-SERUM"] };
const MERGES = [
  { from: "LAB-SODIUM-SERUM", into: "LAB-SODIUM" },
  { from: "LAB-PHOSPHORUS-SERUM", into: "LAB-PHOSPHORUS" },
  { from: "LAB-PROTEIN-TOTAL-24-HOURS-URINE", into: "LAB-24-HOURS-URINE-PROTEIN" },
  { from: "HR-CHEST-X-RAY", into: "RAD-XRAY-CHEST" },
];

const one = async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null;
const item = (code) =>
  one(`SELECT id, code, name, kind, is_active FROM service_items WHERE code = $1`, [code]);

const { rows: lines } = await pool.query(
  `SELECT b.id AS bill_id, b.status, l.id AS line_id, i.code, i.name, l.actual_amount
     FROM bills b JOIN giniflow_visits v ON v.id = b.visit_id JOIN patients p ON p.id = v.patient_id
     JOIN bill_lines l ON l.bill_id = b.id AND l.is_live JOIN service_items i ON i.id = l.service_item_id
    WHERE p.file_no = $1 AND v.visit_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
      AND b.bill_type = 'invoice' AND i.code = ANY($2)`,
  [DRAFT.fileNo, DRAFT.codes],
);
for (const line of lines) {
  const what = `${DRAFT.fileNo} remove ${line.name} ₹${line.actual_amount} (bill ${line.status})`;
  if (line.status !== "draft") {
    console.log("SKIPPED", what, "— bill is not a draft");
    continue;
  }
  if (!APPLY) {
    console.log("[dry]", what);
    continue;
  }
  await removeLine(
    line.bill_id,
    line.line_id,
    { reason: `Duplicate of ${line.code === "HR-CHEST-X-RAY" ? "X-Ray Chest" : "Sodium"}` },
    { role: "admin" },
  );
  console.log("removed", what);
}

for (const merge of MERGES) {
  const from = await item(merge.from);
  const into = await item(merge.into);
  if (!from || !into) {
    console.log("SKIPPED", merge.from, "→", merge.into, "— not found");
    continue;
  }
  const what = `"${from.name}" (${from.code}) → also billed as on "${into.name}" (${into.code}), switch off ${from.code}`;
  if (!APPLY) {
    console.log("[dry]", what);
    continue;
  }
  if (from.is_active) await setItemActive(from.id, false, {});
  const taken = await one(
    `SELECT 1 FROM service_item_aliases WHERE service_item_id = $1 AND lower(name) = lower($2)`,
    [into.id, from.name],
  );
  if (!taken) await addAlias(into.id, { name: from.name }, {});
  console.log("merged", what);
}
console.log(APPLY ? "APPLIED" : "DRY RUN — rerun with --apply");
await pool.end();
