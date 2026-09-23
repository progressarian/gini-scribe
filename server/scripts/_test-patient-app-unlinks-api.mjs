import "../loadEnv.js";
import express from "express";
import pool from "../config/db.js";
import router from "../routes/patientAppUnlinks.js";
import { capabilityForPath } from "../middleware/auth.js";
import { hasCapability, CAPABILITIES } from "../../shared/permissions.js";
import { listLinkedPatients } from "../routes/patientAuth.js";
import { unlinkedIdsForPhone } from "../services/patientAppUnlinks.js";

const [viewedId, memberId] = process.argv.slice(2).map(Number);
let failed = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);
  if (!ok) failed++;
};

const cap = capabilityForPath("/api/patient-app-unlinks/family");
check("route is gated to ADMIN", cap === CAPABILITIES.ADMIN, String(cap));
for (const role of ["reception", "consultant", "mo", "nurse", "obt"])
  check(`${role} cannot use it`, !hasCapability(role, cap));
check("admin can use it", hasCapability("admin", cap));

const { rows: admins } = await pool.query(
  `SELECT id FROM doctors WHERE role = 'admin' AND COALESCE(is_active, TRUE) ORDER BY id LIMIT 1`,
);
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.doctor = { doctor_id: admins[0]?.id ?? null, role: "admin" };
  next();
});
app.use("/api", router);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (method, path, body) => {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

let unlinkId = null;
try {
  const fam = await call("GET", `/patient-app-unlinks/family?patientId=${viewedId}`);
  check("GET family 200", fam.status === 200, String(fam.status));
  const phone = fam.json.phone;
  const member = fam.json.members.find((m) => m.id === String(memberId));
  check("member listed and linked", member && !member.unlinked);

  check(
    "bad body → 400",
    (await call("POST", "/patient-app-unlinks", { patientId: viewedId })).status === 400,
  );
  check(
    "unknown member → 404",
    (
      await call("POST", "/patient-app-unlinks", {
        patientId: viewedId,
        source: "hospital",
        memberId: "999999999",
        reason: "test run",
        requestedBy: "tester",
      })
    ).status === 404,
  );

  const body = {
    patientId: viewedId,
    source: "hospital",
    memberId: String(memberId),
    reason: "api test run",
    requestedBy: "automated test",
  };
  const [a, b] = await Promise.all([
    call("POST", "/patient-app-unlinks", body),
    call("POST", "/patient-app-unlinks", body),
  ]);
  const statuses = [a.status, b.status].sort();
  check(
    "two simultaneous removals → one 200, one 409",
    statuses[0] === 200 && statuses[1] === 409,
    statuses.join(","),
  );
  unlinkId = (a.status === 200 ? a : b).json?.id ?? null;

  const ids = (await listLinkedPatients("hospital", phone)).map((p) => Number(p.id));
  check("removed member gone from app family list", !ids.includes(memberId), ids.join(","));
  check("viewed patient still in app family list", ids.includes(viewedId));
  const un = await unlinkedIdsForPhone(phone);
  check("lookup reports the removal", un.hospital.has(memberId));

  const { rows: resolved } = await pool.query(
    `SELECT id FROM patients
      WHERE (right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1)
        AND NOT (id = ANY($2::int[])) ORDER BY id`,
    [phone.replace(/\D/g, "").slice(-10), [...un.hospital]],
  );
  check("login lookup can no longer land on the member", !resolved.some((r) => r.id === memberId));

  const last = await call("POST", "/patient-app-unlinks", { ...body, memberId: String(viewedId) });
  check(
    "removing the last linked profile → 409",
    last.status === 409,
    `${last.status} ${last.json?.error || ""}`,
  );

  const fam2 = await call("GET", `/patient-app-unlinks/family?patientId=${viewedId}`);
  const m2 = fam2.json.members.find((m) => m.id === String(memberId));
  check(
    "admin view shows member as removed with history",
    m2?.unlinked && m2.lastChange?.requestedBy === "automated test",
  );

  const re = await call("POST", `/patient-app-unlinks/${unlinkId}/relink`);
  const [x, y] = await Promise.all([
    call("POST", "/patient-app-unlinks", body),
    call("POST", "/patient-app-unlinks", { ...body, memberId: String(viewedId) }),
  ]);
  const both = [x.status, y.status].sort();
  check(
    "removing both members at once leaves one → one 200, one 409",
    both[0] === 200 && both[1] === 409,
    both.join(","),
  );
  const stillLinked = (await listLinkedPatients("hospital", phone)).length;
  check("phone keeps at least one profile", stillLinked >= 1, String(stillLinked));
  for (const r of [x, y])
    if (r.status === 200) await call("POST", `/patient-app-unlinks/${r.json.id}/relink`);
  check("restore 200", re.status === 200, String(re.status));
  const re2 = await call("POST", `/patient-app-unlinks/${unlinkId}/relink`);
  check("restoring twice → 404", re2.status === 404, String(re2.status));
  const ids2 = (await listLinkedPatients("hospital", phone)).map((p) => Number(p.id));
  check("member back in app family list", ids2.includes(memberId));
} finally {
  server.close();
  const del = await pool.query(
    `DELETE FROM patient_app_unlinks WHERE requested_by = 'automated test' AND patient_id = ANY($1::int[]) RETURNING id`,
    [[memberId, viewedId]],
  );
  console.log(`cleanup: removed ${del.rowCount} test row(s)`);
  await pool.end();
}
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
