import "../loadEnv.js";
import pool from "../config/db.js";

const SOURCE_ID = 97;
const NAME = "Prescription Explainer 2";

const source = await pool.query(
  "SELECT id, name, role, pin FROM doctors WHERE id = $1 AND is_active = true",
  [SOURCE_ID],
);
if (!source.rows.length || !source.rows[0].pin) {
  console.error(`id ${SOURCE_ID} is missing, inactive or has no PIN — nothing created`);
  await pool.end();
  process.exit(1);
}

const existing = await pool.query(
  "SELECT id, name, role, is_active FROM doctors WHERE role = 'rx' AND lower(btrim(name)) = lower($1)",
  [NAME],
);
if (existing.rows.length) {
  console.log("already exists:", existing.rows);
  await pool.end();
  process.exit(0);
}

const { rows } = await pool.query(
  `INSERT INTO doctors (name, short_name, role, pin) VALUES ($1, $1, 'rx', $2)
   RETURNING id, name, role, is_active`,
  [NAME, source.rows[0].pin],
);
console.log("created:", rows[0], `— same PIN as ${source.rows[0].name} (id ${SOURCE_ID})`);
await pool.end();
