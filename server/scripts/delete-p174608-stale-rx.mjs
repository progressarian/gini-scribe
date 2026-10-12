import "../loadEnv.js";
import pool from "../config/db.js";

const DOC_ID = 101540;
const apply = process.argv.includes("--apply");

try {
  const { rows } = await pool.query(
    `SELECT d.id, d.doc_type, d.source, d.consultation_id, d.storage_path, d.title, p.file_no
       FROM documents d JOIN patients p ON p.id = d.patient_id
      WHERE d.id = $1`,
    [DOC_ID],
  );
  const doc = rows[0];
  console.log(doc || "document not found");
  if (
    !doc ||
    doc.file_no !== "P_174608" ||
    doc.doc_type !== "prescription" ||
    doc.source !== "visit" ||
    doc.consultation_id !== null ||
    !doc.storage_path?.includes("_12_10_2026_11_04_AM_")
  ) {
    throw new Error("Not the stale 12 Oct copy of P_174608's prescription; nothing changed");
  }
  if (!apply) {
    console.log("Preview only. Re-run with --apply to remove this copy.");
  } else {
    await pool.query(`DELETE FROM documents WHERE id = $1`, [DOC_ID]);
    console.log("Removed.");
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
