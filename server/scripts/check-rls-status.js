import "../loadEnv.js";
import pool from "../config/db.js";

const q = async (sql) => (await pool.query(sql)).rows;

console.table(
  await q(`SELECT rolname, rolbypassrls FROM pg_roles
           WHERE rolname IN ('postgres','service_role','anon','authenticated')
           ORDER BY rolname`),
);

const [tables] = await q(
  `SELECT count(*) FILTER (WHERE rowsecurity) AS rls_on,
          count(*) FILTER (WHERE NOT rowsecurity) AS rls_off
   FROM pg_tables WHERE schemaname='public'`,
);
const [policies] = await q(
  `SELECT count(*) AS total,
          count(*) FILTER (WHERE qual='true' OR with_check='true') AS permissive
   FROM pg_policies WHERE schemaname='public'`,
);
const [grants] = await q(
  `SELECT count(*) AS n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND grantee IN ('anon','authenticated')`,
);
const [realtime] = await q(`SELECT count(*) AS n FROM pg_policies WHERE schemaname='realtime'`);

console.log({
  tables,
  publicPolicies: policies,
  anonGrants: grants.n,
  realtimePolicies: realtime.n,
});

const bad = [];
if (tables.rls_off !== "0") bad.push(`${tables.rls_off} tables without RLS`);
if (policies.permissive !== "0") bad.push(`${policies.permissive} allow-all policies`);
if (grants.n !== "0") bad.push(`${grants.n} grants to anon/authenticated`);
if (realtime.n === "0") bad.push("realtime policies missing — broadcast will break");
console.log(bad.length ? "EXPOSED: " + bad.join("; ") : "OK: public schema is closed to anon");

await pool.end();
