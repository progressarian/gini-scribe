import { FLAT } from "../giniflow/labCatalog.js";

const LINKED = String.raw`\y(with|plus|and)\y|\+`;

const BRACKET_KEYS = (x) => String.raw`CASE
    WHEN ${x} ~* '${LINKED}' THEN '{}'::text[]
    WHEN ${x} ~ '\(' AND COALESCE(substring(${x} from '\)([^)]*)$'), ${x}) !~ '[a-zA-Z0-9]'
      THEN ARRAY(SELECT ${FLAT("b[1]")} FROM regexp_matches(${x}, '\(([^)]+)\)', 'g') AS b)
    WHEN ${x} ~ '\S\s+-\s+[^-()]*[a-zA-Z0-9][^-()]*$'
      THEN ARRAY[${FLAT(String.raw`substring(${x} from '\s-\s+([^-()]+)$')`)}]
    ELSE '{}'::text[] END`;

export const WORD_KEY = (x) => String.raw`(
  SELECT string_agg(ws.w, ' ' ORDER BY ws.w)
    FROM (SELECT CASE WHEN p = 'vitamin' THEN 'vit' ELSE p END AS w
            FROM regexp_split_to_table(lower(regexp_replace(${x}, '\([^)]*\)', ' ', 'g')),
                                       '[^a-z0-9]+') AS p
           WHERE p <> '') ws)`;

export const TEST_MATCHES_SQL = (namesExpr) => `
  WITH tm_want AS MATERIALIZED (
    SELECT n.name, ${FLAT("n.name")} AS flat, ${BRACKET_KEYS("n.name")} AS brackets,
           ${WORD_KEY("n.name")} AS words
      FROM (SELECT DISTINCT unnest(${namesExpr}) AS name) n
     WHERE n.name IS NOT NULL
  ),
  tm_cat AS MATERIALIZED (
    SELECT c.id, c.test_name, c.is_active, ${FLAT("c.test_name")} AS flat,
           ${BRACKET_KEYS("c.test_name")} AS brackets, ${WORD_KEY("c.test_name")} AS words
      FROM giniflow_test_catalog c
  ),
  tm_reports AS MATERIALIZED (
    SELECT r.id, ${FLAT("k.name")} AS key
      FROM lab_report_catalog r
      CROSS JOIN LATERAL unnest(array_prepend(r.name, COALESCE(r.aliases, '{}'))) AS k(name)
     WHERE COALESCE(r.is_active, TRUE)
  ),
  tm_hits AS (
    SELECT w.name, i.test_catalog_id AS id, 0 AS tier FROM tm_want w
      JOIN service_item_aliases a ON a.flat_name = w.flat
      JOIN service_items i ON i.id = a.service_item_id AND i.is_active AND i.kind = 'test'
    UNION ALL
    SELECT w.name, c.id, 1 FROM tm_want w JOIN tm_cat c ON c.test_name = w.name
    UNION ALL
    SELECT w.name, c.id, 2 FROM tm_want w JOIN tm_cat c ON c.is_active AND c.flat = w.flat
    UNION ALL
    SELECT w.name, c.id, 3 FROM tm_want w
      JOIN tm_cat c ON c.is_active
       AND (c.flat = ANY(w.brackets) OR w.flat = ANY(c.brackets) OR c.words = w.words)
    UNION ALL
    SELECT w.name, c.id, 3 FROM tm_want w
      JOIN tm_reports a ON a.key = w.flat
      JOIN tm_reports b ON b.id = a.id
      JOIN tm_cat c ON c.is_active AND c.flat = b.key
  ),
  tm_ranked AS (
    SELECT name, id, tier, min(tier) OVER (PARTITION BY name) AS top FROM tm_hits
  )
  SELECT w.name AS test_name,
         (SELECT CASE WHEN count(DISTINCT r.id) = 1 THEN min(r.id::text)::uuid END
            FROM tm_ranked r WHERE r.name = w.name AND r.tier = r.top) AS catalog_id
    FROM tm_want w`;

export async function catalogTestsFor(db, names) {
  const wanted = [...new Set(names.filter((name) => typeof name === "string" && name))];
  if (!wanted.length) return new Map();
  const { rows } = await db.query(TEST_MATCHES_SQL("$1::text[]"), [wanted]);
  return new Map(rows.map((row) => [row.test_name, row.catalog_id]));
}

export async function outsourcedTestNames(db, names) {
  const wanted = [...new Set(names.filter((name) => typeof name === "string" && name))];
  if (!wanted.length) return new Set();
  const { rows } = await db.query(
    `SELECT DISTINCT m.test_name
       FROM (${TEST_MATCHES_SQL("$1::text[]")}) m
       JOIN service_items i ON i.test_catalog_id = m.catalog_id
      WHERE i.is_active AND i.is_outsourced`,
    [wanted],
  );
  return new Set(rows.map((row) => row.test_name));
}
