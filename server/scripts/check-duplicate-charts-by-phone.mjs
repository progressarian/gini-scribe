import "../loadEnv.js";
import pool from "../config/db.js";

const PHONE = (process.argv[2] || "8054066666").replace(/\D/g, "").slice(-10);
const DAY = process.argv[3] || new Date().toISOString().slice(0, 10);

const { rows: patients } = await pool.query(
  `SELECT id, name, file_no, health_id, phone, alt_phone, age, sex, created_at
     FROM patients
    WHERE right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
       OR $1 = ANY(SELECT right(regexp_replace(x, '\\D', '', 'g'), 10) FROM unnest(alt_phone) x)
    ORDER BY id`,
  [PHONE],
);
console.log(`charts on ${PHONE}:`);
console.table(patients);

const ids = patients.map((p) => p.id);
const { rows: appts } = await pool.query(
  `SELECT * FROM appointments WHERE patient_id = ANY($1) ORDER BY created_at`,
  [ids],
);
console.log(`appointments for those charts:`);
for (const a of appts) console.log(JSON.stringify(a));

const { rows: visits } = await pool.query(
  `SELECT * FROM giniflow_visits WHERE patient_id = ANY($1) AND visit_date = $2::date ORDER BY id`,
  [ids, DAY],
);
console.log(`giniflow visits on ${DAY}:`);
for (const v of visits) console.log(JSON.stringify(v));

await pool.end();
