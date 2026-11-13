import pool from "../../config/db.js";
import { formulaAsNames, formulaInputs } from "../../../shared/labFormula.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => Object.assign(new Error("Test not found"), { status: 404 });
const num = (v) => (v === null || v === undefined ? null : Number(v));

const FIELDS_SQL = `
WITH RECURSIVE tree AS (
  SELECT t.id, t.parent_test_id, t.name, t.unit, t.no_unit, t.input_type, t.formula, t.decimals,
         t.options, t.is_active, t.source, t.updated_at, rt.sequence::numeric AS ord, 0 AS depth,
         rt.is_required
    FROM lab_report_tests rt
    JOIN lab_test_catalog t ON t.id = rt.test_id
   WHERE rt.report_id = $1
  UNION ALL
  SELECT c.id, c.parent_test_id, c.name, c.unit, c.no_unit, c.input_type, c.formula, c.decimals,
         c.options, c.is_active, c.source, c.updated_at, tree.ord + COALESCE(c.sequence, 0) / 1000.0,
         tree.depth + 1, NULL
    FROM tree
    JOIN lab_test_catalog c ON c.parent_test_id = tree.id
   WHERE tree.depth < 4
)
SELECT DISTINCT ON (tree.id) tree.* FROM tree ORDER BY tree.id, tree.depth`;

