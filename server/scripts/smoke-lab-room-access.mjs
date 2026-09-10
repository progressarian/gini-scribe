// The full access surface of the two lab rooms, over HTTP
// (docs/gini-flow/35-LAB-TWO-ROOM-SPLIT-PLAN.md §3.3, §3.5).
//
// Every lab endpoint, every role, both rooms. Two rules under test:
//
//   1. The room is derived from the ROLE, never read off the request — omitting
//      `room` must not hand a collection technician the analyzer bench.
//   2. Recording a RESULT (typed values or a file) is the analyzer bench's work,
//      whatever the screen happens to show. Hiding a control is not enforcing it.
//
// Nothing here writes. Refusals are proven with a valid body against an id that
// does not exist, so the gate answers before any row is touched; permissions
// that should PASS are proven with a deliberately invalid body — a 400 means the
// request reached validation, which means the gate let it through.
//
//   API_BASE=http://localhost:3001 node scripts/smoke-lab-room-access.mjs
import "../loadEnv.js";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";
import { LAB_RUNGS, visibleRungs } from "../../shared/labStages.js";

const BASE = process.env.API_BASE || "http://localhost:3001";
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const minted = [];
async function tokenFor(role) {
  const { rows } = await pool.query(
    `SELECT id, name, short_name, role FROM doctors
      WHERE role = $1 AND COALESCE(is_active, TRUE) LIMIT 1`,
    [role],
  );
  if (!rows.length) return null;
  const d = rows[0];
  const jti = crypto.randomBytes(16).toString("hex");
  const token = jwt.sign(
    { doctor_id: d.id, doctor_name: d.name, short_name: d.short_name, role: d.role, jti },
    process.env.JWT_SECRET,
    { expiresIn: "5m" },
  );
  await pool.query("INSERT INTO auth_sessions (doctor_id, token) VALUES ($1, $2)", [d.id, jti]);
  minted.push(jti);
  return { token, role };
}

