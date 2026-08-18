/**
 * Create login accounts for the OBT (outbound booking / call) team.
 *
 * OBT works tomorrow's appointment call-list (GET /api/obt-status), which is
 * gated by the OBT_OPS capability — so these accounts get role = "obt".
 *
 * ⚠️ .env DATABASE_URL points at PRODUCTION. This INSERTS live rows.
 * Run from gini-scribe/server:
 *   node scripts/seed-obt-team.mjs
 */
import "../loadEnv.js";
import pool from "../config/db.js";

// name -> PIN. Fill in a PIN for each before running (left blank so real PINs
// are never committed). NOTE: the prod `doctors.pin` column is varchar(10) and
// every existing account stores its PIN in PLAIN TEXT (bcrypt hashes are 60
// chars and don't fit), so PINs are stored as-is, matching the live convention.
const TEAM = [
  { name: "Ritu", pin: "" },
  { name: "Jaspreet", pin: "" },
  { name: "Rajinder", pin: "" },
];

async function main() {
  for (const { name, pin } of TEAM) {
    if (!pin) {
      console.log(`skip  ${name} — no PIN set in the script`);
      continue;
    }
    const exists = await pool.query("SELECT id FROM doctors WHERE lower(name)=lower($1)", [name]);
    if (exists.rows.length) {
      console.log(`skip  ${name} — already exists (id ${exists.rows[0].id})`);
      continue;
    }
    const r = await pool.query(
      `INSERT INTO doctors (name, short_name, specialty, role, pin, is_active)
       VALUES ($1,$2,$3,'obt',$4,true)
       RETURNING id, name, role`,
      [name, name, "OBT Team", pin],
    );
    console.log(
      `created ${r.rows[0].name} (id ${r.rows[0].id}, role ${r.rows[0].role}) — PIN ${pin}`,
    );
  }
  await pool.end();
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