async function catalogTest(db, catalogId) {
  if (!UUID.test(String(catalogId))) throw notFound();
  const { rows } = await db.query(
    `SELECT c.id, c.test_name, c.category, c.gloss, c.is_active, c.results_as_file,
            c.lab_report_id, c.updated_at, item.code AS service_item_code
       FROM giniflow_test_catalog c
       LEFT JOIN service_items item ON item.test_catalog_id = c.id AND item.is_active
      WHERE c.id = $1`,
    [catalogId],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function rangesFor(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, test_id, gender, min_age_days, max_age_days, min_value, max_value,
            min_critical, max_critical, text_range, is_pregnant
       FROM lab_test_ranges
      WHERE test_id = ANY($1::bigint[])
      ORDER BY test_id, is_pregnant, gender, min_age_days, max_age_days`,
    [ids],
  );
  const byField = new Map();
  for (const r of rows) {
    const key = String(r.test_id);
    if (!byField.has(key)) byField.set(key, []);
    byField.get(key).push({
      id: String(r.id),
      gender: r.gender,
      minAgeDays: r.min_age_days,
      maxAgeDays: r.max_age_days,
      min: num(r.min_value),
      max: num(r.max_value),
      minCritical: num(r.min_critical),
      maxCritical: num(r.max_critical),
      text: r.text_range,
      pregnant: r.is_pregnant,
    });
  }
  return byField;
}

async function namesFor(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, name, is_active FROM lab_test_catalog WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  return new Map(rows.map((r) => [String(r.id), { name: r.name, active: r.is_active }]));
}

async function otherReports(db, ids, reportId) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT rt.test_id, array_agg(r.name ORDER BY r.name) AS names
       FROM lab_report_tests rt
       JOIN lab_report_catalog r ON r.id = rt.report_id AND COALESCE(r.is_active, TRUE)
      WHERE rt.test_id = ANY($1::bigint[]) AND rt.report_id <> $2
      GROUP BY rt.test_id`,
    [ids, reportId],
  );
  return new Map(rows.map((r) => [String(r.test_id), r.names]));
}

async function reportView(db, reportId) {
  const { rows: reports } = await db.query(
    `SELECT id, name, aliases, is_active, source FROM lab_report_catalog WHERE id = $1`,
    [reportId],
  );
  const report = reports[0];
  if (!report) return null;
  const { rows: fields } = await db.query(FIELDS_SQL, [reportId]);
  fields.sort((a, b) => Number(a.ord) - Number(b.ord));
  const ids = fields.map((f) => String(f.id));
  const inputIds = [...new Set(fields.flatMap((f) => formulaInputs(f.formula)).map(String))];
  const [ranges, names, alsoIn] = await Promise.all([
    rangesFor(db, ids),
    namesFor(db, inputIds),
    otherReports(db, ids, reportId),
  ]);
  const inReport = new Set(ids);
  return {
    id: String(report.id),
    name: report.name,
    aliases: report.aliases || [],
    active: report.is_active !== false,
    source: report.source,
    fields: fields.map((f) => {
      const id = String(f.id);
      const inputs = formulaInputs(f.formula).map((input) => {
        const key = String(input);
        return {
          id: key,
          name: names.get(key)?.name ?? null,
          active: names.get(key)?.active ?? false,
          inReport: inReport.has(key),
        };
      });
      return {
        id,
        parentId: f.parent_test_id == null ? null : String(f.parent_test_id),
        depth: f.depth,
        name: f.name,
        unit: f.unit,
        noUnit: f.no_unit,
        type: f.formula ? "calculated" : f.input_type,
        decimals: f.decimals ?? 2,
        options: f.options || [],
        active: f.is_active !== false,
        required: f.depth === 0 ? f.is_required !== false : null,
        source: f.source,
        updatedAt: f.updated_at,
        formula: f.formula
          ? {
              raw: f.formula,
              text: formulaAsNames(f.formula, (key) => names.get(key)?.name),
              inputs,
            }
          : null,
        ranges: ranges.get(id) || [],
        alsoIn: alsoIn.get(id) || [],
      };
    }),
  };
}

export async function readTest(catalogId, db = pool) {
  const test = await catalogTest(db, catalogId);
  return {
    id: test.id,
    name: test.test_name,
    station: test.category || "lab",
    gloss: test.gloss,
    active: test.is_active,
    resultsAsFile: test.results_as_file,
    updatedAt: test.updated_at,
    serviceItemCode: test.service_item_code,
    report: test.lab_report_id ? await reportView(db, test.lab_report_id) : null,
  };
}

export async function readHistory(catalogId, db = pool) {
  const test = await catalogTest(db, catalogId);
  const reportId = test.lab_report_id ? String(test.lab_report_id) : null;
  const { rows } = await db.query(
    `WITH RECURSIVE tree AS (
       SELECT rt.test_id AS id, 0 AS depth FROM lab_report_tests rt WHERE rt.report_id = $2::bigint
       UNION ALL
       SELECT c.id, tree.depth + 1 FROM tree JOIN lab_test_catalog c ON c.parent_test_id = tree.id
        WHERE tree.depth < 4
     ),
     fields AS (
       SELECT id::text AS id FROM tree
       UNION
       SELECT entity_id FROM lab_catalog_audit
        WHERE entity = 'field' AND $2::text IS NOT NULL
          AND (after->>'report_id' = $2::text OR before->>'report_id' = $2::text)
     )
     SELECT a.id, a.entity, a.entity_id, a.action, a.before, a.after, a.at, d.name AS actor
       FROM lab_catalog_audit a
       LEFT JOIN doctors d ON d.id = a.actor_id
      WHERE (a.entity = 'link' AND a.entity_id = $1::text)
         OR ($2::text IS NOT NULL AND a.entity IN ('report', 'order') AND a.entity_id = $2::text)
         OR ($2::text IS NOT NULL AND a.entity IN ('field', 'ranges')
             AND a.entity_id IN (SELECT id FROM fields))
      ORDER BY a.at DESC, a.id DESC
      LIMIT 200`,
    [test.id, reportId],
  );
  const mentioned = new Set();
  for (const r of rows) {
    if (r.entity === "field" || r.entity === "ranges") mentioned.add(String(r.entity_id));
    for (const side of [r.before, r.after]) {
      for (const id of side?.order || []) mentioned.add(String(id));
      for (const id of formulaInputs(side?.formula)) mentioned.add(String(id));
    }
  }
  const ids = [...mentioned].filter((id) => /^\d+$/.test(id));
  const { rows: named } = ids.length
    ? await db.query(`SELECT id, name FROM lab_test_catalog WHERE id = ANY($1::bigint[])`, [ids])
    : { rows: [] };
  const names = Object.fromEntries(named.map((n) => [String(n.id), n.name]));
  return rows.map((r) => ({
    id: String(r.id),
    entity: r.entity,
    entityId: r.entity_id,
    subject:
      r.entity === "field" || r.entity === "ranges" ? names[String(r.entity_id)] || null : null,
    action: r.action,
    before: r.before,
    after: r.after,
    at: r.at,
    actor: r.actor,
    names,
  }));
}
