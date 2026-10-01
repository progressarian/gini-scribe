import pool from "../../config/db.js";
import { CASE_NOT_CANCELLED_SQL } from "../giniflow/testsHold.js";
import { FLAT } from "../giniflow/labCatalog.js";
import { writeAudit } from "./audit.js";
import { auditFields, cleanName } from "./common.js";
import { TEST_MATCHES_SQL } from "./testMatch.js";
import { looksLikeSameTest, normalizeTestName } from "./testNames.js";
import { httpError, inTransaction } from "./transaction.js";

const ENTITY = "service_item_aliases";
const ORDERED_DAYS = 30;
const ALIAS_COLUMNS = "id, service_item_id, name, flat_name, created_at, created_by";

async function lockItem(client, itemId) {
  const { rows } = await client.query(
    `SELECT i.id, i.code, i.name, i.kind, c.test_name
       FROM service_items i
       LEFT JOIN giniflow_test_catalog c ON c.id = i.test_catalog_id
      WHERE i.id = $1
        FOR UPDATE OF i`,
    [itemId],
  );
  if (!rows.length) throw httpError(404, "That item no longer exists");
  return rows[0];
}

const duplicateAlias = (error) =>
  error?.code === "23505" ? httpError(409, "That name is already billed as another item") : error;

async function refuseTaken(client, item, name) {
  const { rows } = await client.query(
    `SELECT ${FLAT("$1::text")} AS flat,
            ${FLAT("$2::text")} AS own_test,
            (SELECT json_build_object('item_id', i.id, 'code', i.code, 'name', i.name)
               FROM service_item_aliases a JOIN service_items i ON i.id = a.service_item_id
              WHERE a.flat_name = ${FLAT("$1::text")}) AS alias_of,
            (SELECT json_build_object('code', i.code, 'test_name', c.test_name)
               FROM service_items i JOIN giniflow_test_catalog c ON c.id = i.test_catalog_id
              WHERE i.id <> $3 AND i.is_active AND ${FLAT("c.test_name")} = ${FLAT("$1::text")}
              ORDER BY i.code LIMIT 1) AS test_of`,
    [name, item.test_name ?? "", item.id],
  );
  const found = rows[0];
  if (!found.flat) throw httpError(400, "The name needs at least one letter or digit");
  if (found.flat === found.own_test) {
    throw httpError(409, `${name} is already ${item.code}'s lab test name — no need to add it`);
  }
  if (found.alias_of?.item_id === item.id) {
    throw httpError(409, `${name} is already billed as ${item.code}`);
  }
  if (found.alias_of) {
    throw httpError(
      409,
      `${name} is already billed as ${found.alias_of.code} — ${found.alias_of.name}`,
    );
  }
  if (found.test_of) {
    throw httpError(409, `${name} is already the name of service ${found.test_of.code}`);
  }
  return found.flat;
}

