import "../loadEnv.js";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import pool from "../config/db.js";

const NAME = process.argv.slice(2).join(" ").trim();
if (!NAME || !/^[A-Za-z0-9.\s'-]{2,60}$/.test(NAME)) {
  console.error('usage: node scripts/create-care-coordinator.mjs "Full Name"');
  process.exit(1);
}

const existing = await pool.query(
  "SELECT id, name, role, is_active FROM doctors WHERE lower(btrim(name)) = lower($1)",
  [NAME],
);
if (existing.rows.length) {
  console.log("already exists:", existing.rows);
  await pool.end();
  process.exit(0);
}

const pin = String(crypto.randomInt(1000, 10000));
const pinHash = await bcrypt.hash(pin, 10);
const { rows } = await pool.query(
  `INSERT INTO doctors (name, short_name, role, pin) VALUES ($1, $1, 'care_coordinator', $2)
   RETURNING id, name, role, is_active`,
  [NAME, pinHash],
);
console.log("created:", rows[0]);
console.log("PIN:", pin);
await pool.end();
