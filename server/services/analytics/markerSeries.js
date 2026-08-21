import { MARKERS, MARKER_KEYS } from "./constants.js";

const EARLIEST_VALID_DATE = "2015-01-01";

function buildUnionSql(markerKeys, params) {
  const parts = [];
  for (const key of markerKeys) {
    const spec = MARKERS[key];
    if (!spec) continue;
    if (spec.canonical && spec.canonical.length) {
      params.push(key, spec.canonical, spec.min, spec.max);
      const i = params.length;
      parts.push(
        `SELECT patient_id, $${i - 3}::text AS marker, test_date AS d, result::float8 AS val
           FROM lab_results
          WHERE canonical_name = ANY($${i - 2}::text[])
            AND result IS NOT NULL
            AND result::float8 BETWEEN $${i - 1}::float8 AND $${i}::float8
            AND test_date IS NOT NULL`,
      );
    }
    if (spec.vitalsColumn) {
      params.push(key, spec.min, spec.max);
      const i = params.length;
      parts.push(
        `SELECT patient_id, $${i - 2}::text AS marker, recorded_at::date AS d, ${spec.vitalsColumn}::float8 AS val
           FROM vitals
          WHERE ${spec.vitalsColumn} IS NOT NULL
            AND ${spec.vitalsColumn}::float8 BETWEEN $${i - 1}::float8 AND $${i}::float8
            AND recorded_at IS NOT NULL`,
      );
    }
  }
  return parts.join("\n UNION ALL \n");
}

function dedupedCte(markerKeys, params, asOf) {
  const union = buildUnionSql(markerKeys, params);
  params.push(EARLIEST_VALID_DATE, asOf);
  const lo = params.length - 1;
  const hi = params.length;
  return `
    raw AS (
      ${union}
    ),
    filtered AS (
      SELECT patient_id, marker, d, val
        FROM raw
       WHERE patient_id IS NOT NULL
         AND d BETWEEN $${lo}::date AND $${hi}::date
    ),
    dedup AS (
      SELECT patient_id, marker, d, MAX(val) AS val
        FROM filtered
       GROUP BY patient_id, marker, d
    )`;
}

export async function getMarkerSummary(db, { markers = MARKER_KEYS, asOf } = {}) {
  const params = [];
  const cte = dedupedCte(markers, params, asOf);
  const sql = `
    WITH ${cte},
    ranked AS (
      SELECT patient_id, marker, d, val,
             ROW_NUMBER() OVER (PARTITION BY patient_id, marker ORDER BY d DESC) AS rn_desc,
             ROW_NUMBER() OVER (PARTITION BY patient_id, marker ORDER BY d ASC) AS rn_asc,
             COUNT(*) OVER (PARTITION BY patient_id, marker) AS n
        FROM dedup
    )
    SELECT patient_id, marker, n,
           MAX(val) FILTER (WHERE rn_desc = 1) AS last_val,
           MAX(d)   FILTER (WHERE rn_desc = 1) AS last_date,
           MAX(val) FILTER (WHERE rn_desc = 2) AS prev_val,
           MAX(d)   FILTER (WHERE rn_desc = 2) AS prev_date,
           MAX(val) FILTER (WHERE rn_asc = 1)  AS first_val,
           MAX(d)   FILTER (WHERE rn_asc = 1)  AS first_date
      FROM ranked
     WHERE rn_desc <= 2 OR rn_asc = 1
     GROUP BY patient_id, marker, n`;
  const { rows } = await db.query(sql, params);
  return rows;
}

export async function getMarkerCoverage(db, { markers = MARKER_KEYS, asOf } = {}) {
  const params = [];
  const cte = dedupedCte(markers, params, asOf);
  const sql = `
    WITH ${cte},
    per_patient AS (
      SELECT patient_id, marker, COUNT(*) AS n, MAX(d) AS last_date
        FROM dedup GROUP BY patient_id, marker
    )
    SELECT marker,
           COUNT(*) AS patients_any,
           COUNT(*) FILTER (WHERE n >= 2) AS patients_paired,
           SUM(n) AS readings,
           COUNT(*) FILTER (WHERE last_date >= ($${params.length}::date - 365)) AS patients_current
      FROM per_patient
     GROUP BY marker`;
  const { rows } = await db.query(sql, params);
  return rows;
}

export async function getWindowedOutcomes(db, { cohort, markers, asOf, baseline, windows } = {}) {
  if (!cohort || !cohort.length) return [];
  const params = [];
  const cte = dedupedCte(markers, params, asOf);

  params.push(cohort.map((c) => c.patient_id));
  const idsIdx = params.length;
  params.push(cohort.map((c) => c.index_date));
  const datesIdx = params.length;
  params.push(cohort.map((c) => c.cohort_key));
  const keysIdx = params.length;
  params.push(baseline.beforeDays, baseline.afterDays);
  const baseBefore = params.length - 1;
  const baseAfter = params.length;

  const windowCases = windows
    .map((w) => {
      params.push(w.key, w.minDays, w.maxDays, w.targetDays);
      const i = params.length;
      return `SELECT $${i - 3}::text AS window_key, $${i - 2}::int AS min_days, $${i - 1}::int AS max_days, $${i}::int AS target_days`;
    })
    .join(" UNION ALL ");

  const sql = `
    WITH ${cte},
    cohort AS (
      SELECT unnest($${idsIdx}::int[]) AS patient_id,
             unnest($${datesIdx}::date[]) AS index_date,
             unnest($${keysIdx}::text[]) AS cohort_key
    ),
    windows AS (${windowCases}),
    baseline_pick AS (
      SELECT DISTINCT ON (c.patient_id, c.cohort_key, d.marker)
             c.patient_id, c.cohort_key, c.index_date, d.marker, d.val AS baseline_val, d.d AS baseline_date
        FROM cohort c
        JOIN dedup d ON d.patient_id = c.patient_id
       WHERE d.d BETWEEN c.index_date - $${baseBefore}::int AND c.index_date + $${baseAfter}::int
       ORDER BY c.patient_id, c.cohort_key, d.marker, d.d DESC
    ),
    followup_pick AS (
      SELECT DISTINCT ON (c.patient_id, c.cohort_key, d.marker, w.window_key)
             c.patient_id, c.cohort_key, d.marker, w.window_key,
             d.val AS followup_val, d.d AS followup_date,
             (d.d - c.index_date) AS days_after
        FROM cohort c
        JOIN dedup d ON d.patient_id = c.patient_id
        CROSS JOIN windows w
       WHERE d.d BETWEEN c.index_date + w.min_days AND c.index_date + w.max_days
       ORDER BY c.patient_id, c.cohort_key, d.marker, w.window_key,
                ABS((d.d - c.index_date) - w.target_days) ASC, d.d DESC
    )
    SELECT b.patient_id, b.cohort_key, b.marker, b.index_date,
           b.baseline_val, b.baseline_date,
           f.window_key, f.followup_val, f.followup_date, f.days_after
      FROM baseline_pick b
      LEFT JOIN followup_pick f
        ON f.patient_id = b.patient_id
       AND f.cohort_key = b.cohort_key
       AND f.marker = b.marker`;

  const { rows } = await db.query(sql, params);
  return rows;
}

export async function getLatestMarkerValues(db, { markers, asOf } = {}) {
  const params = [];
  const cte = dedupedCte(markers, params, asOf);
  const sql = `
    WITH ${cte}
    SELECT DISTINCT ON (patient_id, marker) patient_id, marker, d AS test_date, val
      FROM dedup
     ORDER BY patient_id, marker, d DESC`;
  const { rows } = await db.query(sql, params);
  return rows;
}