export async function listAliases(itemId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${ALIAS_COLUMNS} FROM service_item_aliases
      WHERE service_item_id = $1 ORDER BY lower(name), id`,
    [itemId],
  );
  return rows;
}

export async function addAlias(itemId, input, ctx, db = pool) {
  const name = cleanName(input?.name);
  return inTransaction(async (client) => {
    const item = await lockItem(client, itemId);
    if (item.kind !== "test") {
      throw httpError(400, "Only test items can be billed under other names");
    }
    const flat = await refuseTaken(client, item, name);
    const { rows } = await client
      .query(
        `INSERT INTO service_item_aliases (service_item_id, name, flat_name, created_by)
         VALUES ($1, $2, $3, $4) RETURNING ${ALIAS_COLUMNS}`,
        [item.id, name, flat, ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw duplicateAlias(error);
      });
    await writeAudit(client, {
      entity: ENTITY,
      entityId: rows[0].id,
      action: "create",
      after: { ...rows[0], item_code: item.code },
      ...auditFields(ctx),
    });
    return rows[0];
  }, db);
}

export async function removeAlias(itemId, aliasId, ctx, db = pool) {
  return inTransaction(async (client) => {
    const item = await lockItem(client, itemId);
    const { rows } = await client.query(
      `DELETE FROM service_item_aliases WHERE id = $1 AND service_item_id = $2
       RETURNING ${ALIAS_COLUMNS}`,
      [aliasId, item.id],
    );
    if (!rows.length) throw httpError(404, "That name is no longer on this item");
    await writeAudit(client, {
      entity: ENTITY,
      entityId: rows[0].id,
      action: "delete",
      before: { ...rows[0], item_code: item.code },
      ...auditFields(ctx),
    });
    return { deleted: true, id: rows[0].id };
  }, db);
}

const GENERIC_WORDS = new Set([
  "test",
  "total",
  "serum",
  "blood",
  "urine",
  "level",
  "levels",
  "anti",
  "antibody",
  "antibodies",
]);

const wordsOf = (name) =>
  new Set(
    String(name ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word && !GENERIC_WORDS.has(word))
      .map((word) => (word === "vitamin" ? "vit" : word)),
  );

function overlap(a, b) {
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (!wa.size || !wb.size) return 0;
  const shared = [...wa].filter((word) => wb.has(word)).length;
  if (shared < 2 && (shared < wb.size || shared * 2 < wa.size)) return 0;
  const covered = shared / Math.min(wa.size, wb.size);
  return covered < 0.5 ? 0 : covered + shared / Math.max(wa.size, wb.size) / 10;
}

const sameName = (a, b) => normalizeTestName(a) === normalizeTestName(b) || looksLikeSameTest(a, b);

function bestGuess(orderedName, items) {
  let best = null;
  for (const item of items) {
    const names = [item.name, item.test_name, ...item.aliases];
    const score = names.some((name) => sameName(orderedName, name))
      ? 2
      : Math.max(...names.map((name) => overlap(orderedName, name)));
    if (score > 0 && (!best || score > best.score)) best = { score, item };
  }
  return best ? { item_id: best.item.id, code: best.item.code, name: best.item.name } : null;
}

export async function orderedNamesNotPriced(db = pool) {
  const { rows } = await db.query(
    `WITH named AS (
       SELECT t.test_name, (o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day
         FROM giniflow_lab_order_tests t
         JOIN giniflow_lab_orders o ON o.id = t.lab_order_id
        WHERE o.created_at >= ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - ${ORDERED_DAYS})
                              AT TIME ZONE 'Asia/Kolkata'
          AND t.status IS DISTINCT FROM 'cancelled'
       UNION ALL
       SELECT btrim(n.test_name), lc.case_date
         FROM lab_cases lc
         CROSS JOIN LATERAL unnest(COALESCE(lc.test_names, '{}'::text[])) AS n(test_name)
        WHERE lc.case_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - ${ORDERED_DAYS}
          AND ${CASE_NOT_CANCELLED_SQL("lc")}),
     recent AS (
       SELECT mode() WITHIN GROUP (ORDER BY test_name) AS test_name,
              count(*)::int AS times_ordered,
              max(day)::text AS last_ordered
         FROM named
        WHERE ${FLAT("test_name")} <> ''
        GROUP BY ${FLAT("test_name")})
     SELECT r.test_name, r.times_ordered, r.last_ordered
       FROM recent r
       LEFT JOIN (${TEST_MATCHES_SQL("ARRAY(SELECT test_name FROM recent)")}) m
         ON m.test_name = r.test_name
       LEFT JOIN service_items i ON i.test_catalog_id = m.catalog_id AND i.is_active
      WHERE i.id IS NULL
      ORDER BY r.times_ordered DESC, r.last_ordered DESC, r.test_name`,
  );
  if (!rows.length) return [];
  const { rows: items } = await db.query(
    `SELECT i.id, i.code, i.name, c.test_name,
            ARRAY(SELECT a.name FROM service_item_aliases a WHERE a.service_item_id = i.id)
              AS aliases
       FROM service_items i
       JOIN giniflow_test_catalog c ON c.id = i.test_catalog_id
      WHERE i.is_active AND i.kind = 'test'
      ORDER BY i.code`,
  );
  return rows.map((row) => ({ ...row, suggestion: bestGuess(row.test_name, items) }));
}
