import pg from "pg";
import "../loadEnv.js";

const id = process.argv[2];
if (!id) {
  console.error("Usage: node scripts/show-billing-request.mjs <request id>");
  process.exit(1);
}
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const { rows } = await client.query(
    `SELECT r.id, r.kind, r.status, r.amount, r.requested_mode, r.approved_mode, r.reason,
            p.name AS patient, p.file_no, q.name AS requested_by, d.name AS decided_by,
            a.balance AS deposit_balance
       FROM billing_requests r
       LEFT JOIN patients p ON p.id = r.patient_id
       LEFT JOIN doctors q ON q.id = r.requested_by
       LEFT JOIN doctors d ON d.id = r.decided_by
       LEFT JOIN deposit_accounts a ON a.patient_id = r.patient_id
      WHERE r.id = $1`,
    [id],
  );
  console.table(rows);
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}