const call = async (path, token, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { "x-auth-token": token } : {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

// Ids that cannot match a row, so a request that gets past its gate dies in a
// lookup rather than changing anything.
const NO_ORDER = "00000000-0000-4000-8000-000000000000";
const NO_CASE = "smoke-no-such-case";

let fatal = null;
try {
  const ROLES = [
    { role: "tech", room: "collection" },
    { role: "lab", room: "collection" },
    { role: "lab_admin", room: "processing" },
    { role: "coordinator", room: "both" },
    { role: "admin", room: "both" },
  ];

  const holders = [];
  for (const r of ROLES) {
    const who = await tokenFor(r.role);
    if (!who) {
      console.log(`  --   no ${r.role} account on this database — skipped`);
      continue;
    }
    holders.push({ ...r, token: who.token });
  }

  const owns = (h, room) => h.room === "both" || h.room === room;

  console.log("\n── Which room a role is put in ──────────────────────────────");
  for (const h of holders) {
    for (const room of ["collection", "processing"]) {
      const res = await call(`/api/giniflow/stations/lab/queue?room=${room}`, h.token);
      const want = owns(h, room);
      check(
        `${h.role} ${want ? "may open" : "is refused"} the ${room} room`,
        want ? res.status === 200 && res.body?.room === room : res.status === 403,
        `${res.status}${res.body?.room ? ` room=${res.body.room}` : ""}`,
      );
    }
    const bare = await call(`/api/giniflow/stations/lab/queue`, h.token);
    check(
      h.room === "both"
        ? `${h.role} asking for no room gets the whole day`
        : `${h.role} asking for no room still gets only ${h.room}`,
      bare.body?.room === (h.room === "both" ? null : h.room),
      `room=${bare.body?.room}`,
    );
  }

  console.log("\n── Every rung, advanced from every room ─────────────────────");
  for (const h of holders) {
    for (const rung of LAB_RUNGS.slice(1)) {
      const res = await call(`/api/giniflow/stations/lab/${NO_ORDER}/advance`, h.token, {
        method: "POST",
        body: JSON.stringify({ to: rung.advanceTo }),
      });
      const want = owns(h, rung.room);
      check(
        `${h.role} ${want ? "owns" : "is refused"} "${rung.advanceTo}" (${rung.room} room)`,
        want ? res.status !== 403 : res.status === 403,
        `${res.status}`,
      );
    }
  }

  console.log("\n── Every case action, from every room ───────────────────────");
  for (const h of holders) {
    for (const rung of LAB_RUNGS.filter((r) => r.floorAction)) {
      const res = await call(`/api/giniflow/stations/lab/case/${NO_CASE}/action`, h.token, {
        method: "POST",
        body: JSON.stringify({ action: rung.action }),
      });
      const want = owns(h, rung.room);
      check(
        `${h.role} ${want ? "owns" : "is refused"} "${rung.action}"`,
        want ? res.status !== 403 : res.status === 403,
        `${res.status}`,
      );
    }
  }

  console.log("\n── Recording a result is the bench's work ───────────────────");
  // Deliberately invalid bodies: 400 proves the gate passed, 403 proves it did not.
  const BENCH_ONLY = [
    { path: `/api/giniflow/lab/${NO_ORDER}/results`, what: "typed results on an order" },
    { path: `/api/giniflow/lab/case/${NO_CASE}/results`, what: "typed results on a case" },
    { path: `/api/giniflow/stations/lab/${NO_ORDER}/report`, what: "a report on an order" },
  ];
  for (const h of holders) {
    for (const ep of BENCH_ONLY) {
      const res = await call(ep.path, h.token, { method: "POST", body: JSON.stringify({}) });
      const want = owns(h, "processing");
      check(
        `${h.role} ${want ? "may record" : "cannot record"} ${ep.what}`,
        want ? res.status === 400 : res.status === 403,
        `${res.status}`,
      );
    }
    // Attaching a file to a HealthRay-run case overrides the sync, so it stays
    // admin-only on top of the room rule.
    const override = await call(`/api/giniflow/stations/lab/case/${NO_CASE}/report`, h.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    check(
      `${h.role} ${h.role === "admin" ? "may" : "cannot"} override a case report`,
      h.role === "admin" ? override.status === 400 : override.status === 403,
      `${override.status}`,
    );
  }

  console.log("\n── Reading is open to both rooms ────────────────────────────");
  for (const h of holders) {
    const names = await call(`/api/giniflow/lab/test-names?q=cre`, h.token);
    check(`${h.role} may search test names`, names.status === 200, `${names.status}`);
  }

  console.log("\n── Filters offer only that room's rungs ─────────────────────");
  for (const h of holders.filter((x) => x.room !== "both")) {
    const mine = visibleRungs(h.room);
    const theirs = LAB_RUNGS.filter((r) => !mine.some((m) => m.key === r.key));
    for (const rung of mine) {
      const res = await call(
        `/api/giniflow/stations/lab/queue?room=${h.room}&group=${rung.filter}`,
        h.token,
      );
      check(
        `${h.role} may filter to "${rung.filter}"`,
        res.body?.group === rung.filter && Array.isArray(res.body?.[rung.bucket]),
        `group=${res.body?.group}`,
      );
    }
    for (const rung of theirs) {
      const res = await call(
        `/api/giniflow/stations/lab/queue?room=${h.room}&group=${rung.filter}`,
        h.token,
      );
      check(
        `${h.role} filtering to the other room's "${rung.filter}" falls back to All`,
        res.body?.group === "all",
        `group=${res.body?.group}`,
      );
    }
    const shape = await call(`/api/giniflow/stations/lab/queue?room=${h.room}`, h.token);
    check(
      `${h.role}'s queue carries only its own buckets`,
      mine.every((r) => Array.isArray(shape.body?.[r.bucket])) &&
        theirs.every((r) => shape.body?.[r.bucket] === undefined),
      mine.map((r) => r.bucket).join(","),
    );
    check(
      `${h.role}'s stat strip lists only its own rungs`,
      (shape.body?.stages || []).map((s) => s.key).join(",") === mine.map((r) => r.key).join(","),
      (shape.body?.stages || []).map((s) => s.key).join(","),
    );
  }

  console.log("\n── No lab access at all ─────────────────────────────────────");
  const nurse = await tokenFor("nurse");
  if (nurse) {
    for (const path of [
      "/api/giniflow/stations/lab/queue",
      "/api/giniflow/stations/lab/queue?room=collection",
      "/api/giniflow/stations/lab/queue?room=processing",
      `/api/giniflow/lab/${NO_ORDER}/results`,
    ]) {
      const res = await call(
        path,
        nurse.token,
        path.endsWith("results") ? { method: "POST", body: "{}" } : {},
      );
      check(
        `nurse is refused ${path.replace("/api/giniflow", "")}`,
        res.status === 403,
        `${res.status}`,
      );
    }
  }
} catch (e) {
  fatal = e;
} finally {
  if (minted.length) await pool.query(`DELETE FROM auth_sessions WHERE token = ANY($1)`, [minted]);
  await pool.end();
}

if (fatal) {
  console.error(fatal);
  process.exit(1);
}
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
