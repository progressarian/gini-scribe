import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { mainLocationId, postMovements } from "./stockLedger.js";
import { ADJUSTMENT_REASON_LABEL } from "../../../shared/pharmacyVocab.js";

const ENTITY = "pharmacy_stock_adjustments";
const REDUCING = ["damaged", "expired", "lost"];

export async function adjustStock(
  { location_id, batch_id, expected_units, new_units, reason, note },
  ctx = {},
  db = pool,
) {
  return inTransaction(async (client) => {
    const locationId = location_id ?? (await mainLocationId(client));
    const { rows } = await client.query(
      `SELECT b.id, b.batch_no, b.expiry_date, m.name, m.unit_label, l.name AS location,
              COALESCE(s.qty_units, 0) AS qty_units, (s.batch_id IS NOT NULL) AS stocked
         FROM pharmacy_batches b
         JOIN pharmacy_medicines m ON m.id = b.medicine_id
         JOIN pharmacy_locations l ON l.id = $2
         LEFT JOIN pharmacy_stock s ON s.batch_id = b.id AND s.location_id = l.id
        WHERE b.id = $1`,
      [batch_id, locationId],
    );
    if (!rows.length) throw httpError(404, "Batch or location not found");
    const batch = rows[0];
    if (!batch.stocked) {
      throw httpError(
        409,
        `${batch.location} has never held batch ${batch.batch_no} of ${batch.name}`,
      );
    }
    const { rows: locked } = await client.query(
      `SELECT qty_units FROM pharmacy_stock WHERE location_id = $1 AND batch_id = $2 FOR UPDATE`,
      [locationId, batch_id],
    );
    batch.qty_units = locked[0].qty_units;
    if (batch.qty_units !== expected_units) {
      throw httpError(
        409,
        `The stock of ${batch.name} (batch ${batch.batch_no}) changed while you were adjusting it: it is now ${batch.qty_units} ${batch.unit_label}. Check the count again`,
      );
    }
    const delta = new_units - batch.qty_units;
    if (delta === 0) throw httpError(400, "The new quantity is the same as the current stock");
    if (REDUCING.includes(reason) && delta > 0) {
      throw httpError(
        400,
        `${ADJUSTMENT_REASON_LABEL[reason]} can only reduce stock. Use "Physical count" to add stock found on the shelf`,
      );
    }

    const { rows: created } = await client.query(
      `INSERT INTO ${ENTITY}
         (location_id, batch_id, reason, note, before_units, after_units, delta_units, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [locationId, batch_id, reason, note, batch.qty_units, new_units, delta, ctx.actorId ?? null],
    );
    const adjustment = created[0];
    await postMovements(
      client,
      [
        {
          locationId,
          batchId: batch_id,
          delta,
          kind: reason === "expired" ? "expiry_writeoff" : "adjustment",
          refType: ENTITY,
          refId: adjustment.id,
          reason: `${ADJUSTMENT_REASON_LABEL[reason]}: ${note}`,
        },
      ],
      ctx,
    );
    await writeAudit(client, {
      entity: ENTITY,
      entityId: adjustment.id,
      action: "create",
      after: { ...adjustment, medicine: batch.name, batch_no: batch.batch_no },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return adjustment;
  }, db);
}

export async function listAdjustments({ location_id, limit = 25, offset = 0 } = {}, db = pool) {
  const locationId = location_id ?? (await mainLocationId(db));
  const { rows } = await db.query(
    `SELECT a.*, m.name AS medicine_name, m.unit_label, b.batch_no, b.expiry_date,
            d.name AS created_by_name, count(*) OVER()::int AS total
       FROM ${ENTITY} a
       JOIN pharmacy_batches b ON b.id = a.batch_id
       JOIN pharmacy_medicines m ON m.id = b.medicine_id
       LEFT JOIN doctors d ON d.id = a.created_by
      WHERE a.location_id = $1
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2 OFFSET $3`,
    [locationId, limit, offset],
  );
  return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}
