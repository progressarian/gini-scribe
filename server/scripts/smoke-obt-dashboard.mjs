import "../loadEnv.js";
import express from "express";
import router from "../routes/obt-dashboard.js";
import pool from "../config/db.js";

const date = process.argv[2] || new Date(Date.now() + 86400000).toISOString().split("T")[0];

const app = express();
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();

try {
  const r = await fetch(`http://127.0.0.1:${port}/api/obt-dashboard?date=${date}`);
  const body = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body)}`);

  console.log(`date ${body.date}`);
  console.log("summary  ", body.summary);
  console.log("visitType", body.visitTypes);

  const s = body.summary;
  const calls =
    s.not_called +
    s.spoke +
    s.not_picked +
    s.rescheduled +
    s.call_later +
    s.unreachable +
    s.no_call_needed;
  if (calls !== s.total) throw new Error(`call buckets ${calls} != total ${s.total}`);

  const visits = body.visitTypes.reduce((n, v) => n + v.count, 0);
  if (visits !== s.total) throw new Error(`visit types ${visits} != total ${s.total}`);

  if (s.need_call !== s.not_called + s.not_picked + s.call_later + s.unreachable)
    throw new Error("need_call does not match its open-call buckets");

  console.log("\nOK");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  server.close();
  await pool.end();
}
