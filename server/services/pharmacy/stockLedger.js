import { httpError } from "../billing/transaction.js";
import { syncInventoryForMedicines } from "./inventorySync.js";
import { checkStockLevels } from "./alerts.js";

const NOT_NEGATIVE = "pharmacy_stock_not_negative";

async function describe(client, locationId, batchId) {
  const { rows } = await client.query(
    `SELECT m.name, b.batch_no, l.name AS location, COALESCE(s.qty_units, 0) AS qty_units, m.unit_label
       FROM pharmacy_batches b
       JOIN pharmacy_medicines m ON m.id = b.medicine_id
       JOIN pharmacy_locations l ON l.id = $1
       LEFT JOIN pharmacy_stock s ON s.batch_id = b.id AND s.location_id = l.id
      WHERE b.id = $2`,
    [locationId, batchId],
  );
  return rows[0];
}

export async function postMovements(client, movements, ctx = {}) {
  if (typeof client?.release !== "function") {
    throw new Error("postMovements needs the transaction's client, not the pool");
  }
  const ordered = [...movements].sort(
    (a, b) => a.locationId - b.locationId || a.batchId - b.batchId,
  );
  const posted = [];
  for (const m of ordered) {
    if (!Number.isInteger(m.delta) || m.delta === 0) {
      throw new Error(`postMovements: delta must be a non-zero whole number (got ${m.delta})`);
    }
    await client.query("SAVEPOINT pharmacy_stock_move");
    let balance;
    try {
      const { rows } =
        m.delta > 0
          ? await client.query(
              `INSERT INTO pharmacy_stock (location_id, batch_id, qty_units, updated_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (location_id, batch_id)
               DO UPDATE SET qty_units = pharmacy_stock.qty_units + EXCLUDED.qty_units,
                             updated_at = NOW()
               RETURNING qty_units`,
              [m.locationId, m.batchId, m.delta],
            )
          : await client.query(
              `UPDATE pharmacy_stock SET qty_units = qty_units + $3, updated_at = NOW()
                WHERE location_id = $1 AND batch_id = $2
                RETURNING qty_units`,
              [m.locationId, m.batchId, m.delta],
            );
      if (!rows.length)
        throw Object.assign(new Error("no stock row"), { constraint: NOT_NEGATIVE });
      balance = rows[0].qty_units;
      await client.query("RELEASE SAVEPOINT pharmacy_stock_move");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT pharmacy_stock_move");
      if (error.constraint === NOT_NEGATIVE) {
        const d = await describe(client, m.locationId, m.batchId);
        throw httpError(
          409,
          `Not enough stock of ${d.name} (batch ${d.batch_no}) at ${d.location}: ` +
            `${d.qty_units} ${d.unit_label} available, ${-m.delta} needed`,
        );
      }
      throw error;
    }
    const { rows } = await client.query(
      `INSERT INTO pharmacy_stock_movements
         (location_id, batch_id, medicine_id, kind, delta_units, balance_after,
          ref_type, ref_id, reason, actor_id)
       SELECT $1, $2, b.medicine_id, $3, $4, $5, $6, $7, $8, $9
         FROM pharmacy_batches b WHERE b.id = $2
       RETURNING id, location_id, batch_id, medicine_id, kind, delta_units, balance_after`,
      [
        m.locationId,
        m.batchId,
        m.kind,
        m.delta,
        balance,
        m.refType ?? null,
        m.refId === undefined || m.refId === null ? null : String(m.refId),
        m.reason ?? null,
        ctx.actorId ?? null,
      ],
    );
    posted.push(rows[0]);
  }
  const main = await mainLocationId(client);
  const atMain = [
    ...new Set(posted.filter((p) => p.location_id === main).map((p) => p.medicine_id)),
  ];
  await syncInventoryForMedicines(client, atMain);
  await checkStockLevels(
    client,
    posted.map((p) => ({ locationId: p.location_id, medicineId: p.medicine_id })),
  );
  return posted;
}

export async function mainLocationId(db) {
  const { rows } = await db.query(`SELECT id FROM pharmacy_locations WHERE kind = 'main'`);
  if (!rows.length) throw new Error("The main pharmacy location is missing");
  return rows[0].id;
}
