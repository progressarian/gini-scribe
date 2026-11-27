import "../loadEnv.js";
import pool from "../config/db.js";
import { writeAudit } from "../services/billing/audit.js";

const NOTE_NO = "CN26-000057";
const NOTE_ID = "9cc48d3c-33f0-445f-9688-f48ca5cdf18d";
const ORIGINAL_NO = "GH26-001834";
const REASON =
  "Discount credit note deleted at the hospital's request: the 20% was applied on ₹2,520 instead of ₹2,800, nothing was paid out";
const apply = process.argv.includes("--apply");

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '30s'");

  const { rows: notes } = await client.query(
    `SELECT n.*, o.bill_no AS original_no FROM bills n JOIN bills o ON o.id = n.original_bill_id
      WHERE n.id = $1 FOR UPDATE OF n`,
    [NOTE_ID],
  );
  const note = notes[0];
  if (!note || note.bill_no !== NOTE_NO || note.original_no !== ORIGINAL_NO) {
    throw new Error("The credit note isn't the one expected");
  }
  if (note.bill_type !== "credit_note" || note.credit_kind !== "discount") {
    throw new Error("Not a discount credit note");
  }

  const refs = await client.query(
    `SELECT (SELECT count(*) FROM payments WHERE bill_id = $1)
          + (SELECT count(*) FROM deposit_entries WHERE bill_id = $1)
          + (SELECT count(*) FROM billing_requests WHERE bill_id = $1 OR credit_note_id = $1)
          + (SELECT count(*) FROM consultant_changes WHERE credit_note_id = $1 OR new_bill_id = $1)
          + (SELECT count(*) FROM claim_settlement_bills WHERE bill_id = $1)
          + (SELECT count(*) FROM bills WHERE original_bill_id = $1 OR replaced_by_bill_id = $1)
          + (SELECT count(*) FROM bill_lines x
              WHERE x.credited_line_id IN (SELECT id FROM bill_lines WHERE bill_id = $1)) AS n`,
    [NOTE_ID],
  );
  if (Number(refs.rows[0].n) !== 0) throw new Error("Something now refers to the credit note");

  const { rows: series } = await client.query(
    `SELECT next_no FROM bill_series WHERE series = 'CN' AND fy = $1 FOR UPDATE`,
    [note.fy],
  );
  const { rows: latest } = await client.query(
    `SELECT bill_no FROM bills WHERE bill_type = 'credit_note' AND series = 'CN' AND fy = $1
      ORDER BY created_at DESC LIMIT 1`,
    [note.fy],
  );
  const isLast = Number(series[0].next_no) === 58 && latest[0].bill_no === NOTE_NO;

  const { rows: lines } = await client.query(
    `DELETE FROM bill_lines WHERE bill_id = $1 RETURNING *`,
    [NOTE_ID],
  );
  await client.query(`DELETE FROM bills WHERE id = $1`, [NOTE_ID]);
  if (isLast) {
    await client.query(
      `UPDATE bill_series SET next_no = 57, updated_at = NOW() WHERE series = 'CN' AND fy = $1`,
      [note.fy],
    );
  }
  await client.query(`UPDATE bills SET version = version + 1, updated_at = NOW() WHERE id = $1`, [
    note.original_bill_id,
  ]);
  await writeAudit(client, {
    entity: "bills",
    entityId: NOTE_ID,
    action: "delete",
    before: { ...note, lines },
    after: { deleted: true, reason: REASON, cn_number_reused: isLast },
    actorId: null,
    ip: "script:delete-credit-note-cn26-000057",
  });

  const { rows: money } = await client.query(
    `SELECT o.patient_payable, o.paid_amount,
            (SELECT COALESCE(SUM(patient_payable), 0) FROM bills WHERE original_bill_id = o.id) AS credited,
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p JOIN bills c ON c.id = p.bill_id
              WHERE c.original_bill_id = o.id AND p.direction = 'out') AS paid_back
       FROM bills o WHERE o.id = $1`,
    [note.original_bill_id],
  );
  console.log({
    deleted: NOTE_NO,
    lines_deleted: lines.length,
    cn_series_back_to_57: isLast,
    original_after: money[0],
  });

  if (apply) {
    await client.query("COMMIT");
    console.log("APPLIED");
  } else {
    await client.query("ROLLBACK");
    console.log("DRY RUN — rolled back. Run again with --apply to delete.");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("FAILED:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
