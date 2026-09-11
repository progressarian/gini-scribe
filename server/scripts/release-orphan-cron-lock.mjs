// Releases an orphaned cron advisory lock.
//
// The lock is session-scoped, but Supavisor keeps a pooled backend alive after
// the worker that held it is gone — so the lock outlives the process and every
// later run logs "still holds its lock" and skips. Because the pooler hands the
// same backends back out, asking each pooled session to unlock eventually
// reaches the one that holds it. Unlocking a lock you do not hold is a no-op
// that returns false, so this is safe to run.
import "../loadEnv.js";
import pool from "../config/db.js";

const KEY = Number(process.argv[2]);
if (!Number.isFinite(KEY)) {
  console.error("usage: node scripts/release-orphan-cron-lock.mjs <lock-key>");
  process.exit(1);
}

const held = async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1`,
    [KEY],
  );
  return rows[0].n;
};

console.log(`lock ${KEY}: held by ${await held()} session(s)`);

for (let i = 0; i < 20 && (await held()) > 0; i++) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT pg_advisory_unlock($1) AS released`, [KEY]);
    if (rows[0].released) console.log(`  attempt ${i + 1}: released`);
  } finally {
    client.release();
  }
}

console.log(`lock ${KEY}: now held by ${await held()} session(s)`);
await pool.end();
