import "../loadEnv.js";
import pool from "../config/db.js";
import { repriceBillIn } from "../services/billing/bills.js";
import { writeAudit } from "../services/billing/audit.js";

const itemId = Number(process.argv[2]);
const apply = process.argv.includes("--apply");
const BATCH = 25;
const REASON = "Prices changed in Settings";

if (!Number.isInteger(itemId)) {
  console.error("Usage: node scripts/reprice-drafts-for-item.mjs <service_item_id> [--apply]");
  process.exit(1);
}

const TOTALS = `id, version, actual_amount, discount_amount, patient_payable, claim_amount, status`;

async function staleDrafts() {
  const { rows } = await pool.query(
    `SELECT DISTINCT b.id, b.bill_date
       FROM bills b
       JOIN bill_lines l ON l.bill_id = b.id AND l.is_live
       JOIN service_items i ON i.id = l.service_item_id
      WHERE b.status = 'draft' AND l.service_item_id = $1 AND l.base_rate <> i.base_price
      ORDER BY b.bill_date, b.id`,
    [itemId],
  );
  return rows.map((r) => r.id);
}

async function repriceOne(billId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: before } = await client.query(
      `SELECT ${TOTALS} FROM bills WHERE id = $1 FOR UPDATE`,
      [billId],
    );
    if (before[0]?.status !== "draft") {
      await client.query("ROLLBACK");
      return { billId, skipped: "no longer a draft" };
    }
    await repriceBillIn(client, billId, { actorId: null });
    const { rows: after } = await client.query(`SELECT ${TOTALS} FROM bills WHERE id = $1`, [
      billId,
    ]);
    await writeAudit(client, {
      entity: "bills",
      entityId: billId,
      action: "update",
      before: before[0],
      after: { ...after[0], reason: REASON, service_item_id: itemId },
      actorId: null,
    });
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return {
      billId,
      from: Number(before[0].patient_payable),
      to: Number(after[0].patient_payable),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.status === 409) return { billId, skipped: error.message };
    throw error;
  } finally {
    client.release();
  }
}

const ids = await staleDrafts();
console.log(
  `${apply ? "APPLY" : "DRY RUN"}: ${ids.length} draft bill(s) with item ${itemId} off its price`,
);
let changed = 0;
let fromTotal = 0;
let toTotal = 0;
const skipped = [];
for (let i = 0; i < ids.length; i += BATCH) {
  for (const id of ids.slice(i, i + BATCH)) {
    const result = await repriceOne(id);
    if (result.skipped) {
      skipped.push(result);
      continue;
    }
    changed += 1;
    fromTotal += result.from;
    toTotal += result.to;
  }
  console.log(`  ${Math.min(i + BATCH, ids.length)}/${ids.length} done`);
  if (apply) await new Promise((resolve) => setTimeout(resolve, 500));
}
console.log({ changed, payableBefore: fromTotal, payableAfter: toTotal, skipped });
await pool.end();
