import pool from "../../config/db.js";
import { parseStockReport } from "./stockParse.js";
import { autoLinkKeys, hasCatalogMatch } from "./stockMatch.js";
import { rebuildInventory } from "./stockInventory.js";

const httpError = (status, message) => Object.assign(new Error(message), { status });

const UPLOAD_COLUMNS = `u.id, u.file_name, u.store_name, u.generated_by, u.report_generated_at, u.status,
  u.uploaded_at, u.committed_at, u.item_count, u.total_units, u.purchase_total, u.landing_total,
  u.sale_total, u.warnings,
  (SELECT COALESCE(d.short_name, d.name) FROM doctors d WHERE d.id = u.uploaded_by) AS uploaded_by_name,
  (SELECT COALESCE(d.short_name, d.name) FROM doctors d WHERE d.id = u.committed_by) AS committed_by_name`;

const toNumber = (v) => (v === null || v === undefined ? null : Number(v));

const uploadOut = (u) => ({
  id: u.id,
  fileName: u.file_name,
  storeName: u.store_name,
  generatedBy: u.generated_by,
  reportGeneratedAt: u.report_generated_at,
  status: u.status,
  uploadedAt: u.uploaded_at,
  uploadedBy: u.uploaded_by_name,
  committedAt: u.committed_at,
  committedBy: u.committed_by_name,
  itemCount: u.item_count,
  totalUnits: toNumber(u.total_units),
  purchaseTotal: toNumber(u.purchase_total),
  landingTotal: toNumber(u.landing_total),
  saleTotal: toNumber(u.sale_total),
  warnings: u.warnings || [],
});

