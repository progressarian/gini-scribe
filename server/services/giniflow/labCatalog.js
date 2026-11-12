import pool from "../../config/db.js";
import { rangeText } from "../../../shared/labFormula.js";

export const FLAT = (col) => `lower(regexp_replace(${col}, '[^a-zA-Z0-9]+', '', 'g'))`;

const CATALOG_SQL = `
WITH RECURSIVE want AS (
  SELECT ordered.name AS ordered_test, ${FLAT("ordered.name")} AS key
    FROM unnest($1::text[]) AS ordered(name)
),
hits AS (
  SELECT w.ordered_test, c.lab_report_id AS report_id, 0 AS tier
    FROM want w
    JOIN giniflow_test_catalog c ON c.lab_report_id IS NOT NULL AND ${FLAT("c.test_name")} = w.key
  UNION
  SELECT w.ordered_test, r.id, 1
    FROM want w
    JOIN lab_report_catalog r
      ON ${FLAT("r.name")} = w.key
      OR EXISTS (SELECT 1 FROM unnest(r.aliases) a WHERE ${FLAT("a")} = w.key)
),
ranked AS (
  SELECT hits.ordered_test, hits.report_id, hits.tier,
         min(hits.tier) OVER (PARTITION BY hits.ordered_test) AS top
    FROM hits
    JOIN lab_report_catalog r ON r.id = hits.report_id AND COALESCE(r.is_active, TRUE)
),
rep AS (
  SELECT DISTINCT ordered_test, report_id FROM ranked WHERE tier = top
),
tree AS (
  SELECT rep.ordered_test, t.id, t.parent_test_id, t.name, t.unit, t.input_type, t.formula,
         t.decimals, t.options, rt.sequence::numeric AS ord, 0 AS depth, rt.is_required
    FROM rep
    JOIN lab_report_tests rt ON rt.report_id = rep.report_id
    JOIN lab_test_catalog t ON t.id = rt.test_id AND COALESCE(t.is_active, TRUE)
  UNION ALL
  SELECT tree.ordered_test, c.id, c.parent_test_id, c.name, c.unit, c.input_type, c.formula,
         c.decimals, c.options, tree.ord + COALESCE(c.sequence, 0) / 1000.0, tree.depth + 1, tree.is_required
    FROM tree
    JOIN lab_test_catalog c ON c.parent_test_id = tree.id AND COALESCE(c.is_active, TRUE)
   WHERE tree.depth < 4
)
SELECT DISTINCT ON (tree.ordered_test, tree.id)
       tree.ordered_test, tree.id, tree.parent_test_id, tree.name, tree.unit, tree.input_type,
       tree.formula, tree.decimals, tree.options, tree.depth, tree.ord, tree.is_required,
       rng.min_value, rng.max_value, rng.min_critical, rng.max_critical, rng.text_range
  FROM tree
  LEFT JOIN LATERAL (
    SELECT x.min_value, x.max_value, x.min_critical, x.max_critical, x.text_range
      FROM lab_test_ranges x
     WHERE x.test_id = tree.id
       AND NOT x.is_pregnant
       AND (x.gender = 'Both' OR x.gender = $2::text)
       AND (CASE WHEN $3::int IS NULL THEN x.min_age_days <= 0 AND x.max_age_days >= 36500
                 ELSE $3::int BETWEEN x.min_age_days AND x.max_age_days END)
     ORDER BY (x.gender = $2::text) DESC, (x.max_age_days - x.min_age_days)
     LIMIT 1
  ) rng ON TRUE
 ORDER BY tree.ordered_test, tree.id, tree.ord`;

const shape = (row) => {
  const range = {
    minValue: row.min_value === null ? null : Number(row.min_value),
    maxValue: row.max_value === null ? null : Number(row.max_value),
    minCritical: row.min_critical === null ? null : Number(row.min_critical),
    maxCritical: row.max_critical === null ? null : Number(row.max_critical),
    textRange: row.text_range,
  };
  return {
    testId: String(row.id),
    ord: Number(row.ord),
    testName: row.name,
    canonicalName: null,
    unit: row.unit,
    inputType: row.input_type,
    formula: row.formula,
    decimals: row.decimals ?? 2,
    options: row.options || [],
    calculated: !!row.formula,
    depth: row.depth,
    isGroup: row.input_type === "group",
    range: row.min_value === null && row.max_value === null && !row.text_range ? null : range,
    refRange: rangeText(range),
    panelName: row.ordered_test,
    fromCatalog: true,
    required: row.depth === 0 ? !!row.is_required : row.input_type !== "group" && !row.formula,
    seen: 0,
  };
};

