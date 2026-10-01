import "../loadEnv.js";
import pool from "../config/db.js";

const bad = new Set(process.argv.slice(2).map(Number));
const lockHolders = async () =>
  (await pool.query(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=918273645`)).rows.map((r) => r.pid);
const probe = async (n) => {
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    const { rows } = await pool.query(
      `SELECT pg_backend_pid() pid, current_setting('default_transaction_read_only') d, current_setting('transaction_read_only') t`,
    );
    seen.set(rows[0].pid, rows[0].d === "on" || rows[0].t === "on");
  }
  return seen;
};

(await lockHolders()).forEach((p) => bad.add(p));
for (const [pid, ro] of await probe(150)) if (ro) bad.add(pid);
console.log("terminating", [...bad]);
for (const pid of bad) {
  const { rows } = await pool
    .query(`SELECT pg_terminate_backend($1) ok`, [pid])
    .catch((e) => ({ rows: [{ ok: e.message }] }));
  console.log(pid, rows[0].ok);
}
await new Promise((r) => setTimeout(r, 3000));
const after = await probe(150);
console.log("after: backends", after.size, "read-only", [...after].filter(([, v]) => v).map(([p]) => p));
console.log("sync lock holders", await lockHolders());
await pool.end();
