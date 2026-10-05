import pool from "../../config/db.js";
import { medicineKey, suggestMatches } from "./stockMatch.js";
import { rebuildInventory } from "./stockInventory.js";

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function prescribedNames(itemName, db) {
  const first = String(itemName)
    .toUpperCase()
    .replace(/^(TAB|CAP|INJ|SYP)\.?\s+/, "")
    .split(/[^A-Z0-9]+/)
    .find((t) => t.length >= 3);
  if (!first) return [];
  const { rows } = await db.query(
    `SELECT UPPER(COALESCE(NULLIF(BTRIM(pharmacy_match), ''), name)) AS name, COUNT(*) AS uses
       FROM medications
      WHERE name ILIKE '%' || $1 || '%'
      GROUP BY 1
      ORDER BY uses DESC
      LIMIT 40`,
    [first],
  );
  return rows.map((r) => r.name);
}

async function assertItem(itemKey, db) {
  const { rows } = await db.query(
    `SELECT item_key, item_name FROM pharmacy_stock_items WHERE item_key = $1`,
    [itemKey],
  );
  if (!rows.length) throw httpError(404, "Stock item not found");
  return rows[0];
}

export async function getItemLinks(itemKey, db = pool) {
  const item = await assertItem(itemKey, db);
  const { rows: links } = await db.query(
    `SELECT l.medicine_key, l.status, l.created_at,
            (SELECT COALESCE(d.short_name, d.name) FROM doctors d WHERE d.id = l.created_by) AS created_by
       FROM pharmacy_stock_links l
      WHERE l.item_key = $1
      ORDER BY l.medicine_key`,
    [itemKey],
  );
  const linked = new Set(links.map((l) => l.medicine_key));
  const suggestions = suggestMatches(
    item.item_name,
    await prescribedNames(item.item_name, db),
  ).filter((s) => !linked.has(s.medicineKey));
  return {
    itemKey: item.item_key,
    itemName: item.item_name,
    links: links.map((l) => ({
      medicineKey: l.medicine_key,
      status: l.status,
      createdAt: l.created_at,
      createdBy: l.created_by,
    })),
    suggestions,
  };
}

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

export async function addLink(itemKey, medicineName, actorId = null, db = pool) {
  await assertItem(itemKey, db);
  const key = medicineKey(medicineName);
  if (!key) throw httpError(400, "Enter the medicine name as it is written on prescriptions");
  await inTransaction(db, async (client) => {
    await client.query(
      `INSERT INTO pharmacy_stock_links (item_key, medicine_key, status, created_by)
       VALUES ($1, $2, 'confirmed', $3)
       ON CONFLICT (item_key, medicine_key)
       DO UPDATE SET status = 'confirmed', created_by = EXCLUDED.created_by, created_at = NOW()`,
      [itemKey, key, actorId],
    );
    await rebuildInventory(client);
  });
  return getItemLinks(itemKey, db);
}

export async function removeLink(itemKey, key, db = pool) {
  await assertItem(itemKey, db);
  await inTransaction(db, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM pharmacy_stock_links WHERE item_key = $1 AND medicine_key = $2`,
      [itemKey, key],
    );
    if (!rowCount) throw httpError(404, "That link does not exist");
    await rebuildInventory(client);
  });
  return getItemLinks(itemKey, db);
}
