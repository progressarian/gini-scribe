import "../loadEnv.js";
import pool from "../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";
import { asViewableUpload } from "../services/officeToPdf.js";

const APPLY = process.argv.includes("--apply");
const objectUrl = (path) => `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
const auth = { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };

const { rows } = await pool.query(
  `SELECT d.id, d.patient_id, d.storage_path, d.file_name, d.giniflow_lab_order_id
     FROM documents d
    WHERE d.storage_path ~* '\\.docx$'
    ORDER BY d.id`,
);

console.log(
  `${rows.length} DOCX document(s) found${APPLY ? "" : " — dry run, pass --apply to convert"}`,
);
for (const d of rows) console.log(`  doc ${d.id} patient ${d.patient_id} ${d.storage_path}`);
if (!APPLY || !rows.length) {
  await pool.end();
  process.exit(0);
}

let converted = 0;
for (const d of rows) {
  const download = await fetch(objectUrl(d.storage_path), { headers: auth });
  if (!download.ok) {
    console.error(`STOP doc ${d.id}: download failed ${download.status}`);
    break;
  }
  const pdf = await asViewableUpload({
    buffer: Buffer.from(await download.arrayBuffer()),
    fileName: d.file_name || d.storage_path.split("/").pop(),
  });
  const pdfPath = d.storage_path.replace(/\.docx$/i, ".pdf");
  const upload = await fetch(objectUrl(pdfPath), {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/pdf", "x-upsert": "true" },
    body: pdf.buffer,
  });
  if (!upload.ok) {
    console.error(`STOP doc ${d.id}: upload failed ${upload.status} ${await upload.text()}`);
    break;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE documents SET storage_path = $2, mime_type = 'application/pdf', file_name = $3
        WHERE id = $1 AND storage_path ~* '\\.docx$'`,
      [d.id, pdfPath, pdf.fileName],
    );
    if (d.giniflow_lab_order_id) {
      await client.query(
        `UPDATE giniflow_lab_orders SET report_file_url = $2, updated_at = NOW()
          WHERE id = $1 AND report_file_url = $3`,
        [d.giniflow_lab_order_id, objectUrl(pdfPath), objectUrl(d.storage_path)],
      );
    }
    await client.query("COMMIT");
    converted++;
    console.log(`  converted doc ${d.id} -> ${pdfPath} (${pdf.buffer.length} bytes)`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`STOP doc ${d.id}: ${e.message}`);
    break;
  } finally {
    client.release();
  }
}

console.log(`${converted} of ${rows.length} converted`);
await pool.end();
process.exit(0);
