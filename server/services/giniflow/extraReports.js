import pool from "../../config/db.js";
import { t as clipText } from "../../utils/helpers.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { storeReportObject } from "./labStation.js";

const MIME_BY_EXT = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const conflict = (message) => Object.assign(new Error(message), { status: 409 });

export async function addExtraReport(
  orderId,
  { base64, fileName, mediaType = "application/pdf" },
  db = pool,
) {
  if (!base64) throw Object.assign(new Error("No file was sent"), { status: 400 });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw Object.assign(new Error("Storage is not configured"), { status: 503 });
  }

  const { rows } = await db.query(
    `SELECT o.kind, o.report_file_url, v.patient_id, v.visit_date::text AS visit_date,
            (SELECT string_agg(t.test_name, ', ' ORDER BY t.test_name)
               FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS tests
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!rows.length) throw notFound("Order not found");
  const order = rows[0];
  if (order.kind !== "machine") throw conflict("Only machine tests take additional reports");
  if (!order.report_file_url) throw conflict("File the first report before adding another");

  const { storagePath, safeName, bytes } = await storeReportObject({
    base64,
    fileName,
    mediaType,
    kind: order.kind,
    patientId: order.patient_id,
  });
  const ext = safeName.split(".").pop()?.toLowerCase();

  const { rows: written } = await db.query(
    `INSERT INTO documents
       (patient_id, doc_type, title, file_name, storage_path, mime_type, doc_date,
        source, notes, giniflow_extra_report_of)
     VALUES ($1,'lab_report',$2,$3,$4,$5,$6::date,'giniflow_lab',$7,$8)
     RETURNING id`,
    [
      order.patient_id,
      clipText(order.tests ? `Lab report — ${order.tests}` : "Lab report", 200),
      clipText(safeName, 200),
      storagePath,
      MIME_BY_EXT[ext] || mediaType || "application/octet-stream",
      order.visit_date,
      order.tests || null,
      orderId,
    ],
  );

  return { orderId, documentId: written[0].id, fileName: safeName, bytes };
}

export async function removeExtraReport(orderId, documentId, db = pool) {
  const { rows } = await db.query(
    `DELETE FROM documents
      WHERE id = $1 AND giniflow_extra_report_of = $2
      RETURNING storage_path`,
    [documentId, orderId],
  );
  if (!rows.length) throw notFound("That report is not on this test");

  const storagePath = rows[0].storage_path;
  if (storagePath) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }).catch(() => {});
  }
  return { orderId, documentId, removed: storagePath };
}

export async function hasExtraReports(orderId, db = pool) {
  const { rows } = await db.query(
    `SELECT 1 FROM documents WHERE giniflow_extra_report_of = $1 LIMIT 1`,
    [orderId],
  );
  return rows.length > 0;
}
