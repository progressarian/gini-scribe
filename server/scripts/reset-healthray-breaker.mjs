// Clears the HealthRay login circuit-breaker so the next sync attempts a login
// immediately instead of sitting out its escalated WAF cooldown.
//
// Use ONLY when a one-off login from this machine returns HTTP 200 with a
// connect.sid — that proves the credentials and the egress IP are both fine and
// the breaker is the only thing still holding sync shut. During a genuine block,
// leave it alone: it escalates and self-heals on its own.
import "../loadEnv.js";
import pool from "../config/db.js";

const { rows: before } = await pool.query(
  `SELECT value::text FROM app_kv WHERE key = 'healthray_login_cooldown'`,
);
console.log("before:", before[0]?.value ?? "(unset)");

await pool.query(
  `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  [
    "healthray_login_cooldown",
    JSON.stringify({ until: 0, failCount: 0, blockCount: 0, reason: "" }),
  ],
);

const { rows: after } = await pool.query(
  `SELECT value::text FROM app_kv WHERE key = 'healthray_login_cooldown'`,
);
console.log("after: ", after[0].value);
await pool.end();
