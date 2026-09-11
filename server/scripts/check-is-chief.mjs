import "../loadEnv.js";
import pool from "../config/db.js";
const NORM = (c) =>
  `btrim(regexp_replace(regexp_replace(lower(${c}), '^\\s*dr\\.?\\s*', ''), '\\s+', ' ', 'g'))`;
const { rows } = await pool.query(
  `SELECT d.id, d.name, d.role, d.is_chief, d.qualification,
          (SELECT count(*)::int FROM appointments a
            WHERE a.appointment_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
              AND ${NORM("a.doctor_name")} = ${NORM("d.name")}) AS appts_today
     FROM doctors d
    WHERE COALESCE(d.is_active, TRUE)
      AND (d.is_chief OR d.role IN ('consultant','mo'))
    ORDER BY d.is_chief DESC NULLS LAST, appts_today DESC
    LIMIT 12`,
);
console.log("\n## who is flagged as Chief, and who HealthRay books today");
console.table(rows);
await pool.end();
