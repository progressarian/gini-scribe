import pool from "../../config/db.js";
import { httpError } from "../billing/transaction.js";
import { getPharmacySettings } from "./settings.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

async function locationFor(db, locationId) {
  const { rows } = await db.query(
    locationId
      ? `SELECT id, code, name, kind, is_active FROM pharmacy_locations WHERE id = $1`
      : `SELECT id, code, name, kind, is_active FROM pharmacy_locations WHERE kind = 'main'`,
    locationId ? [locationId] : [],
  );
  if (!rows.length) throw httpError(404, "Stock location not found");
  return rows[0];
}

export async function stockLocations(db = pool) {
  const { rows } = await db.query(
    `SELECT id, code, name, kind FROM pharmacy_locations
      WHERE is_active ORDER BY (kind = 'main') DESC, lower(name)`,
  );
  return rows;
}

const MEDICINE_STOCK = `
  WITH lvl AS (
    SELECT m.id AS medicine_id,
           CASE WHEN $2 = 'main' THEN m.min_stock_units ELSE ll.min_units END AS min_units,
           CASE WHEN $2 = 'main' THEN m.max_stock_units ELSE ll.max_units END AS max_units
      FROM pharmacy_medicines m
      LEFT JOIN pharmacy_location_levels ll ON ll.medicine_id = m.id AND ll.location_id = $1
  ),
  stk AS (
    SELECT b.medicine_id,
           SUM(s.qty_units)::int AS total_units,
           COALESCE(SUM(s.qty_units) FILTER (WHERE b.expiry_date > $3::date), 0)::int AS sellable_units,
           COALESCE(SUM(s.qty_units) FILTER (WHERE b.expiry_date <= $3::date), 0)::int AS expired_units,
           COALESCE(SUM(s.qty_units) FILTER (
             WHERE b.expiry_date > $3::date AND b.expiry_date <= $3::date + $4::int), 0)::int AS near_expiry_units,
           MIN(b.expiry_date) FILTER (WHERE s.qty_units > 0 AND b.expiry_date > $3::date) AS next_expiry,
           ROUND(SUM(s.qty_units * b.purchase_rate / b.pack_size), 2) AS cost_value,
           ROUND(SUM(s.qty_units * b.mrp / b.pack_size), 2) AS mrp_value
      FROM pharmacy_stock s
      JOIN pharmacy_batches b ON b.id = s.batch_id
     WHERE s.location_id = $1
     GROUP BY b.medicine_id
  ),
  rows AS (
    SELECT m.id AS medicine_id, m.code, m.name, m.generic_name, m.form, m.pack_size, m.pack_label,
           m.unit_label, m.default_rack, m.is_active, m.allow_loose_sale, m.schedule,
           COALESCE(stk.total_units, 0) AS total_units,
           COALESCE(stk.sellable_units, 0) AS sellable_units,
           COALESCE(stk.expired_units, 0) AS expired_units,
           COALESCE(stk.near_expiry_units, 0) AS near_expiry_units,
           stk.next_expiry, COALESCE(stk.cost_value, 0) AS cost_value,
           COALESCE(stk.mrp_value, 0) AS mrp_value,
           lvl.min_units, lvl.max_units,
           CASE
             WHEN COALESCE(stk.sellable_units, 0) = 0 THEN 'out'
             WHEN lvl.min_units IS NOT NULL AND stk.sellable_units < lvl.min_units THEN 'low'
             WHEN lvl.max_units IS NOT NULL AND stk.sellable_units > lvl.max_units THEN 'over'
             ELSE 'ok'
           END AS level
      FROM pharmacy_medicines m
      LEFT JOIN stk ON stk.medicine_id = m.id
      LEFT JOIN lvl ON lvl.medicine_id = m.id
     WHERE stk.medicine_id IS NOT NULL OR COALESCE(lvl.min_units, 0) > 0
  )`;

const FILTERS = {
  all: "TRUE",
  in_stock: "sellable_units > 0",
  out: "level = 'out'",
  low: "level = 'low'",
  over: "level = 'over'",
  near_expiry: "near_expiry_units > 0",
  expired: "expired_units > 0",
};

