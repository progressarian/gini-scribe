import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { mainLocationId, postMovements } from "./stockLedger.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export async function expiryList(
  { location_id, bucket = "all", q, limit = 100, offset = 0, withCost = false } = {},
  db = pool,
) {
  const { rows: settings } = await db.query(
    `SELECT expiry_alert_days FROM pharmacy_settings WHERE id`,
  );
  const alertDays = settings[0]?.expiry_alert_days ?? 90;
  const params = [today(), alertDays, limit, offset];
  const where = ["s.qty_units > 0", "b.expiry_date <= $1::date + $2::int"];
  if (location_id) {
    params.push(location_id);
    where.push(`s.location_id = $${params.length}`);
  }
  const BUCKET = {
    expired: "b.expiry_date <= $1::date",
    30: "b.expiry_date > $1::date AND b.expiry_date <= $1::date + 30",
    60: "b.expiry_date > $1::date + 30 AND b.expiry_date <= $1::date + 60",
    90: "b.expiry_date > $1::date + 60",
  };
  if (BUCKET[bucket]) where.push(BUCKET[bucket]);
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const $ = `$${params.length}`;
    where.push(
      `(lower(m.name) LIKE ${$} OR lower(b.batch_no) LIKE ${$} OR lower(COALESCE(v.name, '')) LIKE ${$})`,
    );
  }
  const { rows } = await db.query(
    `SELECT s.location_id, l.name AS location_name, l.kind AS location_kind,
            b.id AS batch_id, b.batch_no, b.expiry_date, b.rack_no, b.pack_size, b.mrp,
            b.purchase_rate, (b.expiry_date - $1::date) AS days_left,
            m.id AS medicine_id, m.name AS medicine_name, m.pack_label, m.unit_label,
            s.qty_units, ROUND(s.qty_units * b.purchase_rate / b.pack_size, 2) AS cost_value,
            v.id AS vendor_id, v.name AS vendor_name, v.phone AS vendor_phone,
            v.contact_person AS vendor_contact,
            count(*) OVER()::int AS total,
            SUM(ROUND(s.qty_units * b.purchase_rate / b.pack_size, 2)) OVER() AS total_value
       FROM pharmacy_stock s
       JOIN pharmacy_batches b ON b.id = s.batch_id
       JOIN pharmacy_medicines m ON m.id = b.medicine_id
       JOIN pharmacy_locations l ON l.id = s.location_id
       LEFT JOIN pharmacy_vendors v ON v.id = b.vendor_id
      WHERE ${where.join(" AND ")}
      ORDER BY b.expiry_date, m.name, b.batch_no
      LIMIT $3 OFFSET $4`,
    params,
  );
  return {
    expiry_alert_days: alertDays,
    total: rows[0]?.total ?? 0,
    total_value: withCost ? (rows[0]?.total_value ?? "0.00") : null,
    rows: rows.map(({ total, total_value, purchase_rate, cost_value, ...r }) =>
      withCost ? { ...r, purchase_rate, cost_value } : r,
    ),
  };
}

const HEADER = `r.id, r.return_no, r.vendor_id, v.name AS vendor_name, r.location_id,
  l.name AS location_name, r.reason, r.vendor_ref, r.notes, r.total_value, r.created_at,
  (SELECT name FROM doctors d WHERE d.id = r.created_by) AS created_by_name`;

const FROM = `FROM pharmacy_vendor_returns r
  JOIN pharmacy_vendors v ON v.id = r.vendor_id
  JOIN pharmacy_locations l ON l.id = r.location_id`;

