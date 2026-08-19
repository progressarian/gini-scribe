import "../loadEnv.js";
import express from "express";
import router from "../routes/ghm-patient-record.js";
import pool from "../config/db.js";

const app = express();
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();

const get = async (path) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`);
  const body = await r.json().catch(() => null);
  return { status: r.status, body, type: r.headers.get("content-type") };
};

try {
  let id = Number(process.argv[2]);
  if (!Number.isInteger(id)) {
    id = (
      await pool.query(
        `SELECT patient_id FROM documents WHERE patient_id IS NOT NULL
         GROUP BY patient_id ORDER BY COUNT(*) DESC LIMIT 1`,
      )
    ).rows[0]?.patient_id;
  }
  if (!id) throw new Error("No patient with documents found");

  const rec = await get(`/ghm-patient-record/${id}`);
  if (rec.status !== 200) throw new Error(`record HTTP ${rec.status}: ${JSON.stringify(rec.body)}`);
  const b = rec.body;
  console.log(`patient ${id}: ${b.patient?.name} (${b.patient?.file_no})`);
  for (const k of ["documents", "consultations", "visits", "labs", "medications"]) {
    if (!Array.isArray(b[k])) throw new Error(`missing array: ${k}`);
    console.log(`  ${k.padEnd(14)} ${b[k].length}`);
  }

  const bad = await get(`/ghm-patient-record/999999999`);
  if (bad.status !== 404) throw new Error(`unknown patient should 404, got ${bad.status}`);
  console.log("  unknown patient → 404");

  const rx = b.consultations.find((c) => c.has_prescription);
  if (rx) {
    const one = await get(`/ghm-patient-record/prescription/${rx.id}`);
    if (one.status !== 200) throw new Error(`prescription HTTP ${one.status}`);
    console.log(
      `  prescription ${rx.id}: ${one.body.medications?.length || 0} meds, ${one.body.diagnoses?.length || 0} dx`,
    );
  }

  const doc = b.documents.find((d) => d.has_file);
  if (doc) {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/ghm-patient-record/document/${doc.id}/stream`,
    );
    const bytes = r.ok ? (await r.arrayBuffer()).byteLength : 0;
    console.log(
      `  document ${doc.id} stream → HTTP ${r.status} ${r.headers.get("content-type")} ${bytes}B`,
    );
    if (!r.ok) throw new Error(`document stream failed: HTTP ${r.status}`);
  }

  console.log("\nOK");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  server.close();
  await pool.end();
}
