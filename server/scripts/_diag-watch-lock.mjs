import "../loadEnv.js";
import pool from "../config/db.js";

const key = Number(process.argv[2] || 918273645);
const samples = Number(process.argv[3] || 12);
for (let i = 0; i < samples; i++) {
  const { rows } = await pool.query(
    `SELECT l.pid, s.state, left(regexp_replace(s.query, '\\s+', ' ', 'g'), 60) AS q
       FROM pg_locks l LEFT JOIN pg_stat_activity s ON s.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.objid = $1`,
    [key],
  );
  const t = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  console.log(t, rows.length ? rows.map((r) => `pid ${r.pid} ${r.state} | ${r.q}`).join(" ; ") : "FREE");
  if (i < samples - 1) await new Promise((r) => setTimeout(r, 20000));
}
await pool.end();
