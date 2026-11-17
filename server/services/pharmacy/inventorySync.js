import { rebuildInventory } from "./stockInventory.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export async function stockSource(client) {
  const { rows } = await client.query(`SELECT stock_source FROM pharmacy_settings WHERE id`);
  return rows[0]?.stock_source ?? "darpan";
}

const SCRIBE_STOCK = `
  scribe_stock AS (
    SELECT m.medicine_key,
           MAX(m.generic_name) AS generic_name,
           COALESCE(SUM(s.qty_units) FILTER (WHERE b.expiry_date > $1::date), 0)::int AS stock_qty,
           (ARRAY_AGG(ROUND(b.sale_rate / b.pack_size, 2) ORDER BY b.expiry_date, b.id)
              FILTER (WHERE s.qty_units > 0 AND b.expiry_date > $1::date))[1] AS price_per_unit
      FROM pharmacy_medicines m
      JOIN pharmacy_batches b ON b.medicine_id = m.id
      JOIN pharmacy_stock s ON s.batch_id = b.id
      JOIN pharmacy_locations l ON l.id = s.location_id AND l.kind = 'main'
     WHERE ($2::text[] IS NULL OR m.medicine_key = ANY($2::text[]))
     GROUP BY m.medicine_key
  )`;

async function writeScribeStock(client, keys) {
  const params = [today(), keys];
  const updated = await client.query(
    `WITH ${SCRIBE_STOCK}
     UPDATE pharmacy_inventory p
        SET stock_qty = s.stock_qty,
            price_per_unit = COALESCE(s.price_per_unit, p.price_per_unit),
            generic_name = COALESCE(s.generic_name, p.generic_name),
            source = 'scribe',
            updated_at = NOW()
       FROM scribe_stock s
      WHERE UPPER(p.medicine_name) = s.medicine_key`,
    params,
  );
  const inserted = await client.query(
    `WITH ${SCRIBE_STOCK}
     INSERT INTO pharmacy_inventory (medicine_name, generic_name, stock_qty, price_per_unit, source, updated_at)
     SELECT s.medicine_key, s.generic_name, s.stock_qty, s.price_per_unit, 'scribe', NOW()
       FROM scribe_stock s
      WHERE NOT EXISTS (
        SELECT 1 FROM pharmacy_inventory p WHERE UPPER(p.medicine_name) = s.medicine_key
      )`,
    params,
  );
  return { updated: updated.rowCount, inserted: inserted.rowCount };
}

export async function syncInventoryForMedicines(client, medicineIds) {
  if (!medicineIds.length || (await stockSource(client)) !== "scribe") return null;
  const { rows } = await client.query(
    `SELECT DISTINCT medicine_key FROM pharmacy_medicines WHERE id = ANY($1::int[])`,
    [medicineIds],
  );
  return writeScribeStock(
    client,
    rows.map((r) => r.medicine_key),
  );
}

export async function rebuildInventoryFromScribe(client) {
  const cleared = await client.query(
    `UPDATE pharmacy_inventory SET stock_qty = 0, source = 'scribe', updated_at = NOW()
      WHERE source IS DISTINCT FROM 'scribe' OR stock_qty <> 0`,
  );
  const written = await writeScribeStock(client, null);
  return { cleared: cleared.rowCount, ...written };
}

export async function rebuildInventoryFor(client, source) {
  if (source === "scribe") return rebuildInventoryFromScribe(client);
  await client.query(
    `UPDATE pharmacy_inventory SET stock_qty = 0, updated_at = NOW() WHERE source = 'scribe'`,
  );
  return rebuildInventory(client);
}