export async function listVendorReturns({ vendor_id, limit = 25, offset = 0 } = {}, db = pool) {
  const params = [limit, offset];
  let where = "TRUE";
  if (vendor_id) {
    params.push(vendor_id);
    where = "r.vendor_id = $3";
  }
  const { rows } = await db.query(
    `SELECT ${HEADER},
            (SELECT count(*)::int FROM pharmacy_vendor_return_lines rl WHERE rl.return_id = r.id) AS line_count,
            count(*) OVER()::int AS total
       ${FROM}
      WHERE ${where}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

export async function getVendorReturn(id, db = pool) {
  const { rows } = await db.query(`SELECT ${HEADER} ${FROM} WHERE r.id = $1`, [id]);
  if (!rows.length) throw httpError(404, "Vendor return not found");
  const { rows: lines } = await db.query(
    `SELECT rl.line_no, rl.batch_id, b.batch_no, b.expiry_date, rl.medicine_id,
            m.name AS medicine_name, m.pack_size, m.pack_label, m.unit_label, rl.qty_units,
            rl.unit_cost, rl.value
       FROM pharmacy_vendor_return_lines rl
       JOIN pharmacy_batches b ON b.id = rl.batch_id
       JOIN pharmacy_medicines m ON m.id = rl.medicine_id
      WHERE rl.return_id = $1
      ORDER BY rl.line_no`,
    [id],
  );
  return { ...rows[0], lines };
}

export async function createVendorReturn(input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const { rows: vendors } = await client.query(
      `SELECT id, name, is_active FROM pharmacy_vendors WHERE id = $1`,
      [input.vendor_id],
    );
    if (!vendors.length) throw httpError(400, "Choose the vendor from the list");
    if (!vendors[0].is_active) throw httpError(409, `${vendors[0].name} is deactivated`);
    const location = await mainLocationId(client);
    const ids = input.lines.map((l) => l.batch_id);
    if (new Set(ids).size !== ids.length) {
      throw httpError(400, "The same batch is on two lines. Put the whole quantity on one line");
    }
    const { rows: batches } = await client.query(
      `SELECT b.id, b.medicine_id, b.pack_size, b.purchase_rate FROM pharmacy_batches b
        WHERE b.id = ANY($1::int[])`,
      [ids],
    );
    const byId = new Map(batches.map((b) => [b.id, b]));
    const lines = input.lines.map((l, i) => {
      const batch = byId.get(l.batch_id);
      if (!batch) throw httpError(400, "One of the batches no longer exists");
      const unitCost = Number(batch.purchase_rate) / batch.pack_size;
      return {
        line_no: i + 1,
        batch_id: batch.id,
        medicine_id: batch.medicine_id,
        qty_units: l.qty_units,
        unit_cost: unitCost.toFixed(4),
        value: (Math.round(unitCost * l.qty_units * 100) / 100).toFixed(2),
      };
    });
    const total = lines.reduce((sum, l) => sum + Math.round(Number(l.value) * 100), 0) / 100;
    const { rows } = await client.query(
      `INSERT INTO pharmacy_vendor_returns
         (vendor_id, location_id, reason, vendor_ref, notes, total_value, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, return_no`,
      [
        vendors[0].id,
        location,
        input.reason,
        input.vendor_ref ?? null,
        input.notes ?? null,
        total.toFixed(2),
        ctx.actorId ?? null,
      ],
    );
    const made = rows[0];
    await client.query(
      `INSERT INTO pharmacy_vendor_return_lines
         (return_id, line_no, medicine_id, batch_id, qty_units, unit_cost, value)
       SELECT $1, x.line_no, x.medicine_id, x.batch_id, x.qty_units, x.unit_cost, x.value
         FROM jsonb_to_recordset($2::jsonb) AS x(line_no int, medicine_id int, batch_id int,
              qty_units int, unit_cost numeric, value numeric)`,
      [made.id, JSON.stringify(lines)],
    );
    await postMovements(
      client,
      lines.map((l) => ({
        locationId: location,
        batchId: l.batch_id,
        delta: -l.qty_units,
        kind: "vendor_return",
        refType: "pharmacy_vendor_returns",
        refId: made.id,
        reason: input.reason,
      })),
      ctx,
    );
    await writeAudit(client, {
      entity: "pharmacy_vendor_returns",
      entityId: String(made.id),
      action: "create",
      after: {
        return_no: made.return_no,
        vendor: vendors[0].name,
        reason: input.reason,
        total_value: total.toFixed(2),
        lines: lines.map((l) => ({ batch_id: l.batch_id, qty_units: l.qty_units })),
      },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return getVendorReturn(made.id, client);
  }, db);
}
