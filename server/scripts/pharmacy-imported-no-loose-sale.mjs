import "../loadEnv.js";
import pool from "../config/db.js";
import { writeAuditMany } from "../services/billing/audit.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 100;
const PAUSE_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = `
  SELECT m.id FROM pharmacy_medicines m
   WHERE m.allow_loose_sale
     AND EXISTS (
       SELECT 1 FROM pharmacy_purchase_lines pl
         JOIN pharmacy_purchases p ON p.id = pl.purchase_id
        WHERE pl.medicine_id = m.id AND p.kind = 'opening' AND p.notes LIKE 'Excel import %')
   ORDER BY m.id`;

async function dryRun() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query(TARGETS);
    const { rows: total } = await client.query(`SELECT count(*)::int AS n FROM pharmacy_medicines`);
    console.log(
      `Dry run: ${rows.length} imported medicine(s) still allow loose sale (of ${total[0].n} medicines). Nothing changed.`,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

async function applyBatch(ids) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE pharmacy_medicines
          SET allow_loose_sale = false, version = version + 1, updated_at = NOW()
        WHERE id = ANY($1::int[]) AND allow_loose_sale
        RETURNING id, code, name`,
      [ids],
    );
    await writeAuditMany(
      client,
      rows.map((m) => ({
        entity: "pharmacy_medicines",
        entityId: m.id,
        action: "update",
        before: { allow_loose_sale: true },
        after: { allow_loose_sale: false, code: m.code, name: m.name },
      })),
    );
    await client.query("COMMIT");
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function apply() {
  const { rows } = await pool.query(TARGETS);
  const ids = rows.map((r) => r.id);
  console.log(`Applying to ${ids.length} medicine(s) in batches of ${BATCH}`);
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    done += await applyBatch(ids.slice(i, i + BATCH));
    console.log(`  ${done}/${ids.length} updated`);
    await sleep(PAUSE_MS);
  }
  const { rows: left } = await pool.query(TARGETS);
  console.log(`Done. ${done} updated, ${left.length} still allow loose sale.`);
}

try {
  await (APPLY ? apply() : dryRun());
} catch (error) {
  console.error("Stopped:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
