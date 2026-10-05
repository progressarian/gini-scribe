import pool from "../../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { parseBillingPdfWithAi } from "../healthray/billingExtractor.js";
import { storeReportObject } from "../giniflow/labStation.js";
import { httpError, inTransaction } from "./transaction.js";
import { writeAudit } from "./audit.js";
import { auditFields } from "./common.js";
import {
  draftOf,
  ensureReviewService,
  isOpenDraft,
  matchLines,
  nameKey,
  namesPaidAtReception,
  suggestedLines,
} from "./healthrayBillLines.js";

export const SCANNED_REPORT_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

const DOC_TYPE = "billing_report";
const MAX_BYTES = 5 * 1024 * 1024;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOTHING = { shown: false, reports: [], lines: [], not_matched: [] };

const flatUhid = (value) =>
  String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

async function patientOf(db, patientId) {
  const { rows } = await db.query(`SELECT name, file_no FROM patients WHERE id = $1`, [patientId]);
  return rows[0] ?? null;
}

function mismatchOf(parsed, patient) {
  const uhid = flatUhid(parsed.uhid);
  if (!uhid || !patient?.file_no || uhid === flatUhid(patient.file_no)) return null;
  return `This report is for ${parsed.patient_name || "another patient"} (${parsed.uhid}), not ${patient.name} (${patient.file_no}). Check it before adding anything.`;
}

const scannedItems = (parsed) =>
  (parsed.items || [])
    .filter((item) => item.desc?.trim() && Number(item.amount) > 0)
    .map((item) => ({
      desc: item.desc.trim(),
      amount: Number(item.amount),
      unit: Number(item.unit) || 1,
      rate: Number(item.rate) || Number(item.amount),
      category: item.category,
    }));

async function addReviewServices(db, bill, items, ctx) {
  const { notMatched } = await matchLines(db, bill, items);
  if (!notMatched.length) return;
  const paid = await namesPaidAtReception(db, bill.visit_id);
  for (const { desc } of notMatched) {
    if (paid.has(nameKey(desc))) continue;
    await inTransaction((client) => ensureReviewService(client, desc, ctx), db);
  }
}

export async function scanBillReport(
  billId,
  { base64, mediaType, fileName },
  ctx,
  db = pool,
  { signal } = {},
) {
  const bill = await draftOf(db, billId);
  if (!isOpenDraft(bill)) {
    throw httpError(409, "A report can only be scanned onto a draft bill for a visit");
  }
  if (!SCANNED_REPORT_TYPES.includes(mediaType)) {
    throw httpError(400, "Upload the bill as a PDF or a photo (JPG, PNG or WebP)");
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("File storage is not set up, so the report can't be saved");
  }
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw httpError(400, "That file is empty");
  if (buffer.length > MAX_BYTES) {
    throw httpError(413, "The report is larger than 5 MB — upload a smaller PDF or photo");
  }

  const parsed = await parseBillingPdfWithAi(buffer, mediaType, { signal });
  if (signal?.aborted) throw httpError(409, "The scan was cancelled, so nothing was saved");
  if (!parsed) {
    throw httpError(
      422,
      "The report couldn't be read. Try the PDF, or a clearer straight-on photo.",
    );
  }
  const items = scannedItems(parsed);
  if (!items.length)
    throw httpError(422, "No billed items with an amount were found in that report");

  const warning = mismatchOf(parsed, await patientOf(db, bill.patient_id));
  if (signal?.aborted) throw httpError(409, "The scan was cancelled, so nothing was saved");
  const { storagePath, safeName } = await storeReportObject({
    base64,
    fileName,
    mediaType,
    patientId: bill.patient_id,
    folder: "billing/reports",
  });
  await db.query(
    `INSERT INTO documents
       (patient_id, doc_type, title, file_name, storage_path, mime_type, doc_date, source,
        extracted_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'billing_counter', $8)`,
    [
      bill.patient_id,
      DOC_TYPE,
      parsed.bill_no ? `Billing report — ${parsed.bill_no}` : "Billing report",
      safeName,
      storagePath,
      mediaType,
      ISO_DATE.test(parsed.bill_date || "") ? parsed.bill_date : bill.visit_date,
      JSON.stringify({
        visit_id: bill.visit_id,
        bill_id: bill.id,
        bill_no: parsed.bill_no || null,
        bill_date: parsed.bill_date || null,
        uhid: parsed.uhid || null,
        patient_name: parsed.patient_name || null,
        total: Number(parsed.total) || null,
        items,
        warning,
        scanned_by: ctx?.actorId ?? null,
      }),
    ],
  );
  if (!warning) await addReviewServices(db, bill, items, ctx);
  return scannedBillSuggestion(bill.id, ctx, db);
}

