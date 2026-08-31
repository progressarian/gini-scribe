// HTTP-level checks for the Gini Flow API: the capability gate and request
// validation, exercised through the running server rather than by calling the
// services directly (audit finding GF-28).
//
// Mints short-lived sessions for one admin/coordinator and one nurse, and
// revokes them in a finally — a failed assertion must not leave a live token.
//
//   API_BASE=http://localhost:3001 node scripts/smoke-giniflow-http.mjs
import "../loadEnv.js";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";

const BASE = process.env.API_BASE || "http://localhost:3001";
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const minted = [];

async function tokenFor(roles) {
  const { rows } = await pool.query(
    `SELECT id, name, short_name, specialty, role FROM doctors
      WHERE role = ANY($1) AND COALESCE(is_active, TRUE) LIMIT 1`,
    [roles],
  );
  if (!rows.length) return null;
  const d = rows[0];
  const jti = crypto.randomBytes(16).toString("hex");
  const token = jwt.sign(
    {
      doctor_id: d.id,
      doctor_name: d.name,
      short_name: d.short_name,
      specialty: d.specialty,
      role: d.role,
      jti,
    },
    process.env.JWT_SECRET,
    { expiresIn: "5m" },
  );
  await pool.query("INSERT INTO auth_sessions (doctor_id, token) VALUES ($1, $2)", [d.id, jti]);
  minted.push(jti);
  return { token, role: d.role };
}

const call = (path, token, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
  });

let fatal = null;
try {
  const manager = await tokenFor(["coordinator", "admin"]);
  const nurse = await tokenFor(["nurse"]);

  check(
    "board rejects an unauthenticated request",
    (await call("/api/giniflow/board")).status === 401,
  );

  if (manager) {
    check(
      `board is readable by ${manager.role}`,
      (await call("/api/giniflow/board", manager.token)).status === 200,
    );
    const patch = await call("/api/giniflow/sla-config", manager.token, {
      method: "PATCH",
      body: JSON.stringify({ budgets: [{ station: "doctor", budgetMinutes: 20 }] }),
    });
    check(`${manager.role} may edit budgets`, patch.status === 200, `${patch.status}`);

    const badDate = await call("/api/giniflow/board?date=31-08-2026", manager.token);
    check("malformed ?date= is rejected with 400", badDate.status === 400, `${badDate.status}`);
    const goodDate = await call("/api/giniflow/board?date=2026-08-31", manager.token);
    check("well-formed ?date= is accepted", goodDate.status === 200, `${goodDate.status}`);

    // Search is server-side, so its contract is asserted over HTTP.
    const search = await call("/api/giniflow/search?q=singh", manager.token);
    const searchBody = search.status === 200 ? await search.json() : null;
    check(
      "search returns matches",
      search.status === 200 && Array.isArray(searchBody?.results),
      `${search.status}`,
    );
    check(
      "search results carry the fields the board needs",
      !searchBody?.results?.length ||
        ["visitId", "name", "fileNo", "status"].every((k) => k in searchBody.results[0]),
    );
    check(
      "search never leaks a phone number back",
      !searchBody?.results?.length || !("phone" in searchBody.results[0]),
    );
    const shortQ = await call("/api/giniflow/search?q=a", manager.token);
    check("single-character search is rejected", shortQ.status === 400, `${shortQ.status}`);
    const noQ = await call("/api/giniflow/search", manager.token);
    check("search without a query is rejected", noQ.status === 400, `${noQ.status}`);

    const badBody = await call("/api/giniflow/sla-config", manager.token, {
      method: "PATCH",
      body: JSON.stringify({ budgets: [{ station: "doctor", budgetMinutes: -5 }] }),
    });
    check("negative budget is rejected with 400", badBody.status === 400, `${badBody.status}`);
  } else {
    check("a coordinator or admin account exists to test with", false);
  }

  if (nurse) {
    check(
      "nurse may read the board",
      (await call("/api/giniflow/board", nurse.token)).status === 200,
    );
    const denied = await call("/api/giniflow/sla-config", nurse.token, {
      method: "PATCH",
      body: JSON.stringify({ budgets: [{ station: "doctor", budgetMinutes: 25 }] }),
    });
    check("nurse is refused the budget write", denied.status === 403, `${denied.status}`);
    const nurseSearch = await call("/api/giniflow/search?q=singh", nurse.token);
    check("nurse may search the board", nurseSearch.status === 200, `${nurseSearch.status}`);
  } else {
    console.log("  -- no nurse account on this database; skipping the 403 path");
  }

  // The demo endpoints must refuse on a host without the flag, admin or not.
  if (manager && process.env.GINIFLOW_ALLOW_DEMO !== "1") {
    const seed = await call("/api/giniflow/demo/seed", manager.token, { method: "POST" });
    check(
      "demo seed refuses without GINIFLOW_ALLOW_DEMO",
      [403].includes(seed.status),
      `${seed.status}`,
    );
  }
} catch (e) {
  fatal = e;
} finally {
  for (const jti of minted) {
    await pool.query("DELETE FROM auth_sessions WHERE token = $1", [jti]).catch(() => {});
  }
  if (fatal) console.error("\nFATAL:", fatal.message || fatal);
  console.log(failures || fatal ? `\n${failures} FAILED\n` : "\nall checks passed\n");
  await pool.end();
  process.exit(failures || fatal ? 1 : 0);
}
