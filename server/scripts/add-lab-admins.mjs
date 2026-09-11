// Adds extra lab_admin accounts.
//
// Uses the same shape as POST /api/doctors — a bcrypt-hashed PIN, not the
// plaintext most of the older rows still carry — so these are created the way
// the app itself creates an account. Idempotent: a name that already exists is
// skipped rather than duplicated.
//
//   node scripts/add-lab-admins.mjs
import "../loadEnv.js";
import pool from "../config/db.js";
import bcrypt from "bcrypt";
import { randomInt } from "crypto";

// A 4-digit PIN, because that is what the login box accepts (maxLength 4).
// crypto rather than Math.random — this is a credential. The obvious ones are
// rejected rather than left to chance.
const weak = (p) => /^(\d)\1{3}$/.test(p) || ["1234", "4321", "2580", "1230"].includes(p);
const newPin = () => {
  for (;;) {
    const p = String(randomInt(1000, 10000));
    if (!weak(p)) return p;
  }
};

const wanted = [
  { name: "LAB ADMIN 2", short_name: "Lab Admin 2" },
  { name: "LAB ADMIN 3", short_name: "Lab Admin 3" },
];

const created = [];
for (const w of wanted) {
  const { rows: exists } = await pool.query(
    `SELECT id, name FROM doctors WHERE lower(btrim(name)) = lower($1)`,
    [w.name],
  );
  if (exists.length) {
    console.log(`SKIP  ${w.name} — already exists (id ${exists[0].id})`);
    continue;
  }
  const pin = newPin();
  const { rows } = await pool.query(
    `INSERT INTO doctors (name, short_name, specialty, role, pin, is_active)
     VALUES ($1, $2, 'Laboratory', 'lab_admin', $3, TRUE)
     RETURNING id, name, short_name, role`,
    [w.name, w.short_name, await bcrypt.hash(pin, 10)],
  );
  created.push({ ...rows[0], pin });
  console.log(`OK    ${w.name} — id ${rows[0].id}`);
}

if (created.length) {
  console.log("\nPINs (shown once — stored hashed, so they cannot be read back):");
  console.table(created.map((c) => ({ id: c.id, name: c.name, role: c.role, PIN: c.pin })));
}
await pool.end();
