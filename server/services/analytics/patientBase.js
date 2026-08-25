import { AGE_BANDS, VISIT_STATUSES_COUNTED, CONTINUITY_DAYS, RECENCY_BANDS } from "./constants.js";

export function ageBand(age) {
  if (age == null || isNaN(age)) return null;
  const band = AGE_BANDS.find((b) => age >= b.min && age <= b.max);
  return band ? band.key : null;
}

export function normalizeSex(sex) {
  const s = (sex || "").trim().toLowerCase();
  if (s === "male" || s === "m") return "Male";
  if (s === "female" || s === "f") return "Female";
  return "Unspecified";
}

export function daysBetween(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  const a = new Date(`${fromDate}T00:00:00Z`).getTime();
  const b = new Date(`${toDate}T00:00:00Z`).getTime();
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function recencyBand(days) {
  if (days == null) return "never";
  for (const band of RECENCY_BANDS) {
    if (band.maxDays == null || days <= band.maxDays) return band.key;
  }
  return "gt_12m";
}

export async function getPatientBase(db, { asOf } = {}) {
  const sql = `
    WITH visit_events AS (
      SELECT patient_id, visit_date AS d FROM consultations
       WHERE patient_id IS NOT NULL AND visit_date IS NOT NULL AND visit_date <= $1::date
      UNION ALL
      SELECT patient_id, appointment_date AS d FROM appointments
       WHERE patient_id IS NOT NULL AND appointment_date IS NOT NULL AND appointment_date <= $1::date
         AND status = ANY($2::text[])
    ),
    visit_days AS (
      SELECT patient_id, d FROM visit_events GROUP BY patient_id, d
    ),
    visit_agg AS (
      SELECT patient_id, MIN(d) AS first_visit, MAX(d) AS last_visit, COUNT(*) AS visit_days
        FROM visit_days GROUP BY patient_id
    ),
    visit_triples AS (
      SELECT patient_id, d, LEAD(d, 2) OVER (PARTITION BY patient_id ORDER BY d) AS third_next
        FROM visit_days
    ),
    dense_year AS (
      SELECT patient_id,
             bool_or(third_next IS NOT NULL AND third_next - d <= 365) AS dense_year
        FROM visit_triples GROUP BY patient_id
    )
    SELECT p.id AS patient_id,
           p.file_no,
           p.sex,
           p.dob,
           p.age AS stored_age,
           CASE WHEN p.dob IS NOT NULL
                THEN EXTRACT(YEAR FROM AGE($1::date, p.dob))::int
                ELSE p.age END AS age,
           v.first_visit,
           v.last_visit,
           COALESCE(v.visit_days, 0) AS visit_days,
           COALESCE(dy.dense_year, false) AS dense_year
      FROM patients p
      LEFT JOIN visit_agg v ON v.patient_id = p.id
      LEFT JOIN dense_year dy ON dy.patient_id = p.id`;
  const { rows } = await db.query(sql, [asOf, VISIT_STATUSES_COUNTED]);
  return rows.map((r) => {
    const daysSince = daysBetween(r.last_visit, asOf);
    const age = r.age == null ? null : Number(r.age);
    return {
      patient_id: r.patient_id,
      file_no: r.file_no,
      sex: normalizeSex(r.sex),
      rawSex: r.sex,
      hasDob: !!r.dob,
      age,
      ageBand: ageBand(age),
      first_visit: r.first_visit,
      last_visit: r.last_visit,
      visit_days: Number(r.visit_days),
      dense_year: r.dense_year === true,
      days_since_visit: daysSince,
      recency: recencyBand(daysSince),
      continuing: daysSince != null && daysSince <= CONTINUITY_DAYS,
      tenure_days: daysBetween(r.first_visit, asOf),
    };
  });
}
