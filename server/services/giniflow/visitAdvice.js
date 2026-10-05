import pool from "../../config/db.js";

const COMMON_LIMIT = 60;
const RAW_LIMIT = 600;
const COMMON_TTL_MS = 30 * 60_000;
let commonCache = { at: 0, lines: null };

const COMMON_SQL = `
  WITH raw AS (
    SELECT a.healthray_advice AS text
      FROM appointments a
     WHERE a.appointment_date > CURRENT_DATE - 180
       AND NULLIF(btrim(a.healthray_advice), '') IS NOT NULL
    UNION ALL
    SELECT cp.advice
      FROM giniflow_care_plans cp
     WHERE cp.updated_at > NOW() - INTERVAL '180 days'
       AND NULLIF(btrim(cp.advice), '') IS NOT NULL
  ),
  lines AS (
    SELECT btrim(regexp_replace(part, '^\\s*(\\d+[.)]|[-•*])\\s*', '')) AS line
      FROM raw, regexp_split_to_table(raw.text, '\\n+') AS part
  )
  SELECT MIN(line) AS line, COUNT(*)::int AS uses
    FROM lines
   WHERE length(line) BETWEEN 8 AND 200
   GROUP BY lower(line)
   ORDER BY uses DESC, MIN(line)
   LIMIT $1`;

export const adviceKey = (line) =>
  String(line || "")
    .toLowerCase()
    .replace(/\b(grams?|gms?|gm)\b/g, "g")
    .replace(/(\d)\s*g\b/g, "$1 g")
    .replace(/\bself[\s-]+monitoring\b/g, "self monitoring")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function mergeAdvice(rows, limit = COMMON_LIMIT) {
  const groups = new Map();
  for (const { line, uses } of rows) {
    const key = adviceKey(line);
    if (!key) continue;
    const group = groups.get(key);
    if (!group) groups.set(key, { line, uses, best: uses });
    else {
      group.uses += uses;
      if (uses > group.best) Object.assign(group, { line, best: uses });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.uses - a.uses || a.line.localeCompare(b.line))
    .slice(0, limit)
    .map(({ line, uses }) => ({ line, uses }));
}

async function commonAdvice(db) {
  if (commonCache.lines && Date.now() - commonCache.at < COMMON_TTL_MS) return commonCache.lines;
  const { rows } = await db.query(COMMON_SQL, [RAW_LIMIT]).catch(() => ({ rows: null }));
  if (!rows) return [];
  commonCache = { at: Date.now(), lines: mergeAdvice(rows) };
  return commonCache.lines;
}

async function assertVisit(visitId, db) {
  const { rowCount } = await db.query(`SELECT 1 FROM giniflow_visits WHERE id = $1`, [visitId]);
  if (!rowCount) throw Object.assign(new Error("Visit not found"), { status: 404 });
}

export async function getVisitAdvice(visitId, db = pool) {
  await assertVisit(visitId, db);
  const [{ rows }, common] = await Promise.all([
    db
      .query(`SELECT advice FROM giniflow_care_plans WHERE visit_id = $1`, [visitId])
      .catch(() => ({ rows: [] })),
    commonAdvice(db),
  ]);
  return { advice: rows[0]?.advice ?? "", common };
}

export async function saveVisitAdvice(visitId, advice, actorId = null, db = pool) {
  await assertVisit(visitId, db);
  const text = String(advice ?? "").trim() || null;
  const { rows } = await db.query(
    `INSERT INTO giniflow_care_plans (visit_id, advice, authored_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (visit_id) DO UPDATE
        SET advice = EXCLUDED.advice,
            authored_by = COALESCE(giniflow_care_plans.authored_by, EXCLUDED.authored_by),
            updated_at = NOW()
     RETURNING advice, updated_at`,
    [visitId, text, actorId],
  );
  return rows[0];
}

export async function appointmentAdvice(appointmentId, db = pool) {
  if (!appointmentId) return null;
  const { rows } = await db
    .query(
      `SELECT cp.advice FROM giniflow_visits v
         JOIN giniflow_care_plans cp ON cp.visit_id = v.id
        WHERE v.appointment_id = $1
        LIMIT 1`,
      [appointmentId],
    )
    .catch(() => ({ rows: [] }));
  return rows[0]?.advice?.trim() || null;
}
