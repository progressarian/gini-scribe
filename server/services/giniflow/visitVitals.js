import pool from "../../config/db.js";

// Today's reading for a visit, from whichever table actually has it.
//
// There are two, on purpose. The Gini Flow vitals station writes
// `giniflow_vitals`; the nurses still working on HealthRay's own screen write
// the older `vitals` table, and `appointmentSync.js` reads that as the
// observation it is — finding a reading there is exactly what moves those
// patients to `vitals_done`, and the event it writes even carries the
// `vitals_id` it saw.
//
// So a screen that reads only `giniflow_vitals` tells the MO "not taken yet"
// about a patient whose 172/86 is on file and whose status was advanced BECAUSE
// of that reading. On the day this was written `giniflow_vitals` held 3 rows
// ever and the legacy table held 21 for that day alone.
//
// `readingSource` says which table answered, so a screen can name where the
// number came from instead of implying the nurse at this station took it.

const GINIFLOW_SQL = `
  SELECT weight, height, bmi, bp_sys, bp_dia, pulse, spo2, temp, recorded_at,
         'station'::text AS reading_source
    FROM giniflow_vitals
   WHERE visit_id = $1
   ORDER BY recorded_at DESC LIMIT 1`;

// Same day only. A reading from an earlier visit is the comparison value, which
// every caller fetches separately — handing it back here would render last
// month's weight as though it were taken this morning.
const LEGACY_SQL = `
  SELECT weight, height, bmi, bp_sys, bp_dia, pulse, spo2, temp, recorded_at,
         'healthray'::text AS reading_source
    FROM vitals
   WHERE patient_id = $1
     AND (recorded_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
   ORDER BY recorded_at DESC LIMIT 1`;

// `vitals` stores numerics and `giniflow_vitals` stores plain numbers, so the
// same BP arrives as "149.00" from one and 149 from the other. Normalise, or
// the MO reads 149.00/84.00 depending on which nurse took it.
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

const shape = (r) =>
  r && {
    ...r,
    weight: num(r.weight),
    height: num(r.height),
    bmi: num(r.bmi),
    bp_sys: num(r.bp_sys),
    bp_dia: num(r.bp_dia),
    pulse: num(r.pulse),
    spo2: num(r.spo2),
    temp: num(r.temp),
    readingSource: r.reading_source,
  };

export async function todaysVitals(visitId, { patientId, visitDate } = {}, db = pool) {
  const { rows } = await db.query(GINIFLOW_SQL, [visitId]);
  if (rows[0]) return shape(rows[0]);
  if (!patientId || !visitDate) return null;
  const { rows: legacy } = await db.query(LEGACY_SQL, [patientId, visitDate]);
  return shape(legacy[0]) || null;
}

// The reading before today's, for the change the MO and the consultant read.
// Always the legacy table: it is the full history, and a Gini Flow reading is
// promoted into it. Strictly earlier than the visit date, so today's own
// reading can never be compared against itself.
export async function previousVitals(patientId, visitDate, db = pool) {
  if (!patientId) return null;
  const { rows } = await db.query(
    `SELECT weight, height, bmi, bp_sys, bp_dia, pulse, spo2, temp, recorded_at
       FROM vitals
      WHERE patient_id = $1
        AND (recorded_at AT TIME ZONE 'Asia/Kolkata')::date < $2::date
      ORDER BY recorded_at DESC LIMIT 1`,
    [patientId, visitDate],
  );
  return shape(rows[0]) || null;
}