export async function catalogRowsFor(tests, { sex = null, ageYears = null } = {}, db = pool) {
  if (!tests.length) return new Map();
  const gender = sex === "Male" || sex === "Female" ? sex : null;
  const ageDays =
    ageYears !== null &&
    ageYears !== "" &&
    Number.isFinite(Number(ageYears)) &&
    Number(ageYears) >= 0
      ? Math.round(Number(ageYears) * 365.25)
      : null;
  const { rows } = await db.query(CATALOG_SQL, [tests, gender, ageDays]);
  const byTest = new Map();
  for (const row of rows) {
    if (!byTest.has(row.ordered_test)) byTest.set(row.ordered_test, []);
    byTest.get(row.ordered_test).push(shape(row));
  }
  for (const params of byTest.values()) params.sort((a, b) => a.ord - b.ord);
  return byTest;
}

export async function catalogTestsByIds(ids, { sex = null, ageYears = null } = {}, db = pool) {
  if (!ids.length) return [];
  const gender = sex === "Male" || sex === "Female" ? sex : null;
  const ageDays =
    ageYears !== null &&
    ageYears !== "" &&
    Number.isFinite(Number(ageYears)) &&
    Number(ageYears) >= 0
      ? Math.round(Number(ageYears) * 365.25)
      : null;
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.unit, t.input_type, t.formula, t.decimals, t.options,
            rng.min_value, rng.max_value, rng.min_critical, rng.max_critical, rng.text_range
       FROM lab_test_catalog t
       LEFT JOIN LATERAL (
         SELECT x.min_value, x.max_value, x.min_critical, x.max_critical, x.text_range
           FROM lab_test_ranges x
          WHERE x.test_id = t.id
            AND NOT x.is_pregnant
            AND (x.gender = 'Both' OR x.gender = $2::text)
            AND (CASE WHEN $3::int IS NULL THEN x.min_age_days <= 0 AND x.max_age_days >= 36500
                 ELSE $3::int BETWEEN x.min_age_days AND x.max_age_days END)
          ORDER BY (x.gender = $2::text) DESC, (x.max_age_days - x.min_age_days)
          LIMIT 1
       ) rng ON TRUE
      WHERE t.id = ANY($1::bigint[])`,
    [ids, gender, ageDays],
  );
  return rows.map((row) => ({
    id: String(row.id),
    name: row.name,
    unit: row.unit,
    inputType: row.input_type,
    formula: row.formula,
    decimals: row.decimals ?? 2,
    options: row.options || [],
    range: {
      minValue: row.min_value === null ? null : Number(row.min_value),
      maxValue: row.max_value === null ? null : Number(row.max_value),
      minCritical: row.min_critical === null ? null : Number(row.min_critical),
      maxCritical: row.max_critical === null ? null : Number(row.max_critical),
      textRange: row.text_range,
    },
  }));
}

export async function patientFor(patientId, db = pool, onDate = null) {
  const { rows } = await db.query(
    `SELECT p.sex,
            COALESCE(p.age, date_part('year', age(p.dob))::int) AS age,
            (SELECT v.weight FROM giniflow_vitals v
              WHERE v.patient_id = p.id AND v.weight IS NOT NULL
                AND (v.recorded_at AT TIME ZONE 'Asia/Kolkata')::date =
                    COALESCE($2::date, (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
              ORDER BY v.recorded_at DESC LIMIT 1) AS weight
       FROM patients p WHERE p.id = $1`,
    [patientId, onDate],
  );
  return {
    sex: rows[0]?.sex ?? null,
    ageYears: rows[0]?.age ?? null,
    weightKg: rows[0]?.weight == null ? null : Number(rows[0].weight),
  };
}
