import "../loadEnv.js";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import pool from "../config/db.js";

const NAME = "Reception 3";

const existing = await pool.query(
  "SELECT id, name, role, is_active FROM doctors WHERE lower(btrim(name)) = lower($1)",
  [NAME],
);
if (existing.rows.length) {
  console.log("already exists:", existing.rows);
  await pool.end();
  process.exit(0);
}

const others = await pool.query(
  "SELECT id, name, role, is_active FROM doctors WHERE role = 'reception' ORDER BY id",
);
console.table(others.rows);

const pin = String(crypto.randomInt(1000, 10000));
const pinHash = await bcrypt.hash(pin, 10);
const { rows } = await pool.query(
  `INSERT INTO doctors (name, role, pin) VALUES ($1, 'reception', $2)
   RETURNING id, name, role, is_active`,
  [NAME, pinHash],
);
console.log("created:", rows[0]);
console.log("PIN:", pin);
await pool.end();
