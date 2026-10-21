import "../loadEnv.js";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import pool from "../config/db.js";

const name = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"))
  .join(" ")
  .trim();
if (!name) {
  console.error('Usage: node scripts/create-obt-member.mjs "Full Name"');
  process.exit(1);
}

const existing = await pool.query(
  "SELECT id, name, role, is_active FROM doctors WHERE lower(btrim(name)) = lower($1)",
  [name],
);
if (existing.rows.length) {
  console.log("already exists, nothing changed:", existing.rows);
  await pool.end();
  process.exit(0);
}

const pin = String(crypto.randomInt(1000, 10000));
const { rows } = await pool.query(
  `INSERT INTO doctors (name, short_name, role, pin) VALUES ($1, $1, 'obt', $2)
   RETURNING id, name, role, is_active,
             COALESCE((to_jsonb(doctors)->>'can_assign_calls')::boolean, FALSE) AS can_assign_calls`,
  [name, await bcrypt.hash(pin, 10)],
);
console.log("created OBT member (assigned patients only):", rows[0]);
console.log("PIN:", pin);
await pool.end();
