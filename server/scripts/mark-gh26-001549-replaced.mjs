import "../loadEnv.js";
import pool from "../config/db.js";
import { markReplaced } from "../services/billing/rebill.js";

const APPLY = process.argv.includes("--apply");
const REASON = "Replaced by the corrected bill GH26-001550 (credit note CN26-000052)";

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query(
    `SELECT bill_no, id, visit_id, status, replaced_by_bill_id FROM bills
      WHERE bill_no IN ('GH26-001549', 'GH26-001550') ORDER BY bill_no`,
  );
  const [old, fresh] = rows;
  if (rows.length !== 2 || old.visit_id !== fresh.visit_id || fresh.status !== "final") {
    throw new Error("Bills aren't as expected, nothing changed");
  }
  if (old.replaced_by_bill_id) {
    console.log(`Already linked to ${old.replaced_by_bill_id}`);
  } else {
    await markReplaced(client, old, fresh.id, REASON, { actorId: 11, role: "admin", ip: null });
    console.log(`GH26-001549 marked as replaced by GH26-001550`);
  }
  if (APPLY) {
    await client.query("COMMIT");
    console.log("COMMITTED");
  } else {
    await client.query("ROLLBACK");
    console.log("DRY RUN — rolled back. Pass --apply to write.");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("ROLLED BACK:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
