import "../loadEnv.js";
import express from "express";
import pool from "../config/db.js";

let scenario = {};
const log = [];
const realQuery = pool.query.bind(pool);
pool.query = async (text, params) => {
  const t = text.replace(/\s+/g, " ").trim();
  if (/^UPDATE patient_vitals_log/i.test(t)) {
    log.push("app-update");
    await realQuery(`EXPLAIN ${text.replace(/RETURNING[\s\S]*$/i, "")}`, params);
    return scenario.appRowExists ? { rows: [{ id: 1, genie_id: null }] } : { rows: [] };
  }
  if (/^SELECT id FROM vitals WHERE patient_id = \$1 AND \(recorded_at/i.test(t)) {
    log.push("find-today");
    return { rows: scenario.todayRow ? [{ id: 123 }] : [] };
  }
  if (/^(INSERT INTO vitals|UPDATE vitals)/i.test(t)) {
    log.push(
      /^INSERT/i.test(t)
        ? `clinic-insert ${JSON.stringify(params)}`
        : `clinic-update ${JSON.stringify(params)}`,
    );
    await realQuery(`EXPLAIN ${text}`, params);
    return { rows: [] };
  }
  return realQuery(text, params);
};

const { default: visitRouter } = await import("../routes/visit.js");
const app = express();
app.use(express.json());
app.use("/api", visitRouter);
const server = app.listen(0);
const call = async (body) => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/visit/97/app-vitals/1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.status;
};

let bad = 0;
const run = async (label, sc, body, expectStatus, expectLog) => {
  scenario = sc;
  log.length = 0;
  const status = await call(body);
  const ok =
    status === expectStatus &&
    expectLog.every((p, i) => (log[i] || "").startsWith(p)) &&
    log.length === expectLog.length;
  if (!ok) bad++;
  console.log(ok ? "PASS" : "FAIL", label, `→ ${status}`, JSON.stringify(log));
};

await run(
  "standing only, no clinic row today → new clinic row",
  { appRowExists: true, todayRow: false },
  { bp_standing_sys: 128, bp_standing_dia: 84 },
  200,
  ["clinic-insert"],
);
await run(
  "standing + weight, clinic row today → app updated, clinic row updated",
  { appRowExists: true, todayRow: true },
  { weight: 80, bp_standing_sys: 128, bp_standing_dia: 84 },
  200,
  ["app-update", "find-today", "clinic-update"],
);
await run(
  "app reading missing → 404, standing NOT saved",
  { appRowExists: false, todayRow: true },
  { weight: 80, bp_standing_sys: 128, bp_standing_dia: 84 },
  404,
  ["app-update"],
);
await run(
  "standing left blank, no clinic row → nothing written",
  { appRowExists: true, todayRow: false },
  { weight: 80, bp_standing_sys: "", bp_standing_dia: "" },
  200,
  ["app-update", "find-today"],
);
await run(
  "no standing in the edit → clinic table untouched",
  { appRowExists: true, todayRow: true },
  { weight: 80 },
  200,
  ["app-update"],
);

console.log(bad ? `${bad} failed` : "all passed");
server.close();
await pool.end();
process.exit(0);
