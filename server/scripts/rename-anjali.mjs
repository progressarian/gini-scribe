import "../loadEnv.js";
import pool from "../config/db.js";

const { rows } = await pool.query(
  `UPDATE doctors SET name = 'Anjali', short_name = 'Anjali'
    WHERE id = 97 AND name = 'ANJALI'
    RETURNING id, name, short_name, role`,
);
console.log(rows.length ? { renamed: rows[0] } : "nothing changed — id 97 is not named ANJALI");
await pool.end();
