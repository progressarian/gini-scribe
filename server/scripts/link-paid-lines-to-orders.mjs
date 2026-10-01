import "../loadEnv.js";
import pool from "../config/db.js";
import { resettleTestOrders } from "../services/billing/bills.js";
import { linkLine, lockVisitOrders, openOrdersFor } from "../services/billing/orderLinks.js";

const apply = process.argv.includes("--apply");
const option = (name) => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3).trim() || null : null;
};
const date = option("date");
const fileNo = option("file");
const ctx = { actorId: null, role: "system" };

if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("--date must look like YYYY-MM-DD");
  process.exit(1);
}

const target = new URL(process.env.DATABASE_URL);
console.log(`Database: ${target.hostname}:${target.port}${target.pathname}`);
console.log(apply ? "Mode: APPLY — changes will be saved" : "Mode: dry run — nothing is saved");
console.log(
  `Bills: ${date ? `dated ${date}` : "any date"}, ${fileNo ? `file ${fileNo}` : "any patient"}\n`,
);

const rupees = (value) => `₹${Number(value ?? 0).toFixed(2)}`;

async function unlinkedLines(client) {
  const { rows } = await client.query(
    `SELECT l.id, l.bill_id, l.line_no, l.bill_name, l.item_code, l.source, i.test_catalog_id,
            b.bill_no, b.status, b.visit_id, p.file_no, p.name AS patient
       FROM bill_lines l
       JOIN bills b ON b.id = l.bill_id
       JOIN service_items i ON i.id = l.service_item_id
       JOIN patients p ON p.id = b.patient_id
      WHERE l.is_live AND l.lab_order_id IS NULL AND l.source IN ('added', 'lab_case')
        AND i.kind = 'test' AND i.test_catalog_id IS NOT NULL
        AND b.bill_type = 'invoice' AND b.status IN ('final', 'draft') AND b.visit_id IS NOT NULL
        AND ($1::date IS NULL OR b.bill_date = $1::date)
        AND ($2::text IS NULL OR p.file_no = $2)
        AND EXISTS (SELECT 1 FROM giniflow_lab_orders o WHERE o.visit_id = b.visit_id)
      ORDER BY b.visit_id, b.id, l.line_no`,
    [date, fileNo],
  );
  return rows;
}

async function orderMoney(client, orderId) {
  const { rows } = await client.query(
    `SELECT payment_status, amount_paid, amount_total FROM giniflow_lab_orders WHERE id = $1`,
    [orderId],
  );
  return rows[0];
}

const moneyText = (money) =>
  `${money.payment_status} (${rupees(money.amount_paid)} of ${rupees(money.amount_total)})`;

async function lockVisit(client, visitId) {
  await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR NO KEY UPDATE`, [visitId]);
  await client.query(`SELECT id FROM bills WHERE visit_id = $1 ORDER BY id FOR UPDATE`, [visitId]);
  await lockVisitOrders(client, visitId);
}

async function linkVisit(client, lines, plan) {
  await lockVisit(client, lines[0].visit_id);
  const touched = new Map();
  const bills = new Set();
  for (const line of lines) {
    const where = `${line.file_no} ${line.patient} · ${line.bill_no ?? "draft"} (${line.status}) · line ${line.line_no} ${line.item_code ?? ""} ${line.bill_name}`;
    const open = await openOrdersFor(client, {
      visitId: line.visit_id,
      billId: line.bill_id,
      catalogId: line.test_catalog_id,
    });
    if (!open.length) continue;
    if (open.length > 1) {
      plan.refused.push(
        `${where}: matches ${open.length} open orders (${open.map((o) => o.order_id).join(", ")})`,
      );
      continue;
    }
    const [order] = open;
    if (order.test_names.length > 1) {
      plan.refused.push(
        `${where}: matches ${order.test_names.length} tests on order ${order.order_id} (${order.test_names.join(", ")})`,
      );
      continue;
    }
    if (!touched.has(order.order_id)) {
      touched.set(order.order_id, await orderMoney(client, order.order_id));
    }
    const bill = { id: line.bill_id, bill_no: line.bill_no };
    if (!(await linkLine(client, bill, line, order.order_id, ctx))) continue;
    bills.add(line.bill_id);
    plan.linked.push(`${where} → order ${order.order_id}, test "${order.test_names[0]}"`);
  }
  for (const billId of bills) {
    const { rows } = await client.query(`SELECT * FROM bills WHERE id = $1`, [billId]);
    await resettleTestOrders(client, rows[0], ctx);
  }
  for (const [orderId, before] of touched) {
    const after = await orderMoney(client, orderId);
    plan.orders.push(
      `${lines[0].file_no} order ${orderId}: ${moneyText(before)} → ${moneyText(after)}`,
    );
  }
}

async function run(client) {
  const plan = { linked: [], refused: [], orders: [] };
  const byVisit = new Map();
  for (const line of await unlinkedLines(client)) {
    byVisit.set(line.visit_id, [...(byVisit.get(line.visit_id) ?? []), line]);
  }
  for (const lines of byVisit.values()) await linkVisit(client, lines, plan);
  return plan;
}

function print(plan) {
  const section = (title, list) => {
    console.log(`${title}: ${list.length}`);
    list.forEach((line) => console.log(`  ${line}`));
    console.log("");
  };
  section("Lines linked to their test order", plan.linked);
  section("Test orders", plan.orders);
  section("Refused — ambiguous, left unlinked", plan.refused);
}

const client = await pool.connect();
let exitCode = 0;
try {
  await client.query("BEGIN");
  const plan = await run(client);
  print(plan);
  if (!apply) {
    console.log("Dry run only. Re-run with --apply to save.");
    await client.query("ROLLBACK");
  } else {
    await client.query("COMMIT");
    console.log("Saved.");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`\nFailed, nothing saved: ${error.message}`);
  exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
process.exit(exitCode);
