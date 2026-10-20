import pool from "../../config/db.js";

export const SITES = ["home", "ghm"];
export const HOME_REQUEST_DAYS = 7;
const CLOCK_SKEW_MS = 2 * 60 * 1000;

export const HOME_COLLECTION_SQL = (v) => `COALESCE(${v}.lab_site = 'home', (
  EXISTS (
    SELECT 1 FROM appointments hca
     WHERE hca.patient_id = ${v}.patient_id
       AND hca.appointment_date = ${v}.visit_date
       AND hca.home_collection IS TRUE
       AND COALESCE(hca.status, '') <> 'cancelled'
  )
  OR EXISTS (
    SELECT 1 FROM lab_test_requests hcr
     WHERE hcr.patient_id = ${v}.patient_id
       AND hcr.collection_type = 'home'
       AND hcr.status = 'approved'
       AND (hcr.created_at AT TIME ZONE 'Asia/Kolkata')::date
           BETWEEN ${v}.visit_date - ${HOME_REQUEST_DAYS} AND ${v}.visit_date
  )
))`;

export const ORDER_COLLECTED_SQL = (o) => `(
  SELECT json_build_object(
           'site', e.meta->>'site',
           'at', COALESCE(e.meta->>'collectedAt', to_json(e.occurred_at)#>>'{}'),
           'by', COALESCE(cd.short_name, cd.name))
    FROM giniflow_lab_order_events e
    LEFT JOIN doctors cd ON cd.id = e.actor_id
   WHERE e.lab_order_id = ${o}.id AND e.track = 'sample' AND e.status = 'sample_collected'
   ORDER BY e.occurred_at DESC
   LIMIT 1
)`;

export const ORDER_HOME_COLLECTED_SQL = (o) => `EXISTS (
  SELECT 1 FROM giniflow_lab_order_events he
   WHERE he.lab_order_id = ${o}.id AND he.track = 'sample'
     AND he.status = 'sample_collected' AND he.meta->>'site' = 'home'
)`;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

export function cleanSite(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!SITES.includes(value))
    throw badRequest("Choose where the sample was collected: home or GHM");
  return value;
}

const istDate = (at) => new Date(at.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);

export function cleanCollectedAt(value, visitDate, now = new Date()) {
  if (value === undefined || value === null || value === "") return now;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw badRequest("Enter the time the sample was collected");
  if (at.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    throw badRequest("The collection time can't be in the future");
  }
  if (visitDate && istDate(at) < String(visitDate).slice(0, 10)) {
    throw badRequest("The collection time can't be before the visit date");
  }
  return at;
}

export async function homeVisit(db, visitId) {
  if (!visitId) return null;
  const { rows } = await db.query(
    `SELECT v.id, v.patient_id, v.visit_date::text AS visit_date, p.name, p.file_no,
            ${HOME_COLLECTION_SQL("v")} AS home
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  return rows[0] ?? null;
}

export async function isHomeCollectionVisit(visitId, db = pool) {
  return !!(await homeVisit(db, visitId))?.home;
}

export function refuseSiteForNonHome(site, visit) {
  if (site && !visit?.home) throw badRequest("This patient did not opt for home collection");
}

const RECEPTION_HOME_SAMPLE_SQL = (v) => `
      UNION ALL
      SELECT 'home', hrr.collected_by, hrr.entered_by, hrr.collected_at
        FROM (
          SELECT r.sample, r.collected_by, r.entered_by, r.collected_at
            FROM giniflow_home_samples r
           WHERE r.visit_id = ${v}.id
           ORDER BY r.entered_at DESC, r.id DESC
           LIMIT 1
        ) hrr
       WHERE hrr.sample = 'collected'`;

export const VISIT_HOME_SAMPLE_SQL = (v, { reception = false } = {}) => `(
  SELECT json_build_object('site', hs.site, 'by', hs.by, 'byId', hs.by_id, 'at', hs.at)
    FROM (
      SELECT he.meta->>'site' AS site, COALESCE(hd.short_name, hd.name) AS by,
             he.actor_id AS by_id,
             COALESCE((he.meta->>'collectedAt')::timestamptz, he.occurred_at) AS at
        FROM giniflow_lab_order_events he
        JOIN giniflow_lab_orders ho ON ho.id = he.lab_order_id
        LEFT JOIN doctors hd ON hd.id = he.actor_id
       WHERE ho.visit_id = ${v}.id AND he.track = 'sample'
         AND he.status = 'sample_collected' AND he.meta->>'site' IS NOT NULL
      UNION ALL
      SELECT ha.collected_at_site, COALESCE(hd.short_name, hd.name), ha.actor_id,
             COALESCE(ha.collected_at, ha.created_at)
        FROM giniflow_lab_case_actions ha
        JOIN lab_cases hl ON hl.case_no = ha.case_no
        LEFT JOIN doctors hd ON hd.id = ha.actor_id
       WHERE ha.action = 'sample_taken' AND ha.collected_at_site IS NOT NULL
         AND hl.case_date = ${v}.visit_date AND hl.patient_id = ${v}.patient_id
      ${reception ? RECEPTION_HOME_SAMPLE_SQL(v) : ""}
    ) hs
   ORDER BY hs.at DESC
   LIMIT 1
)`;

export const homeSampleOf = (row) =>
  row?.home_sample
    ? { site: row.home_sample.site, by: row.home_sample.by, at: row.home_sample.at }
    : null;

export const BOOKING_HOME_SAMPLE_SQL = (a, opts) => `(
  SELECT ${VISIT_HOME_SAMPLE_SQL("hbv", opts)}
    FROM giniflow_visits hbv
   WHERE hbv.patient_id = ${a}.patient_id AND hbv.visit_date = ${a}.appointment_date
   ORDER BY hbv.created_at
   LIMIT 1
)`;
