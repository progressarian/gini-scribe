import pool from "../config/db.js";

// Boot-time assertion that the CRM's access-control invariants actually hold in
// the database this process is pointed at. A misconfigured environment — a
// crm_app role that was never created, RLS left off a table, a stray GRANT on
// public.patients — would otherwise fail open and silently expose clinical data
// to the growth team. Better to refuse to start.

const CHECKS = [
  {
    name: "crm_app role exists and cannot bypass RLS",
    sql: `SELECT rolname, rolbypassrls, rolcanlogin
            FROM pg_roles WHERE rolname = 'crm_app'`,
    verify: (rows) => {
      if (rows.length === 0) return "role crm_app does not exist";
      if (rows[0].rolbypassrls) return "crm_app has BYPASSRLS — every policy is inert";
      return null;
    },
  },
  {
    name: "row level security is enabled on every crm table",
    sql: `SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'crm' AND c.relkind = 'r'
             AND NOT c.relrowsecurity
             AND c.relname <> 'schema_migrations'`,
    verify: (rows) =>
      rows.length === 0 ? null : `RLS off on: ${rows.map((r) => r.relname).join(", ")}`,
  },
  {
    name: "crm_app holds no privileges on Scribe's clinical tables",
    sql: `SELECT table_name, privilege_type
            FROM information_schema.role_table_grants
           WHERE grantee = 'crm_app' AND table_schema = 'public'`,
    verify: (rows) =>
      rows.length === 0
        ? null
        : `crm_app can reach public.${rows.map((r) => `${r.table_name} (${r.privilege_type})`).join(", public.")}`,
  },
  {
    name: "crm_app cannot DELETE from any crm table",
    sql: `SELECT table_name
            FROM information_schema.role_table_grants
           WHERE grantee = 'crm_app' AND table_schema = 'crm' AND privilege_type = 'DELETE'`,
    verify: (rows) =>
      rows.length === 0
        ? null
        : `DELETE granted on: ${rows.map((r) => r.table_name).join(", ")} — soft deletes only`,
  },
  {
    name: "the role guard function is installed",
    sql: `SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'crm' AND p.proname = 'assert_app_role'`,
    verify: (rows) => (rows.length > 0 ? null : "crm.assert_app_role() is missing"),
  },
];

/**
 * @param {{ fatal?: boolean }} opts  fatal:true exits the process on failure.
 * @returns {Promise<string[]>} the failures found (empty when healthy)
 */
export async function assertCrmIsolation({ fatal = true } = {}) {
  const schema = await pool.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'crm'`);
  if (schema.rows.length === 0) {
    console.log("CRM: schema not present — skipping isolation checks");
    return [];
  }

  const failures = [];
  for (const check of CHECKS) {
    try {
      const { rows } = await pool.query(check.sql);
      const problem = check.verify(rows);
      if (problem) failures.push(`${check.name}: ${problem}`);
    } catch (err) {
      failures.push(`${check.name}: check itself failed — ${err.message}`);
    }
  }

  // Advisory: the NMC guard is best-effort because CREATE EVENT TRIGGER needs
  // superuser, which Supabase does not grant. CI covers the same ground.
  const trig = await pool.query(
    `SELECT 1 FROM pg_event_trigger WHERE evtname = 'crm_no_payout_columns'`,
  );
  if (trig.rows.length === 0) {
    console.warn(
      "CRM: event trigger crm_no_payout_columns is not installed — " +
        "ci_compliance_check.sh is the only guard against payout columns.",
    );
  }

  if (failures.length > 0) {
    console.error("CRM ISOLATION CHECK FAILED:");
    failures.forEach((f) => console.error(`  - ${f}`));
    if (fatal) {
      console.error("Refusing to start: CRM data would not be protected by RLS.");
      process.exit(1);
    }
  } else {
    console.log("CRM: isolation checks passed");
  }
  return failures;
}