export async function listStock(
  { location_id, q, filter = "all", limit = 50, offset = 0, withCost = false } = {},
  db = pool,
) {
  const location = await locationFor(db, location_id);
  const settings = await getPharmacySettings(db);
  const params = [location.id, location.kind, today(), settings.expiry_alert_days];
  let search = "";
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    search = `AND (lower(name) LIKE $5 OR lower(code) LIKE $5 OR lower(coalesce(generic_name, '')) LIKE $5)`;
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `${MEDICINE_STOCK}
     SELECT *, count(*) OVER()::int AS total FROM rows
      WHERE ${FILTERS[filter]} ${search}
      ORDER BY (level = 'out') DESC, (level = 'low') DESC, lower(name)
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const ids = rows.map((r) => r.medicine_id);
  const batches = ids.length ? await batchesAt(db, location.id, ids, { withCost }) : [];
  return {
    location,
    expiry_alert_days: settings.expiry_alert_days,
    near_expiry_warn_days: settings.near_expiry_warn_days,
    total: rows[0]?.total ?? 0,
    rows: rows.map(({ total, cost_value, ...r }) => ({
      ...r,
      ...(withCost ? { cost_value } : {}),
      batches: batches.filter((b) => b.medicine_id === r.medicine_id),
    })),
  };
}

export async function batchesAt(
  db,
  locationId,
  medicineIds,
  { withCost = false, includeEmpty = false } = {},
) {
  const { rows } = await db.query(
    `SELECT b.id, b.medicine_id, b.batch_no, b.expiry_date, b.mfg_date, b.pack_size, b.mrp,
            b.sale_rate, b.gst_rate_pct, b.rack_no, s.qty_units,
            ${withCost ? "b.purchase_rate, v.name AS vendor_name," : ""}
            (b.expiry_date <= $3::date) AS expired
       FROM pharmacy_stock s
       JOIN pharmacy_batches b ON b.id = s.batch_id
       LEFT JOIN pharmacy_vendors v ON v.id = b.vendor_id
      WHERE s.location_id = $1 AND b.medicine_id = ANY($2::int[])
        ${includeEmpty ? "" : "AND s.qty_units > 0"}
      ORDER BY b.expiry_date, b.batch_no`,
    [locationId, medicineIds, today()],
  );
  return rows;
}

export async function medicineBatches({ medicine_id, location_id, withCost = false }, db = pool) {
  const location = await locationFor(db, location_id);
  const { rows: medicine } = await db.query(
    `SELECT id, code, name, pack_size, pack_label, unit_label, allow_loose_sale, schedule
       FROM pharmacy_medicines WHERE id = $1`,
    [medicine_id],
  );
  if (!medicine.length) throw httpError(404, "Medicine not found");
  const settings = await getPharmacySettings(db);
  return {
    location,
    medicine: medicine[0],
    near_expiry_warn_days: settings.near_expiry_warn_days,
    batches: await batchesAt(db, location.id, [medicine_id], { withCost }),
  };
}

export async function stockSummary({ location_id, withCost = false } = {}, db = pool) {
  const location = await locationFor(db, location_id);
  const settings = await getPharmacySettings(db);
  const { rows } = await db.query(
    `${MEDICINE_STOCK}
     SELECT count(*) FILTER (WHERE sellable_units > 0)::int AS in_stock,
            count(*) FILTER (WHERE level = 'out')::int AS out_of_stock,
            count(*) FILTER (WHERE level = 'low')::int AS below_min,
            count(*) FILTER (WHERE level = 'over')::int AS above_max,
            count(*) FILTER (WHERE near_expiry_units > 0)::int AS near_expiry,
            count(*) FILTER (WHERE expired_units > 0)::int AS expired,
            COALESCE(SUM(cost_value), 0) AS cost_value,
            COALESCE(SUM(mrp_value), 0) AS mrp_value
       FROM rows`,
    [location.id, location.kind, today(), settings.expiry_alert_days],
  );
  const { cost_value, ...summary } = rows[0];
  return {
    location,
    expiry_alert_days: settings.expiry_alert_days,
    ...summary,
    ...(withCost ? { cost_value } : {}),
  };
}

export async function batchMovements({ batch_id, location_id, limit = 50, offset = 0 }, db = pool) {
  const location = await locationFor(db, location_id);
  const { rows: batch } = await db.query(
    `SELECT b.id, b.batch_no, b.expiry_date, b.rack_no, m.name AS medicine_name, m.unit_label
       FROM pharmacy_batches b JOIN pharmacy_medicines m ON m.id = b.medicine_id
      WHERE b.id = $1`,
    [batch_id],
  );
  if (!batch.length) throw httpError(404, "Batch not found");
  const { rows } = await db.query(
    `SELECT mv.id, mv.kind, mv.delta_units, mv.balance_after, mv.ref_type, mv.ref_id, mv.reason,
            mv.at, d.name AS actor_name,
            CASE WHEN mv.ref_type = 'pharmacy_purchases'
                 THEN (SELECT receipt_no FROM pharmacy_purchases p WHERE p.id::text = mv.ref_id)
            END AS reference,
            count(*) OVER()::int AS total
       FROM pharmacy_stock_movements mv
       LEFT JOIN doctors d ON d.id = mv.actor_id
      WHERE mv.batch_id = $1 AND mv.location_id = $2
      ORDER BY mv.at DESC, mv.id DESC
      LIMIT $3 OFFSET $4`,
    [batch_id, location.id, limit, offset],
  );
  return {
    location,
    batch: batch[0],
    total: rows[0]?.total ?? 0,
    rows: rows.map(({ total, ...r }) => r),
  };
}
