import "../loadEnv.js";
import pool from "../config/db.js";
import { removeLine } from "../services/billing/bills.js";

const apply = process.argv.includes("--apply");
const reasonArg = process.argv.find((arg) => arg.startsWith("--reason="));
const reason = reasonArg ? reasonArg.slice("--reason=".length) : "Added by mistake";
const [fileNo, itemCode] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

if (!fileNo || !itemCode) {
  console.error(
    'usage: node scripts/remove-draft-line.mjs <FILE_NO> <ITEM_CODE> [--reason="…"] [--apply]',
  );
  process.exit(1);
}

const target = new URL(process.env.DATABASE_URL);
console.log(`Database: ${target.hostname}:${target.port}${target.pathname}`);
console.log(
  apply ? "Mode: APPLY — the line will be removed\n" : "Mode: dry run — nothing is saved\n",
);

const client = await pool.connect();
let exitCode = 0;
try {
  await client.query("BEGIN");
  const { rows } = await client.query(
    `SELECT l.id AS line_id, l.bill_name, l.item_code, l.patient_payable, b.id AS bill_id,
            b.status, b.patient_payable AS bill_payable, p.name
       FROM bill_lines l
       JOIN bills b ON b.id = l.bill_id
       JOIN giniflow_visits v ON v.id = b.visit_id
       JOIN patients p ON p.id = v.patient_id
      WHERE p.file_no = $1 AND lower(l.item_code) = lower($2)
        AND v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND l.credited_line_id IS NULL`,
    [fileNo, itemCode],
  );
  if (rows.length !== 1) {
    throw new Error(
      `expected one ${itemCode} line on ${fileNo}'s bills today, found ${rows.length}`,
    );
  }
  const line = rows[0];
  if (line.status !== "draft") throw new Error(`the bill is ${line.status}, not a draft`);
  const after = await removeLine(line.bill_id, line.line_id, { reason }, { actorId: null }, client);
  console.log(
    `${line.name}: remove ${line.bill_name} (${line.item_code}) ₹${Number(line.patient_payable)} — reason "${reason}"`,
  );
  console.log(`Bill total ₹${Number(line.bill_payable)} → ₹${after.totals.payable / 100}`);
  if (apply) {
    await client.query("COMMIT");
    console.log("\nRemoved.");
  } else {
    await client.query("ROLLBACK");
    console.log("\nDry run only. Re-run with --apply to remove.");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`\nFailed, nothing changed: ${error.message}`);
  exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
process.exit(exitCode);
