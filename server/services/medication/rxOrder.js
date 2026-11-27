import pool from "../../config/db.js";
import { inTransaction, httpError } from "../billing/transaction.js";
import { DEFAULT_CATEGORY } from "../../config/medicationCategories.js";
import { getRxOrderRules, isGenericCategory } from "./rxOrderRules.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const matcherFor = (keywords) =>
  keywords.length
    ? new RegExp(`(^|[^a-z0-9])(${keywords.map(escapeRegex).join("|")})(?=$|[^a-z0-9])`, "i")
    : null;

const compiled = new WeakMap();

function compile(rules) {
  const hit = compiled.get(rules);
  if (hit) return hit;
  const categoryRank = new Map(rules.categories.map((c, i) => [c.id, i]));
  const classes = rules.classes.map((c) => ({ ...c, match: matcherFor(c.keywords) }));
  const classesOf = new Map(rules.categories.map((c) => [c.id, []]));
  for (const c of classes) classesOf.get(c.category)?.push(c);
  const detectOrder = [
    ...rules.categories.filter((c) => !isGenericCategory(c.id)),
    ...rules.categories.filter((c) => isGenericCategory(c.id)),
  ].map((c) => ({ id: c.id, match: matcherFor(c.keywords), classes: classesOf.get(c.id) }));
  const pins = new Map(rules.pins.map((p) => [p.medicine.toUpperCase(), p]));
  const result = { categoryRank, classesOf, detectOrder, pins };
  compiled.set(rules, result);
  return result;
}

const haystackOf = (item) =>
  [item.medicine_name, item.pharmacy_match, item.composition, item.drug_class]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

function categoryOf(item, haystack, c) {
  const stored = item.med_group && c.categoryRank.has(item.med_group) ? item.med_group : null;
  if (stored && !isGenericCategory(stored)) return stored;
  const detected = c.detectOrder.find(
    (cat) => cat.match?.test(haystack) || cat.classes.some((k) => k.match?.test(haystack)),
  );
  return detected?.id || stored || DEFAULT_CATEGORY;
}

export function rankOf(item, rules) {
  const c = compile(rules);
  const name = String(item.medicine_name || "").toUpperCase();
  const pin =
    c.pins.get(name) || (item.pharmacy_match && c.pins.get(item.pharmacy_match.toUpperCase()));
  const haystack = haystackOf(item);
  const category = pin?.category || categoryOf(item, haystack, c);
  const classes = c.classesOf.get(category) || [];
  const classIndex = classes.findIndex((k) => k.match?.test(haystack));
  return [
    item.change_type === "stopped" ? 1 : 0,
    c.categoryRank.get(category) ?? c.categoryRank.size,
    pin ? 0 : 1,
    pin ? pin.position : classIndex === -1 ? classes.length : classIndex,
    name,
  ];
}

const compareRanks = (a, b) => {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
};

export const sortByStandardOrder = (items, rules) =>
  items
    .map((item) => ({ item, rank: rankOf(item, rules) }))
    .sort((a, b) => compareRanks(a.rank, b.rank))
    .map((r) => r.item);

const renumber = (db, ids) =>
  db.query(
    `UPDATE giniflow_rx_items i
        SET sort_order = o.pos
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, pos)
      WHERE i.id = o.id AND i.sort_order IS DISTINCT FROM o.pos`,
    [ids],
  );

const itemsForOrdering = (db, visitId) =>
  db.query(
    `SELECT i.id, i.medicine_name, i.pharmacy_match, i.composition, i.drug_class,
            i.change_type, m.med_group
       FROM giniflow_rx_items i
       LEFT JOIN medications m ON m.id = i.source_medication_id
      WHERE i.visit_id = $1
      ORDER BY i.sort_order, i.created_at`,
    [visitId],
  );

export async function applyStandardOrder(db, visitId, { force = false } = {}) {
  if (!force) {
    const { rows } = await db.query(`SELECT rx_order_manual FROM giniflow_visits WHERE id = $1`, [
      visitId,
    ]);
    if (rows[0]?.rx_order_manual) return { applied: false };
  }
  const [rules, { rows }] = await Promise.all([getRxOrderRules(), itemsForOrdering(db, visitId)]);
  await renumber(
    db,
    sortByStandardOrder(rows, rules).map((r) => r.id),
  );
  return { applied: true };
}

export async function moveRxItem(itemId, direction, db = pool) {
  if (!["up", "down"].includes(direction)) throw httpError(400, "Choose up or down");
  return inTransaction(async (client) => {
    const { rows: found } = await client.query(
      `SELECT id, visit_id FROM giniflow_rx_items WHERE id = $1`,
      [itemId],
    );
    if (!found.length) throw httpError(404, "Row not found");
    const visitId = found[0].visit_id;
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visitId]);
    const { rows } = await client.query(
      `SELECT id FROM giniflow_rx_items WHERE visit_id = $1 ORDER BY sort_order, created_at`,
      [visitId],
    );
    const ids = rows.map((r) => r.id);
    const from = ids.indexOf(found[0].id);
    const to = direction === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= ids.length) return { visitId, moved: false };
    [ids[from], ids[to]] = [ids[to], ids[from]];
    await renumber(client, ids);
    await client.query(`UPDATE giniflow_visits SET rx_order_manual = TRUE WHERE id = $1`, [
      visitId,
    ]);
    return { visitId, moved: true };
  }, db);
}

export async function resetRxOrder(visitId, db = pool) {
  return inTransaction(async (client) => {
    await client.query(`UPDATE giniflow_visits SET rx_order_manual = FALSE WHERE id = $1`, [
      visitId,
    ]);
    return applyStandardOrder(client, visitId, { force: true });
  }, db);
}

export async function rxOrderManual(visitId, db = pool) {
  const { rows } = await db.query(`SELECT rx_order_manual FROM giniflow_visits WHERE id = $1`, [
    visitId,
  ]);
  return !!rows[0]?.rx_order_manual;
}