async function inTransaction(db, work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function createPreview(buffer, { fileName, actorId = null }, db = pool) {
  const { meta, lines, skipped } = await parseStockReport(buffer);
  const sum = (f) => Math.round(lines.reduce((n, l) => n + (l[f] ?? 0), 0) * 100) / 100;
  const warnings = [
    ...skipped.map((s) => ({ row: s.row, itemName: s.itemName, message: s.reason })),
    ...lines.flatMap((l) =>
      l.warnings.map((w) => ({ row: l.rowNo, itemName: l.itemName, message: w })),
    ),
  ];

  const id = await inTransaction(db, async (client) => {
    await client.query(
      `UPDATE pharmacy_stock_uploads SET status = 'discarded' WHERE status = 'preview'`,
    );
    await client.query(
      `DELETE FROM pharmacy_stock_upload_lines l USING pharmacy_stock_uploads u
        WHERE l.upload_id = u.id AND u.status = 'discarded'`,
    );
    const { rows } = await client.query(
      `INSERT INTO pharmacy_stock_uploads
         (file_name, store_name, generated_by, report_generated_at, uploaded_by, item_count,
          total_units, purchase_total, landing_total, sale_total, warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        fileName,
        meta.storeName,
        meta.generatedBy,
        meta.reportGeneratedAt,
        actorId,
        lines.length,
        sum("qty"),
        sum("purchaseTotal"),
        sum("landingTotal"),
        sum("saleTotal"),
        JSON.stringify(warnings),
      ],
    );
    const uploadId = rows[0].id;
    const col = (f) => lines.map((l) => l[f]);
    await client.query(
      `INSERT INTO pharmacy_stock_upload_lines
         (upload_id, row_no, item_key, item_name, qty, company, generic_name, category, item_type,
          purchase_total, landing_total, sale_total, warnings)
       SELECT $1, t.row_no, t.item_key, t.item_name, t.qty, t.company, t.generic_name, t.category,
              t.item_type, t.purchase_total, t.landing_total, t.sale_total,
              COALESCE(ARRAY(SELECT jsonb_array_elements_text(t.warnings)), '{}')
         FROM unnest($2::int[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::text[],
                     $8::text[], $9::text[], $10::numeric[], $11::numeric[], $12::numeric[],
                     $13::jsonb[])
           AS t(row_no, item_key, item_name, qty, company, generic_name, category, item_type,
                purchase_total, landing_total, sale_total, warnings)`,
      [
        uploadId,
        col("rowNo"),
        col("itemKey"),
        col("itemName"),
        col("qty"),
        col("company"),
        col("genericName"),
        col("category"),
        col("itemType"),
        col("purchaseTotal"),
        col("landingTotal"),
        col("saleTotal"),
        lines.map((l) => JSON.stringify(l.warnings)),
      ],
    );
    return uploadId;
  });

  return getUpload(id, db);
}

export async function getUpload(id, db = pool) {
  const { rows } = await db.query(
    `SELECT ${UPLOAD_COLUMNS} FROM pharmacy_stock_uploads u WHERE u.id = $1`,
    [id],
  );
  if (!rows.length) throw httpError(404, "Upload not found");
  const upload = uploadOut(rows[0]);
  if (upload.status !== "preview") return upload;

  const { rows: diff } = await db.query(
    `SELECT l.item_key, l.item_name, l.qty AS new_qty, i.qty AS old_qty,
            (i.item_key IS NULL) AS is_new
       FROM pharmacy_stock_upload_lines l
       LEFT JOIN pharmacy_stock_items i ON i.item_key = l.item_key
      WHERE l.upload_id = $1
      ORDER BY l.item_name`,
    [id],
  );
  const { rows: missing } = await db.query(
    `SELECT i.item_key, i.item_name, i.qty AS old_qty
       FROM pharmacy_stock_items i
      WHERE i.qty > 0
        AND NOT EXISTS (SELECT 1 FROM pharmacy_stock_upload_lines l
                         WHERE l.upload_id = $1 AND l.item_key = i.item_key)
      ORDER BY i.item_name`,
    [id],
  );
  const row = (r) => ({
    itemKey: r.item_key,
    itemName: r.item_name,
    oldQty: toNumber(r.old_qty),
    newQty: toNumber(r.new_qty ?? 0),
  });
  const added = diff.filter((r) => r.is_new).map(row);
  const changed = diff.filter((r) => !r.is_new && Number(r.old_qty) !== Number(r.new_qty)).map(row);
  return {
    ...upload,
    diff: {
      added: added.map((a) => ({ ...a, autoLinked: hasCatalogMatch(a.itemName) })),
      changed,
      unchangedCount: diff.length - added.length - changed.length,
      goingOut: missing.map(row),
    },
  };
}

export async function discardUpload(id, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE pharmacy_stock_uploads SET status = 'discarded' WHERE id = $1 AND status = 'preview'`,
    [id],
  );
  if (!rowCount) throw httpError(409, "This upload is no longer waiting to be applied");
  await db.query(`DELETE FROM pharmacy_stock_upload_lines WHERE upload_id = $1`, [id]);
  return { ok: true };
}

export async function commitUpload(id, actorId = null, db = pool) {
  const result = await inTransaction(db, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('pharmacy_stock_commit'))`);
    const { rows } = await client.query(
      `SELECT id, status, report_generated_at, uploaded_at FROM pharmacy_stock_uploads
        WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!rows.length) throw httpError(404, "Upload not found");
    const upload = rows[0];
    if (upload.status !== "preview")
      throw httpError(409, "This upload has already been applied or discarded");

    const { rows: newer } = await client.query(
      `SELECT report_generated_at FROM pharmacy_stock_uploads
        WHERE status = 'committed' AND report_generated_at IS NOT NULL
        ORDER BY report_generated_at DESC LIMIT 1`,
    );
    if (
      upload.report_generated_at &&
      newer.length &&
      new Date(newer[0].report_generated_at) > new Date(upload.report_generated_at)
    ) {
      throw httpError(
        409,
        "A newer stock report has already been applied. Export a fresh report from DARPAN and upload that.",
      );
    }

    const { rows: fresh } = await client.query(
      `SELECT l.item_key, l.item_name FROM pharmacy_stock_upload_lines l
        WHERE l.upload_id = $1
          AND NOT EXISTS (SELECT 1 FROM pharmacy_stock_items i WHERE i.item_key = l.item_key)`,
      [id],
    );

    await client.query(
      `INSERT INTO pharmacy_stock_items
         (item_key, item_name, qty, company, generic_name, category, item_type, purchase_total,
          landing_total, sale_total, unit_sale_price, in_latest, last_upload_id, updated_at)
       SELECT item_key, item_name, qty, company, generic_name, category, item_type, purchase_total,
              landing_total, sale_total,
              CASE WHEN qty > 0 AND sale_total IS NOT NULL THEN ROUND(sale_total / qty, 2) END,
              TRUE, upload_id, NOW()
         FROM pharmacy_stock_upload_lines WHERE upload_id = $1
       ON CONFLICT (item_key) DO UPDATE SET
         item_name = EXCLUDED.item_name, qty = EXCLUDED.qty, company = EXCLUDED.company,
         generic_name = EXCLUDED.generic_name, category = EXCLUDED.category,
         item_type = EXCLUDED.item_type, purchase_total = EXCLUDED.purchase_total,
         landing_total = EXCLUDED.landing_total, sale_total = EXCLUDED.sale_total,
         unit_sale_price = COALESCE(EXCLUDED.unit_sale_price, pharmacy_stock_items.unit_sale_price),
         in_latest = TRUE, last_upload_id = EXCLUDED.last_upload_id, updated_at = NOW()`,
      [id],
    );

    const out = await client.query(
      `UPDATE pharmacy_stock_items i
          SET qty = 0, in_latest = FALSE, updated_at = NOW()
        WHERE NOT EXISTS (SELECT 1 FROM pharmacy_stock_upload_lines l
                           WHERE l.upload_id = $1 AND l.item_key = i.item_key)
          AND (i.qty <> 0 OR i.in_latest)`,
      [id],
    );

    const links = fresh.flatMap((f) =>
      autoLinkKeys(f.item_name).map((l) => ({ itemKey: f.item_key, ...l })),
    );
    if (links.length) {
      await client.query(
        `INSERT INTO pharmacy_stock_links (item_key, medicine_key, status)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
         ON CONFLICT DO NOTHING`,
        [links.map((l) => l.itemKey), links.map((l) => l.key), links.map((l) => l.status)],
      );
    }

    const inventory = await rebuildInventory(client);

    await client.query(
      `UPDATE pharmacy_stock_uploads
          SET status = 'committed', committed_by = $2, committed_at = NOW()
        WHERE id = $1`,
      [id, actorId],
    );

    return { newItems: fresh.length, markedOut: out.rowCount, inventory };
  });
  return { ...(await getUpload(id, db)), applied: result };
}

export async function listUploads({ limit = 20, offset = 0 } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT ${UPLOAD_COLUMNS}, COUNT(*) OVER () AS total
       FROM pharmacy_stock_uploads u
      WHERE u.status <> 'discarded'
      ORDER BY u.uploaded_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return { total: Number(rows[0]?.total ?? 0), uploads: rows.map(uploadOut) };
}
