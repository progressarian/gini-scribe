const STOCK_BY_KEY = `stock_by_key AS (
  SELECT l.medicine_key,
         ROUND(SUM(GREATEST(i.qty, 0)))::int AS stock_qty,
         MAX(i.unit_sale_price) AS price_per_unit,
         MAX(i.generic_name) AS generic_name
    FROM pharmacy_stock_links l
    JOIN pharmacy_stock_items i ON i.item_key = l.item_key
   GROUP BY l.medicine_key
)`;

export async function rebuildInventory(client) {
  const updated = await client.query(
    `WITH ${STOCK_BY_KEY}
     UPDATE pharmacy_inventory p
        SET stock_qty = s.stock_qty,
            price_per_unit = COALESCE(s.price_per_unit, p.price_per_unit),
            generic_name = COALESCE(s.generic_name, p.generic_name),
            source = 'darpan',
            updated_at = NOW()
       FROM stock_by_key s
      WHERE UPPER(p.medicine_name) = s.medicine_key`,
  );

  const inserted = await client.query(
    `WITH ${STOCK_BY_KEY}
     INSERT INTO pharmacy_inventory (medicine_name, generic_name, stock_qty, price_per_unit, source, updated_at)
     SELECT s.medicine_key, s.generic_name, s.stock_qty, s.price_per_unit, 'darpan', NOW()
       FROM stock_by_key s
      WHERE NOT EXISTS (
        SELECT 1 FROM pharmacy_inventory p WHERE UPPER(p.medicine_name) = s.medicine_key
      )`,
  );

  const removed = await client.query(
    `WITH ${STOCK_BY_KEY}
     DELETE FROM pharmacy_inventory p
      WHERE p.source = 'darpan'
        AND NOT EXISTS (SELECT 1 FROM stock_by_key s WHERE s.medicine_key = UPPER(p.medicine_name))`,
  );

  return { updated: updated.rowCount, inserted: inserted.rowCount, removed: removed.rowCount };
}
