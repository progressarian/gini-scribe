// Who may work the machine room, over HTTP
// (docs/gini-flow/36-MACHINE-TEST-STATION-PLAN.md §6.3).
//
// Nothing here writes. Refusals are proven against an id that does not exist, so
// the gate answers before any row is touched; permissions that should PASS are
// proven with a deliberately invalid body — a 400 means the request reached
// validation, which means the gate let it through.
//
//   API_BASE=http://localhost:3001 node scripts/smoke-machine-access.mjs
import "../loadEnv.js";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";
import { MACHINE_RUNGS } from "../../shared/machineStages.js";

const BASE = process.env.API_BASE || "http://localhost:3001";
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const minted = [];
const probes = [];

// A role with nobody in it yet cannot be tested, and "skipped" is not a pass.
// So a role that has no account gets a DISABLED probe for the length of the run:
// `is_active = FALSE` keeps it off the login screen and out of every list, while
// the capability checks — which key off the role, not the flag — still exercise
// the real gates. Removed in the finally, whatever happens.
async function tokenFor(role) {
  let { rows } = await pool.query(
    `SELECT id, name, short_name, role FROM doctors
      WHERE role = $1 AND COALESCE(is_active, TRUE) LIMIT 1`,
    [role],
  );
  if (!rows.length) {
    const made = await pool.query(
      `INSERT INTO doctors (name, short_name, role, is_active)
       VALUES ($1, $1, $2, FALSE) RETURNING id, name, short_name, role`,
      [`ZZ probe ${role}`, role],
    );
    probes.push(made.rows[0].id);
    rows = made.rows;
    console.log(`  --   no ${role} account — using a disabled probe for this run`);
  }
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

const NO_ORDER = "00000000-0000-4000-8000-000000000000";

let fatal = null;
try {
  const ROLES = [
    { role: "machine_tech", may: true },
    { role: "admin", may: true },
    { role: "tech", may: false },
    { role: "lab", may: false },
    { role: "lab_admin", may: false },
    { role: "coordinator", may: false },
    { role: "nurse", may: false },
  ];

  const holders = [];
  for (const r of ROLES) {
    const who = await tokenFor(r.role);
    if (!who) continue;
    holders.push({ ...r, token: who.token });
  }

  console.log("\n── The queue ───────────────────────────────────────────────");
  for (const h of holders) {
    const res = await call("/api/giniflow/stations/machine/queue", h.token);
    check(
      `${h.role} ${h.may ? "may open" : "is refused"} the machine room`,
      h.may ? res.status === 200 : res.status === 403,
      `${res.status}`,
    );
  }

  console.log("\n── Every rung ──────────────────────────────────────────────");
  for (const h of holders) {
    for (const rung of MACHINE_RUNGS.filter((r) => r.advanceTo)) {
      const res = await call(`/api/giniflow/stations/machine/${NO_ORDER}/advance`, h.token, {
        method: "POST",
        body: JSON.stringify({ to: rung.advanceTo }),
      });
      check(
        `${h.role} ${h.may ? "owns" : "is refused"} "${rung.advanceTo}"`,
        h.may ? res.status !== 403 : res.status === 403,
        `${res.status}`,
      );
    }
  }

  console.log("\n── Reports and reconciliation ──────────────────────────────");
  for (const h of holders) {
    const rep = await call(`/api/giniflow/stations/machine/${NO_ORDER}/report`, h.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    check(
      `${h.role} ${h.may ? "may file" : "cannot file"} a machine report`,
      h.may ? rep.status === 400 : rep.status === 403,
      `${rep.status}`,
    );
    const rec = await call("/api/giniflow/stations/machine/reconciliation", h.token);
    check(
      `${h.role} ${h.may ? "sees" : "cannot see"} the reconciliation`,
      h.may ? rec.status === 200 : rec.status === 403,
      `${rec.status}`,
    );
  }

  console.log("\n── Neither room writes the other's results ─────────────────");
  // The machine room holds the results endpoints too, but only for its own
  // orders — proven against a real lab order, which must be refused.
  const { rows: labOrder } = await pool.query(
    `SELECT id FROM giniflow_lab_orders WHERE kind = 'lab' LIMIT 1`,
  );
  const machineTech = holders.find((h) => h.role === "machine_tech");
  if (labOrder.length && machineTech) {
    const res = await call(`/api/giniflow/lab/${labOrder[0].id}/results`, machineTech.token, {
      method: "POST",
      body: JSON.stringify({ rows: [{ testName: "ABI Right", value: 1 }] }),
    });
    check(
      "the machine room cannot record values on a lab order",
      res.status === 403,
      `${res.status} ${res.body?.error ?? ""}`,
    );
  }

  console.log("\n── The lab queue is free of machine tests ──────────────────");
  const admin = holders.find((h) => h.role === "admin");
  if (admin) {
    const lab = await call("/api/giniflow/stations/lab/queue", admin.token);
    const buckets = [
      "pending",
      "collecting",
      "sent",
      "received",
      "processing",
      "ready",
      "uploaded",
    ];
    const rows = buckets.flatMap((b) => lab.body?.[b] || []);
    check(
      "no machine test appears on the lab queue",
      rows.every((r) => !/^(abi|vpt|fundus|tmt|ecg)$/i.test((r.tests || [])[0]?.name || "")),
      `${rows.length} gini rows`,
    );
  }
} catch (e) {
  fatal = e;
} finally {
  if (minted.length) await pool.query(`DELETE FROM auth_sessions WHERE token = ANY($1)`, [minted]);
  if (probes.length) {
    await pool.query(`DELETE FROM auth_sessions WHERE doctor_id = ANY($1::int[])`, [probes]);
    await pool.query(`DELETE FROM doctors WHERE id = ANY($1::int[])`, [probes]);
    const { rows: left } = await pool.query(
      `SELECT count(*)::int n FROM doctors WHERE id = ANY($1::int[])`,
      [probes],
    );
    console.log(`\n  ${left[0].n === 0 ? "ok " : "FAIL"}  the probe accounts left no trace`);
    if (left[0].n !== 0) failures++;
  }
  await pool.end();
}

if (fatal) {
  console.error(fatal);
  process.exit(1);
}
console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
