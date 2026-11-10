import "../loadEnv.js";
import pool from "../config/db.js";
import { clearConsultantFee, saveConsultantFee } from "../services/billing/consultantFees.js";

const apply = process.argv.includes("--apply");
const ctx = { actorId: null, ip: "script:fix-bhansali-window-fees" };

const show = (label, cell) =>
  console.log(
    `  ${label}: ₹${cell.fee} (${cell.fee_source}), patient pays ${cell.pays.patient_pays}`,
  );

async function itemId(client, code) {
  const { rows } = await client.query(
    `SELECT id FROM service_items WHERE code = $1 AND is_active AND doctor_id = 1`,
    [code],
  );
  if (!rows.length) throw new Error(`${code} not found for Dr. Anil Bhansali`);
  return rows[0].id;
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const week = await itemId(client, "CONS-1-FU7");
  const three = await itemId(client, "CONS-1-FU3");
  console.log(apply ? "APPLY" : "DRY RUN");
  for (const scheme of ["cghs", "himachal_govt"]) {
    const saved = await saveConsultantFee(
      { scheme_code: scheme, service_item_id: week, fee: 700 },
      ctx,
      client,
    );
    show(`CONS-1-FU7 ${scheme}`, saved.cell);
  }
  const cleared = await clearConsultantFee(
    { scheme_code: "senior_citizen", service_item_id: three },
    ctx,
    client,
  );
  show("CONS-1-FU3 senior_citizen", cleared.cell);
  if (apply) {
    await client.query("COMMIT");
    console.log("Committed.");
  } else {
    await client.query("ROLLBACK");
    console.log("Dry run rolled back, nothing written. Re-run with --apply.");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`Stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
