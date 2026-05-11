// One-off: delete all patient_summaries rows for a patient identified by file_no.
// Usage: node server/scripts/delete-patient-summaries.js P_159470
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import pool from "../config/db.js";

const fileNo = process.argv[2];
if (!fileNo) {
  console.error("Usage: node server/scripts/delete-patient-summaries.js <file_no>");
  process.exit(1);
}

const client = await pool.connect();
try {
  const p = await client.query("SELECT id, name, file_no FROM patients WHERE file_no = $1", [
    fileNo,
  ]);
  if (!p.rowCount) {
    console.error(`No patient found for file_no=${fileNo}`);
    process.exit(2);
  }
  const { id, name } = p.rows[0];
  console.log(`Resolved ${fileNo} → patient_id=${id} (${name})`);

  await client.query("BEGIN");

  const rows = await client.query(
    "SELECT * FROM patient_summaries WHERE patient_id = $1 ORDER BY version",
    [id],
  );
  console.log(`Found ${rows.rowCount} patient_summaries row(s)`);

  if (rows.rowCount > 0) {
    const backupPath = path.join("/tmp", `patient_summaries_${fileNo}_backup.json`);
    fs.writeFileSync(backupPath, JSON.stringify(rows.rows, null, 2));
    console.log(`Backup written to ${backupPath}`);
  }

  const del = await client.query("DELETE FROM patient_summaries WHERE patient_id = $1", [id]);
  console.log(`Deleted ${del.rowCount} row(s)`);

  await client.query("COMMIT");
  console.log("Committed.");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Failed:", e);
  process.exit(3);
} finally {
  client.release();
  await pool.end();
}
