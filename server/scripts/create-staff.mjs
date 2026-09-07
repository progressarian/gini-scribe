// Create a staff login (doctors row) with a bcrypt-hashed PIN.
//
// The floor's non-doctor desks are accounts in the same `doctors` table, so
// staffing a station is one insert with the right canonical role. Roles are
// validated against the RBAC matrix — normalizeRole() fails closed, and a typo
// here would silently create a `guest` account that logs in and sees nothing.
//
//   node server/scripts/create-staff.mjs --name "Prescription Explainer" --role rx --pin 4821
//
// Optional: --short "Rx Desk"  --phone 98xxxxxxxx
//
// ⚠️ DATABASE_URL is production. This writes a real login.

import "../loadEnv.js";
import bcrypt from "bcrypt";
import pool from "../config/db.js";
import { ROLE_CAPABILITIES, normalizeRole } from "../../shared/permissions.js";

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
};

const name = arg("--name");
const role = (arg("--role") || "").trim().toLowerCase();
const pin = arg("--pin");
const shortName = arg("--short");
const phone = arg("--phone");

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (!name || !role || !pin) die('Usage: --name "Full Name" --role <role> --pin <digits>');
if (!/^\d{4,8}$/.test(pin)) die("PIN must be 4-8 digits.");
if (normalizeRole(role) !== role)
  die(`Unknown role "${role}". Valid roles: ${Object.keys(ROLE_CAPABILITIES).join(", ")}`);

const existing = await pool.query("SELECT id, role FROM doctors WHERE lower(name)=lower($1)", [
  name,
]);
if (existing.rows.length)
  die(`"${name}" already exists (id ${existing.rows[0].id}, role ${existing.rows[0].role}).`);

const { rows } = await pool.query(
  `INSERT INTO doctors (name, short_name, role, pin, phone, is_active)
   VALUES ($1,$2,$3,$4,$5,true)
   RETURNING id, name, short_name, role`,
  [name, shortName || null, role, await bcrypt.hash(pin, 10), phone || null],
);

const caps = ROLE_CAPABILITIES[role];
console.log(`Created #${rows[0].id} ${rows[0].name} — role ${rows[0].role}`);
console.log(`Capabilities: ${caps === "*" ? "ALL" : caps.join(", ") || "none"}`);
await pool.end();
