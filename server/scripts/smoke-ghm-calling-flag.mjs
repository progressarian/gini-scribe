import "../loadEnv.js";
import express from "express";
import router from "../routes/ghm-appointments.js";
import pool from "../config/db.js";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const who = req.headers["x-test-agent"];
  if (who) req.doctor = JSON.parse(who);
  next();
});
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();

const call = async (method, path, { agent, body } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(agent ? { "x-test-agent": JSON.stringify(agent) } : null),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

const A = { doctor_id: 90001, doctor_name: "Test Agent A", short_name: "AgentA" };
const B = { doctor_id: 90002, doctor_name: "Test Agent B", short_name: "AgentB" };

const expect = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};

const pick = await pool.query("SELECT id FROM appointments ORDER BY id DESC LIMIT 1");
const id = pick.rows[0].id;
console.log(`Using appointment #${id}`);

try {
  const claimA = await call("POST", `/ghm-appointments/${id}/calling`, { agent: A });
  expect(
    "A claims the row",
    claimA.status === 200 && claimA.body.calling_by === "AgentA",
    JSON.stringify(claimA.body),
  );

  const claimB = await call("POST", `/ghm-appointments/${id}/calling`, { agent: B });
  expect("B is blocked while A holds it", claimB.status === 409, JSON.stringify(claimB.body));

  const list = await call("POST", "/ghm-appointments/active-calls", {
    body: { appointment_ids: [id] },
  });
  expect(
    "active-calls reports A",
    list.body[id]?.calling_by === "AgentA",
    JSON.stringify(list.body),
  );

  const reclaimA = await call("POST", `/ghm-appointments/${id}/calling`, { agent: A });
  expect("A can re-claim its own row", reclaimA.status === 200);

  const relB = await call("DELETE", `/ghm-appointments/${id}/calling`, { agent: B });
  expect("B cannot release A's claim", relB.status === 403, JSON.stringify(relB.body));

  const anon = await call("POST", `/ghm-appointments/${id}/calling`);
  expect("unauthenticated claim refused", anon.status === 401);

  await pool.query(
    "UPDATE appointments SET calling_since = NOW() - INTERVAL '30 minutes' WHERE id=$1",
    [id],
  );
  const stale = await call("POST", "/ghm-appointments/active-calls", {
    body: { appointment_ids: [id] },
  });
  expect("stale claim disappears", !stale.body[id], JSON.stringify(stale.body));
  const claimBAfter = await call("POST", `/ghm-appointments/${id}/calling`, { agent: B });
  expect(
    "B claims after expiry",
    claimBAfter.status === 200 && claimBAfter.body.calling_by === "AgentB",
  );

  const relBOwn = await call("DELETE", `/ghm-appointments/${id}/calling`, { agent: B });
  expect("B releases its own claim", relBOwn.status === 200);

  const after = await call("POST", "/ghm-appointments/active-calls", {
    body: { appointment_ids: [id] },
  });
  expect("row is free again", !after.body[id], JSON.stringify(after.body));

  const listRow = await call(
    "GET",
    `/ghm-appointments?date=${new Date().toISOString().slice(0, 10)}&limit=1`,
  );
  const cols = Object.keys(listRow.body.data?.[0] || {});
  expect(
    "list exposes claim columns",
    !listRow.body.data?.length ||
      ["calling_by", "calling_by_id", "calling_since"].every((c) => cols.includes(c)),
    cols.length ? "" : "no rows today",
  );
} finally {
  await pool.query(
    "UPDATE appointments SET calling_by=NULL, calling_by_id=NULL, calling_since=NULL WHERE id=$1",
    [id],
  );
  server.close();
  await pool.end();
}
