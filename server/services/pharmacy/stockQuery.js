import pool from "../../config/db.js";

export const STOCK_FILTERS = ["all", "in_stock", "out_of_stock", "not_linked"];

const FILTER_SQL = {
  all: "TRUE",
  in_stock: "i.qty > 0",
  out_of_stock: "i.qty <= 0",
  not_linked: `NOT EXISTS (SELECT 1 FROM pharmacy_stock_links l
                            WHERE l.item_key = i.item_key AND l.status <> 'identity')`,
};

const toNumber = (v) => (v === null || v === undefined ? null : Number(v));

export async function listStock(
  { q = null, filter = "all", limit = 50, offset = 0, withRates = false } = {},
  db = pool,
) {
  const search = q && q.trim().length >= 2 ? q.trim() : null;
  const where = FILTER_SQL[filter] || FILTER_SQL.all;
  const { rows } = await db.query(
    `SELECT i.item_key, i.item_name, i.qty, i.company, i.generic_name, i.category, i.item_type,
            i.unit_sale_price, i.sale_total, i.purchase_total, i.landing_total, i.in_latest,
            i.updated_at,
            COALESCE((SELECT json_agg(json_build_object('medicineKey', l.medicine_key, 'status', l.status)
                                      ORDER BY l.medicine_key)
                        FROM pharmacy_stock_links l WHERE l.item_key = i.item_key), '[]') AS links,
            COUNT(*) OVER () AS total
       FROM pharmacy_stock_items i
      WHERE ${where}
        AND ($1::text IS NULL
             OR i.item_name ILIKE '%' || $1 || '%'
             OR i.company ILIKE '%' || $1 || '%'
             OR i.generic_name ILIKE '%' || $1 || '%')
      ORDER BY (i.qty > 0) DESC, i.item_name
      LIMIT $2 OFFSET $3`,
    [search, limit, offset],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    items: rows.map((r) => ({
      itemKey: r.item_key,
      itemName: r.item_name,
      qty: toNumber(r.qty),
      company: r.company,
      genericName: r.generic_name,
      category: r.category,
      itemType: r.item_type,
      unitSalePrice: toNumber(r.unit_sale_price),
      saleTotal: toNumber(r.sale_total),
      inLatest: r.in_latest,
      updatedAt: r.updated_at,
      links: r.links,
      ...(withRates
        ? {
            purchaseTotal: toNumber(r.purchase_total),
            landingTotal: toNumber(r.landing_total),
            margin:
              r.sale_total !== null && r.purchase_total !== null
                ? Math.round((Number(r.sale_total) - Number(r.purchase_total)) * 100) / 100
                : null,
          }
        : {}),
    })),
  };
}

export async function stockSummary({ withRates = false } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE qty > 0)::int AS in_stock,
            COUNT(*) FILTER (WHERE qty <= 0)::int AS out_of_stock,
            COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM pharmacy_stock_links l
                                                WHERE l.item_key = i.item_key
                                                  AND l.status <> 'identity'))::int AS not_linked,
            COALESCE(SUM(GREATEST(qty, 0)), 0) AS total_units,
            COALESCE(SUM(sale_total) FILTER (WHERE qty > 0), 0) AS sale_value,
            COALESCE(SUM(purchase_total) FILTER (WHERE qty > 0), 0) AS purchase_value
       FROM pharmacy_stock_items i`,
  );
  const { rows: last } = await db.query(
    `SELECT u.id, u.file_name, u.report_generated_at, u.committed_at,
            (SELECT COALESCE(d.short_name, d.name) FROM doctors d WHERE d.id = u.committed_by) AS committed_by
       FROM pharmacy_stock_uploads u
      WHERE u.status = 'committed'
      ORDER BY u.committed_at DESC LIMIT 1`,
  );
  const s = rows[0];
  return {
    inStock: s.in_stock,
    outOfStock: s.out_of_stock,
    notLinked: s.not_linked,
    totalUnits: toNumber(s.total_units),
    saleValue: toNumber(s.sale_value),
    ...(withRates
      ? {
          purchaseValue: toNumber(s.purchase_value),
          margin: Math.round((Number(s.sale_value) - Number(s.purchase_value)) * 100) / 100,
        }
      : {}),
    lastUpload: last[0]
      ? {
          id: last[0].id,
          fileName: last[0].file_name,
          reportGeneratedAt: last[0].report_generated_at,
          committedAt: last[0].committed_at,
          committedBy: last[0].committed_by,
        }
      : null,
  };
}
