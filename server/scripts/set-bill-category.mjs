import "../loadEnv.js";
import pool from "../config/db.js";
import { setCategory } from "../services/billing/bills.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [billId, category = ""] = args.filter((arg) => !arg.startsWith("--"));
const ctx = { actorId: null };

if (!billId) {
  console.error("Usage: node scripts/set-bill-category.mjs <billId> [category] [--apply]");
  process.exit(1);
}

const target = new URL(process.env.DATABASE_URL);
console.log(`Database: ${target.hostname}:${target.port}${target.pathname}`);
console.log(apply ? "Mode: APPLY — changes will be saved\n" : "Mode: dry run — nothing is saved\n");

const money = (value) => `₹${Number(value).toLocaleString("en-IN")}`;

async function linesOf(client) {
  const { rows } = await client.query(
    `SELECT b.scheme_code, b.scheme_label, l.bill_name, l.rate, l.patient_payable
       FROM bills b JOIN bill_lines l ON l.bill_id = b.id
      WHERE b.id = $1 ORDER BY l.line_no`,
    [billId],
  );
  if (!rows.length) throw new Error("That bill has no lines");
  return rows;
}

function show(label, rows) {
  console.log(`${label}: ${rows[0].scheme_label ?? "General (no category)"}`);
  for (const row of rows) {
    console.log(
      `  ${row.bill_name.padEnd(64)} ${money(row.rate).padStart(9)} → pays ${money(row.patient_payable)}`,
    );
  }
  const total = rows.reduce((sum, row) => sum + Number(row.patient_payable), 0);
  console.log(`  Total payable ${money(total)}\n`);
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    show("Before", await linesOf(client));
    await setCategory(billId, { category }, ctx, client);
    show("After", await linesOf(client));
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    console.log(apply ? "Saved." : "Dry run only. Rerun with --apply to save.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

run()
  .catch((error) => {
    console.error(`Stopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
