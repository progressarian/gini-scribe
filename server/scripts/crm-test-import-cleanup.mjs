import "../loadEnv.js";
import pool from "../config/db.js";

const COMMIT = process.argv.includes("--commit");
const NAME = "TEST IMPORT %";
const FILE = "crm-test-import%";

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const { rows: doctors } = await client.query(
    `SELECT d.id, d.full_name, d.mobile, d.clinic_phone, u.full_name AS owner
       FROM crm.doctors d
       LEFT JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
       LEFT JOIN crm.users u ON u.id = a.executive_id
      WHERE d.full_name LIKE $1 AND d.deleted_at IS NULL
      ORDER BY d.full_name`,
    [NAME],
  );
  const { rows: batches } = await client.query(
    `SELECT id, file_name, status, created_at FROM crm.import_batches
      WHERE file_name ILIKE $1 AND status <> 'cancelled' ORDER BY created_at`,
    [FILE],
  );

  console.table(
    doctors.map((d) => ({
      doctor: d.full_name,
      mobile: d.mobile || d.clinic_phone || "",
      owner: d.owner || "",
    })),
  );
  console.table(batches.map((b) => ({ file: b.file_name, status: b.status, at: b.created_at })));

  const ids = doctors.map((d) => d.id);
  const closed = await client.query(
    `UPDATE crm.doctor_assignments SET effective_to = now(), updated_at = now()
      WHERE doctor_id = ANY($1::uuid[]) AND effective_to IS NULL`,
    [ids],
  );
  const removed = await client.query(
    `UPDATE crm.doctors SET deleted_at = now(), is_active = false
      WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [ids],
  );
  const cancelled = await client.query(
    `UPDATE crm.import_batches SET status = 'cancelled', updated_at = now()
      WHERE id = ANY($1::uuid[])`,
    [batches.map((b) => b.id)],
  );

  console.log(
    `\n${removed.rowCount} test doctors removed, ${closed.rowCount} assignments closed, ${cancelled.rowCount} test imports cancelled`,
  );

  if (COMMIT) {
    await client.query("COMMIT");
    console.log("Committed.\n");
  } else {
    await client.query("ROLLBACK");
    console.log("Dry run — rolled back, nothing changed. Re-run with --commit.\n");
  }
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("FAILED, nothing changed:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
