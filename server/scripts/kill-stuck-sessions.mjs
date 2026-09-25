// Frees the pooler when every checkout hangs ("timeout exceeded when trying to
// connect", Supavisor ECHECKOUTRETRIES). Prints who holds the backends, then —
// with --kill — terminates sessions stuck in a transaction or on one query for
// longer than the app's own 60s statement_timeout could explain.
import "../loadEnv.js";
import pg from "pg";

const KILL = process.argv.includes("--kill");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, ""),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000,
  query_timeout: 30000,
});

const t0 = Date.now();
await client.connect();
console.log(`connected in ${Date.now() - t0}ms`);

const stuck = `
  SELECT pid, state, wait_event_type || ':' || coalesce(wait_event, '') AS wait,
         date_trunc('second', now() - xact_start)::text AS xact_age,
         date_trunc('second', now() - state_change)::text AS since,
         left(query, 80) AS query
    FROM pg_stat_activity
   WHERE datname = current_database()
     AND backend_type = 'client backend'
     AND pid <> pg_backend_pid()
     AND ((state = 'idle in transaction' AND now() - state_change > interval '2 minutes')
       OR (state = 'idle in transaction (aborted)')
       OR (state = 'active' AND now() - query_start > interval '3 minutes'))
   ORDER BY xact_start NULLS LAST`;

const { rows: summary } = await client.query(
  `SELECT state, count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
    GROUP BY 1 ORDER BY 2 DESC`,
);
console.table(summary);

const { rows: active } = await client.query(
  `SELECT pid, wait_event_type || ':' || coalesce(wait_event, '') AS wait,
          date_trunc('second', now() - query_start)::text AS age,
          left(regexp_replace(query, '\\s+', ' ', 'g'), 110) AS query
     FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
      AND state = 'active' AND pid <> pg_backend_pid()
    ORDER BY query_start`,
);
console.log("active now:");
console.table(active);

const { rows } = await client.query(stuck);
console.table(rows);

if (KILL && rows.length) {
  const { rows: killed } = await client.query(
    `SELECT pid, pg_terminate_backend(pid) AS terminated FROM (${stuck}) s`,
  );
  console.table(killed);
} else if (rows.length) {
  console.log(`${rows.length} stuck session(s). Re-run with --kill to terminate them.`);
} else {
  console.log(
    active.length
      ? "no stuck sessions — the problem is upstream of Postgres (pooler or compute)."
      : "no stuck sessions and nothing running — Postgres is healthy.",
  );
}
await client.end();
