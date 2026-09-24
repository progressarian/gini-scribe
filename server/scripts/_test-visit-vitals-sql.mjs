import "../loadEnv.js";
import express from "express";
import pool from "../config/db.js";

const planned = [];
const realQuery = pool.query.bind(pool);
pool.query = async (text, params) => {
  if (/^\s*(INSERT INTO vitals|UPDATE vitals)/i.test(text)) {
    planned.push(text.replace(/\s+/g, " ").trim().slice(0, 90));
    await realQuery(`EXPLAIN ${text.replace(/RETURNING[\s\S]*$/i, "")}`, params);
    return { rows: [{ id: 0, recorded_at: new Date() }], rowCount: 1 };
  }
  if (/SELECT id FROM vitals/i.test(text)) return { rows: [], rowCount: 0 };
  return realQuery(text, params);
};

const { default: visitRouter } = await import("../routes/visit.js");
const app = express();
app.use(express.json());
app.use("/api", visitRouter);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const body = { bp_sys: 140, bp_dia: 90, bp_standing_sys: 128, bp_standing_dia: 84, waist: 96 };

const post = await fetch(`${base}/visit/97/vitals`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
console.log("POST", post.status, JSON.stringify(await post.json()));
const patch = await fetch(`${base}/visit/97/vitals/1`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
console.log("PATCH", patch.status, JSON.stringify(await patch.json()).slice(0, 120));
console.log("planned (EXPLAIN only):");
for (const p of planned) console.log("  ", p);
server.close();
await pool.end();
process.exit(0);
