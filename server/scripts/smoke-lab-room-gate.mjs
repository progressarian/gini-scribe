// Who may work which lab bench, over HTTP
// (docs/gini-flow/35-LAB-TWO-ROOM-SPLIT-PLAN.md §3.3, §3.5).
//
// The rule that matters: the room a request works in is derived from the ROLE,
// never read off the request. A collection technician who omits `room` must not
// fall through to the combined view and gain the analyzer bench with it.
//
// Mints short-lived sessions and revokes them in a finally, the same way
// smoke-giniflow-http.mjs does — a failed assertion must not leave a live token.
//
//   API_BASE=http://localhost:3001 node scripts/smoke-lab-room-gate.mjs
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

async function tokenFor(role) {
  const { rows } = await pool.query(
    `SELECT id, name, short_name, specialty, role FROM doctors
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
  return { token, role: d.role };
}

const call = async (path, token, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-auth-token": token },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

let fatal = null;
try {
  // Single-room roles only. lab_admin holds both benches, so it has nothing to
  // be refused here — smoke-lab-room-access.mjs covers it in full.
  const ROOMS = [
    { role: "tech", own: "collection", other: "processing" },
    { role: "lab", own: "collection", other: "processing" },
  ];

  for (const c of ROOMS) {
    const who = await tokenFor(c.role);
    if (!who) {
      console.log(`  --   no ${c.role} account on this database — skipped`);
      continue;
    }
    const own = await call(`/api/giniflow/stations/lab/queue?room=${c.own}`, who.token);
    check(`${c.role} may open its own room (${c.own})`, own.status === 200, `${own.status}`);
    check(`${c.role}'s queue is scoped to it`, own.body?.room === c.own, `room=${own.body?.room}`);

    const foreign = await call(`/api/giniflow/stations/lab/queue?room=${c.other}`, who.token);
    check(`${c.role} is refused the ${c.other} room`, foreign.status === 403, `${foreign.status}`);

    // The escalation this exists to stop: asking for no room at all.
    const bare = await call(`/api/giniflow/stations/lab/queue`, who.token);
    check(
      `${c.role} omitting the room still gets only ${c.own}`,
      bare.body?.room === c.own,
      `room=${bare.body?.room}`,
    );
  }

  // The write side of the same rule. `assertRoomOwns` runs before the order is
  // even looked up, so a made-up id proves the refusal without touching a row.
  const NOWHERE = "00000000-0000-4000-8000-000000000000";
  for (const c of ROOMS) {
    const who = await tokenFor(c.role);
    if (!who) continue;
    const foreignRung = c.own === "collection" ? "processing" : "sample_collected";
    const refused = await call(`/api/giniflow/stations/lab/${NOWHERE}/advance`, who.token, {
      method: "POST",
      body: JSON.stringify({ to: foreignRung }),
    });
    check(
      `${c.role} cannot advance a sample to "${foreignRung}" — the other room owns it`,
      refused.status === 403,
      `${refused.status} ${refused.body?.error ?? ""}`,
    );
    const ownRung = c.own === "collection" ? "sample_collected" : "processing";
    const allowed = await call(`/api/giniflow/stations/lab/${NOWHERE}/advance`, who.token, {
      method: "POST",
      body: JSON.stringify({ to: ownRung }),
    });
    check(
      `${c.role} gets past the room rule for its own "${ownRung}"`,
      allowed.status !== 403,
      `${allowed.status} (a missing order, not a refused room)`,
    );
  }

  const both = (await tokenFor("admin")) || (await tokenFor("coordinator"));
  if (both) {
    const all = await call(`/api/giniflow/stations/lab/queue`, both.token);
    check(`${both.role} keeps the combined all-day view`, all.body?.room === null, `${all.status}`);
    for (const room of ["collection", "processing"]) {
      const one = await call(`/api/giniflow/stations/lab/queue?room=${room}`, both.token);
      check(`${both.role} may narrow to ${room}`, one.body?.room === room, `${one.status}`);
    }
  }

  const nurse = await tokenFor("nurse");
  if (nurse) {
    const denied = await call(`/api/giniflow/stations/lab/queue?room=collection`, nurse.token);
    check(
      "a role with no lab access is refused outright",
      denied.status === 403,
      `${denied.status}`,
    );
  }
} catch (e) {
  fatal = e;
} finally {
  if (minted.length) {
    await pool.query(`DELETE FROM auth_sessions WHERE token = ANY($1)`, [minted]);
  }
  await pool.end();
}

if (fatal) {
  console.error(fatal);
  process.exit(1);
}
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
