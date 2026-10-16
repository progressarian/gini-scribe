import "../loadEnv.js";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");
const BATCH = 100;

const SUNDAY_ROWS = `
  SELECT id FROM appointments
   WHERE EXTRACT(ISODOW FROM own_follow_up_date) = 7
   ORDER BY id
   LIMIT ${BATCH}`;

const { rows: summary } = await pool.query(
  `SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE own_follow_up_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date)::int AS upcoming
     FROM appointments
    WHERE EXTRACT(ISODOW FROM own_follow_up_date) = 7`,
);
console.log(
  `${summary[0].total} follow-up date(s) on a Sunday, ${summary[0].upcoming} upcoming — each moves to the Monday`,
);

if (!APPLY) {
  const { rows } = await pool.query(
    `SELECT file_no, appointment_date::text AS visit, own_follow_up_date::text AS sunday,
            appointment_own_follow_up(follow_up_date, biomarkers, healthray_follow_up, appointment_date)::text AS monday
       FROM appointments
      WHERE EXTRACT(ISODOW FROM own_follow_up_date) = 7
        AND own_follow_up_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY own_follow_up_date, id
      LIMIT 10`,
  );
  console.table(rows);
  console.log("dry run — pass --apply to write");
  await pool.end();
  process.exit(0);
}

let done = 0;
for (let batch = 1; ; batch++) {
  const { rowCount } = await pool.query(
    `UPDATE appointments a
        SET own_follow_up_date = appointment_own_follow_up(
              a.follow_up_date, a.biomarkers, a.healthray_follow_up, a.appointment_date)
       FROM (${SUNDAY_ROWS}) s
      WHERE a.id = s.id`,
  );
  if (!rowCount) break;
  done += rowCount;
  console.log(`batch ${batch}: moved ${rowCount} (total ${done})`);
}
console.log(`done — ${done} follow-up date(s) moved off Sunday`);
await pool.end();
