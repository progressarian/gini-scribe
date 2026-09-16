import pool from "../config/db.js";

// Every CRM query must run as the crm_app role, never as the pool's own role.
//
// Supabase grants BYPASSRLS to `postgres`, which is what DATABASE_URL connects
// as, so FORCE ROW LEVEL SECURITY does not stop the default connection.
// Dropping to crm_app is what makes the 52 policies apply at all. That makes
// this module the single chokepoint for CRM data access:
//
//   - Route handlers receive a query function from withCrmContext and never
//     touch the pool. server/crm/checkNoDirectPool.mjs fails the build if any
//     file under server/crm/ other than this one imports the pool.
//   - crm.assert_app_role() runs inside every transaction and raises if the
//     role switch somehow did not happen.
//   - assertCrmIsolation() re-checks the invariants at boot.

/**
 * Run `fn` inside a transaction that has dropped to crm_app and declared who
 * the acting CRM user is. Both settings are SET LOCAL, so they unwind on
 * COMMIT or ROLLBACK and never leak to the next borrower of the connection.
 *
 * @param {{id: string}} crmUser  row from crm.users (see resolveCrmUser)
 * @param {(sql: string, params?: unknown[]) => Promise<import("pg").QueryResult>} fn
 */
export async function withCrmContext(crmUser, fn) {
  if (!crmUser?.id) {
    throw new Error(
      "withCrmContext requires a CRM user with an id — refusing to query as the pool role",
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Identity first, then the role switch: set_config with is_local=true is
    // transaction-scoped, and crm.current_user_id() reads it.
    await client.query("SELECT set_config('crm.user_id', $1, true)", [crmUser.id]);
    await client.query("SET LOCAL ROLE crm_app");
    await client.query("SELECT crm.assert_app_role()");

    const result = await fn((sql, params) => client.query(sql, params));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Map a Scribe login (public.doctors.id, carried in the existing JWT) to the
 * crm.users row that CRM policies key on.
 *
 * This is the one legitimate direct-pool read in the CRM path: it resolves
 * identity, and crm.users is deliberately not FORCE'd so this lookup cannot
 * recurse into the policies that depend on its answer.
 */
export async function resolveCrmUser(scribeDoctorId) {
  if (!scribeDoctorId) return null;
  const { rows } = await pool.query(
    `SELECT id, full_name, role, manager_id
       FROM crm.users
      WHERE scribe_doctor_id = $1 AND is_active AND deleted_at IS NULL`,
    [scribeDoctorId],
  );
  return rows[0] ?? null;
}

/**
 * Express middleware. Resolves the CRM identity from the Scribe JWT that
 * authMiddleware already verified, and hands the handler a `req.crm` helper.
 * A request that is not a CRM user gets 403 before any query runs.
 */
export function crmContext() {
  return async (req, res, next) => {
    try {
      const crmUser = await resolveCrmUser(req.doctor?.doctor_id);
      if (!crmUser) {
        return res.status(403).json({ error: "Not a CRM user" });
      }
      req.crmUser = crmUser;
      req.crm = (fn) => withCrmContext(crmUser, fn);
      next();
    } catch (err) {
      next(err);
    }
  };
}
