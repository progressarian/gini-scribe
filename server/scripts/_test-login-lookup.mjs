import "../loadEnv.js";
import express from "express";
import pool from "../config/db.js";
import { unlinkFamilyMember, relinkFamilyMember } from "../services/patientAppUnlinks.js";

const phone = "1234567890";
const [viewedId, removeId] = [97, 235];
const landed = [];
const realQuery = pool.query.bind(pool);
pool.query = async (text, params) => {
  const r = await realQuery(text, params);
  if (/SELECT \* FROM patients/i.test(text) && /LIMIT 1/i.test(text))
    landed.push(...r.rows.map((x) => x.id));
  return r;
};
const { default: authRouter } = await import("../routes/patientAuth.js");
const app = express();
app.use(express.json());
app.use("/api", authRouter);
const server = app.listen(0);
const check = async () => {
  landed.length = 0;
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/patient/auth/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  return { status: r.status, body: await r.json(), landed: [...landed] };
};

let failed = 0;
const say = (label, ok, extra) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (${extra})`);
  if (!ok) failed++;
};
let unlinkId;
try {
  const before = await check();
  say(
    "login lookup works before removal",
    before.status === 200 && before.body.exists,
    `landed on ${before.landed}`,
  );
  ({ id: unlinkId } = await unlinkFamilyMember(
    {
      patientId: viewedId,
      source: "hospital",
      memberId: String(removeId),
      reason: "login lookup test",
      requestedBy: "automated test",
    },
    null,
  ));
  const after = await check();
  say(
    "login never lands on the removed member",
    after.status === 200 && !after.landed.includes(removeId),
    `landed on ${after.landed}`,
  );
  say(
    "login lands on the remaining member",
    after.landed.includes(viewedId),
    `landed on ${after.landed}`,
  );
} finally {
  if (unlinkId) await relinkFamilyMember(unlinkId, null);
  const del = await realQuery(
    `DELETE FROM patient_app_unlinks WHERE requested_by = 'automated test' AND phone_last10 = $1 RETURNING id`,
    [phone],
  );
  console.log(`cleanup: removed ${del.rowCount} test row(s)`);
  server.close();
  await pool.end();
}
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