export async function scannedBillSuggestion(billId, ctx, db = pool) {
  const bill = await draftOf(db, billId);
  if (!isOpenDraft(bill)) return NOTHING;
  const { rows: reports } = await db.query(
    `SELECT id, file_name, mime_type, created_at, extracted_data
       FROM documents
      WHERE patient_id = $1 AND doc_type = $2 AND extracted_data ->> 'visit_id' = $3
      ORDER BY created_at, id`,
    [bill.patient_id, DOC_TYPE, bill.visit_id],
  );
  if (!reports.length) return NOTHING;
  const lines = reports.flatMap((report) => report.extracted_data?.items || []);
  const found = await matchLines(db, bill, lines);
  return {
    shown: true,
    reports: reports.map((report) => ({
      id: report.id,
      file_name: report.file_name,
      mime_type: report.mime_type,
      scanned_at: report.created_at,
      bill_no: report.extracted_data?.bill_no ?? null,
      warning: report.extracted_data?.warning ?? null,
    })),
    lines: await suggestedLines(db, bill, found.due, ctx),
    not_matched: found.notMatched,
  };
}

export async function readScannedReport(documentId, db = pool) {
  const id = Number(documentId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Choose a valid report");
  const { rows } = await db.query(
    `SELECT storage_path, mime_type, file_name FROM documents WHERE id = $1 AND doc_type = $2`,
    [id, DOC_TYPE],
  );
  if (!rows.length || !rows[0].storage_path) throw httpError(404, "That report no longer exists");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("File storage is not set up, so the report can't be opened");
  }
  const resp = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${rows[0].storage_path}`,
    { headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } },
  );
  if (!resp.ok) throw httpError(404, "The stored report couldn't be read — upload it again");
  return {
    buffer: Buffer.from(await resp.arrayBuffer()),
    mimeType: rows[0].mime_type || "application/pdf",
    fileName: rows[0].file_name || "billing-report",
  };
}

export async function deleteScannedReport(documentId, ctx, db = pool) {
  const id = Number(documentId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Choose a valid report");
  const removed = await inTransaction(async (client) => {
    const { rows } = await client.query(
      `DELETE FROM documents WHERE id = $1 AND doc_type = $2
       RETURNING id, patient_id, file_name, storage_path, extracted_data`,
      [id, DOC_TYPE],
    );
    if (!rows.length) throw httpError(404, "That report no longer exists");
    const [report] = rows;
    await writeAudit(client, {
      entity: "documents",
      entityId: String(report.id),
      action: "delete",
      before: {
        doc_type: DOC_TYPE,
        patient_id: report.patient_id,
        file_name: report.file_name,
        visit_id: report.extracted_data?.visit_id ?? null,
        bill_no: report.extracted_data?.bill_no ?? null,
        items: report.extracted_data?.items ?? [],
      },
      after: { deleted: true },
      ...auditFields(ctx),
    });
    return report;
  }, db);
  if (removed.storage_path && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${removed.storage_path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    }).catch(() => {});
  }
  return { deleted: true, id: removed.id };
}
