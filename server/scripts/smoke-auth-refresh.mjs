/**
 * Smoke test for access/refresh token auth (docs/ACCESS_REFRESH_TOKEN_AUTH_PLAN.md).
 *
 * Exercises server/services/refreshTokens.js directly against the REAL
 * database — issue, rotate, reuse-detection, family-revoke, expiry. Every row
 * this script writes is deleted again at the end (by family_id), regardless
 * of pass/fail, since the service module doesn't accept a shared transaction
 * client (each call gets its own pool connection).
 *
 * Run (from gini-scribe/server):
 *   node scripts/smoke-auth-refresh.mjs   (or: npm run smoke:auth-refresh)
 *
 * Exit code 0 = all checks passed, 1 = something failed.
 */
import "../loadEnv.js";
import pool from "../config/db.js";
import {
  issueDoctorRefreshToken,
  lookupRefreshToken,
  revokeFamily,
  rotateRefreshToken,
} from "../services/refreshTokens.js";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  \x1b[31m✗ ${m}\x1b[0m`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function main() {
  section("1. Fixture doctor");
  const docs = await pool.query("SELECT id FROM doctors WHERE is_active ORDER BY id LIMIT 1");
  if (!docs.rows.length) {
    bad("no active doctors found — cannot exercise doctor-kind refresh tokens");
    return;
  }
  const doctorId = docs.rows[0].id;
  ok(`using doctor id ${doctorId}`);

  const cleanupFamilies = new Set();

  try {
    section("2. Issue + lookup");
    const t1 = await issueDoctorRefreshToken(doctorId, {
      userAgent: "smoke-test",
      ip: "127.0.0.1",
    });
    const l1 = await lookupRefreshToken(t1);
    l1.ok
      ? ok("freshly issued token looks up ok:true")
      : bad(`expected ok:true, got ${JSON.stringify(l1)}`);
    if (l1.ok) cleanupFamilies.add(l1.row.family_id);

    section("3. Rotation");
    const t2 = await rotateRefreshToken(l1.row);
    const l1Again = await lookupRefreshToken(t1);
    // Immediately re-presenting the just-rotated token is exactly what two
    // browser tabs racing a refresh looks like — tolerated within the grace
    // window (server/services/refreshTokens.js REUSE_GRACE_MS), not treated
    // as theft. See section 4b for the "beyond the grace window" case.
    l1Again.ok && l1Again.graceReuse
      ? ok("rotated-out token presented immediately after → tolerated (graceReuse:true)")
      : bad(`expected ok:true graceReuse:true, got ${JSON.stringify(l1Again)}`);
    const l2 = await lookupRefreshToken(t2);
    l2.ok && l2.row.family_id === l1.row.family_id
      ? ok("new token is valid and shares the same family_id")
      : bad(`expected valid token in same family, got ${JSON.stringify(l2)}`);

    section("4a. Genuine reuse (beyond the grace window) revokes the whole family");
    // Simulate the grace window having elapsed by backdating revoked_at —
    // this is what presenting a token stolen hours/days ago looks like.
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() - INTERVAL '1 hour' WHERE id=$1`,
      [l1.row.id],
    );
    const l1Stale = await lookupRefreshToken(t1);
    !l1Stale.ok && l1Stale.reason === "reused"
      ? ok("token revoked over an hour ago now reports reason:'reused' (not tolerated)")
      : bad(`expected reason:'reused', got ${JSON.stringify(l1Stale)}`);

    // The caller (route handler) is expected to call revokeFamily() when it
    // sees reason:'reused', exactly like this:
    await revokeFamily(l1Stale.row.family_id);
    const l2AfterRevoke = await lookupRefreshToken(t2);
    !l2AfterRevoke.ok && l2AfterRevoke.reason === "reused"
      ? ok("4b. the live token in the family is also revoked (whole chain killed)")
      : bad(
          `expected the family's live token to be revoked too, got ${JSON.stringify(l2AfterRevoke)}`,
        );

    section("5. Expired token");
    const t3 = await issueDoctorRefreshToken(doctorId);
    const l3 = await lookupRefreshToken(t3);
    if (l3.ok) cleanupFamilies.add(l3.row.family_id);
    await pool.query(
      `UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE id=$1`,
      [l3.row.id],
    );
    const l3Expired = await lookupRefreshToken(t3);
    !l3Expired.ok && l3Expired.reason === "expired"
      ? ok("manually-expired token reports reason:'expired'")
      : bad(`expected reason:'expired', got ${JSON.stringify(l3Expired)}`);

    section("6. Unknown token");
    const lUnknown = await lookupRefreshToken("not-a-real-token");
    !lUnknown.ok && lUnknown.reason === "not_found"
      ? ok("garbage token reports reason:'not_found'")
      : bad(`expected reason:'not_found', got ${JSON.stringify(lUnknown)}`);
  } finally {
    section("Cleanup");
    for (const familyId of cleanupFamilies) {
      await pool.query("DELETE FROM refresh_tokens WHERE family_id=$1", [familyId]);
    }
    ok(
      `removed ${cleanupFamilies.size} test rotation famil${cleanupFamilies.size === 1 ? "y" : "ies"}`,
    );
  }

  section("Result");
  console.log(
    failures === 0
      ? "  \x1b[32mAll checks passed.\x1b[0m"
      : `  \x1b[31m${failures} check(s) failed.\x1b[0m`,
  );
}

main()
  .catch((e) => {
    console.error("\x1b[31mSMOKE TEST CRASHED:\x1b[0m", e.message || e);
    failures++;
  })
  .finally(async () => {
    await pool.end();
    process.exit(failures === 0 ? 0 : 1);
  });
