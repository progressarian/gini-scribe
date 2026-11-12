import "../loadEnv.js";
import pool from "../config/db.js";
import { FLAT } from "../services/giniflow/labCatalog.js";
import { TEST_MATCHES_SQL } from "../services/billing/testMatch.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 100;
const SKIP = new Set(
  process.argv.flatMap((arg, at, all) => (arg === "--skip" && all[at + 1] ? [all[at + 1]] : [])),
);

const REPORT_NAMES = `
  SELECT r.id, r.name AS report_name, k.name
    FROM lab_report_catalog r
    CROSS JOIN LATERAL unnest(array_prepend(r.name, COALESCE(r.aliases, '{}'))) AS k(name)
   WHERE COALESCE(r.is_active, TRUE)`;

const MATCHES = `
  WITH report_names AS (${REPORT_NAMES}),
  billing_match AS (
    SELECT m.test_name AS name, m.catalog_id
      FROM (${TEST_MATCHES_SQL("(SELECT array_agg(name) FROM report_names)")}) m
     WHERE m.catalog_id IS NOT NULL
  ),
  hits AS (
    SELECT c.id AS catalog_id, rn.id AS report_id, rn.report_name
      FROM giniflow_test_catalog c
      JOIN report_names rn ON ${FLAT("rn.name")} = ${FLAT("c.test_name")}
    UNION
    SELECT b.catalog_id, rn.id, rn.report_name
      FROM billing_match b
      JOIN report_names rn ON rn.name = b.name
  )
  SELECT t.id, t.test_name, t.category, t.is_active,
         array_agg(DISTINCT h.report_id) FILTER (WHERE h.report_id IS NOT NULL) AS report_ids,
         array_agg(DISTINCT h.report_name) FILTER (WHERE h.report_id IS NOT NULL) AS report_names
    FROM giniflow_test_catalog t
    LEFT JOIN hits h ON h.catalog_id = t.id
   WHERE t.lab_report_id IS NULL AND NOT t.results_as_file
   GROUP BY t.id, t.test_name, t.category, t.is_active`;

const LINK = `
  WITH linked AS (
    UPDATE giniflow_test_catalog c
       SET lab_report_id = x.report_id, updated_at = NOW()
      FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, report_id bigint, report_name text)
     WHERE c.id = x.id AND c.lab_report_id IS NULL
    RETURNING c.id, x.report_id, x.report_name
  )
  INSERT INTO lab_catalog_audit (entity, entity_id, action, before, after)
  SELECT 'link', linked.id::text, 'backfill', jsonb_build_object('lab_report_id', NULL),
         jsonb_build_object('lab_report_id', linked.report_id, 'report', linked.report_name)
    FROM linked`;

const slowQueries = async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE state = 'active' AND backend_type = 'client backend' AND pid <> pg_backend_pid()
        AND now() - query_start > interval '30 seconds'`,
  );
  return rows[0].n;
};

const readCandidates = async (db) => {
  const { rows } = await db.query(`${MATCHES} ORDER BY t.test_name`);
  return {
    single: rows
      .filter((r) => r.report_ids?.length === 1 && !SKIP.has(r.test_name))
      .map((r) => ({
        id: r.id,
        test_name: r.test_name,
        report_id: Number(r.report_ids[0]),
        report_name: r.report_names[0],
      })),
    several: rows.filter((r) => r.report_ids?.length > 1),
    none: rows.filter((r) => !r.report_ids?.length),
  };
};

try {
  const slow = await slowQueries();
  if (slow) {
    console.error(`${slow} query(ies) have run over 30s — the database is busy, try later`);
    process.exit(1);
  }

  const { single, several, none } = await readCandidates(pool);
  console.log(`tests to link (exactly one report): ${single.length}`);
  console.table(single.map((s) => ({ test: s.test_name, report: s.report_name })));
  if (SKIP.size) console.log(`skipped on request: ${[...SKIP].join(", ")}`);
  console.log(`tests matching more than one report (left unlinked): ${several.length}`);
  if (several.length) {
    console.table(several.map((s) => ({ test: s.test_name, reports: s.report_names.join(" | ") })));
  }
  const noneActive = none.filter((n) => n.is_active);
  console.log(
    `tests with no report (left unlinked): ${none.length} (${noneActive.length} active — lab ${
      noneActive.filter((n) => n.category === "lab").length
    }, machine ${noneActive.filter((n) => n.category === "machine").length})`,
  );

  if (!APPLY) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(LINK, [JSON.stringify(single.slice(0, BATCH))]);
      console.log(`dry run: first batch would link ${res.rowCount} test(s); rolled back`);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    console.log("dry run — pass --apply to write");
  } else {
    let linked = 0;
    for (let at = 0; at < single.length; at += BATCH) {
      if (await slowQueries()) {
        console.error("database got busy — stopping; rerun later to continue");
        process.exitCode = 1;
        break;
      }
      const batch = single.slice(at, at + BATCH);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const res = await client.query(LINK, [JSON.stringify(batch)]);
        await client.query("COMMIT");
        linked += res.rowCount;
        console.log(`batch ${at / BATCH + 1}: linked ${res.rowCount} (total ${linked})`);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`batch ${at / BATCH + 1} failed: ${e.message}`);
        process.exitCode = 1;
        break;
      } finally {
        client.release();
      }
    }
    console.log(`done: ${linked} test(s) linked`);
  }
} finally {
  await pool.end();
}
