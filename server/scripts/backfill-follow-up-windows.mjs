import "../loadEnv.js";
import pool from "../config/db.js";
import { writeAuditMany } from "../services/billing/audit.js";
import { FOLLOW_UP_WITHIN_DAYS, RECENT_FOLLOW_UP } from "../../shared/billingVocab.js";

const apply = process.argv.includes("--apply");
const BATCH = 100;

async function batch(client) {
  const { rows } = await client.query(
    `WITH picked AS (
       SELECT id, follow_up_within_days FROM service_items
        WHERE visit_type = $1 AND follow_up_within_days IS NULL
        ORDER BY id LIMIT $3
        FOR UPDATE
     )
     UPDATE service_items i
        SET follow_up_within_days = $2, updated_at = NOW()
       FROM picked
      WHERE i.id = picked.id
      RETURNING i.id, i.code, i.name, i.doctor_id, i.is_active`,
    [RECENT_FOLLOW_UP, FOLLOW_UP_WITHIN_DAYS, BATCH],
  );
  await writeAuditMany(
    client,
    rows.map((row) => ({
      entity: "service_items",
      entityId: row.id,
      action: "update",
      before: { follow_up_within_days: null },
      after: { follow_up_within_days: FOLLOW_UP_WITHIN_DAYS },
    })),
  );
  return rows;
}

const client = await pool.connect();
try {
  const { rows: pending } = await client.query(
    `SELECT count(*)::int AS n FROM service_items
      WHERE visit_type = $1 AND follow_up_within_days IS NULL`,
    [RECENT_FOLLOW_UP],
  );
  console.log(
    `${apply ? "APPLY" : "DRY RUN"} — ${pending[0].n} "${RECENT_FOLLOW_UP}" items without a window`,
  );
  if (!apply) {
    await client.query("BEGIN");
    const rows = await batch(client);
    for (const row of rows) {
      console.log(
        `  would ${row.code} ${row.name}${row.is_active ? "" : " (inactive)"} → ${FOLLOW_UP_WITHIN_DAYS} days`,
      );
    }
    await client.query("ROLLBACK");
    if (pending[0].n) console.log("Dry run rolled back, nothing written. Re-run with --apply.");
  } else {
    let done = 0;
    for (;;) {
      await client.query("BEGIN");
      const rows = await batch(client);
      await client.query("COMMIT");
      if (!rows.length) break;
      done += rows.length;
      console.log(`  batch of ${rows.length} committed (${done} so far)`);
    }
    console.log(`${done} items given a ${FOLLOW_UP_WITHIN_DAYS}-day window.`);
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`Stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
