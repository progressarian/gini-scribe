import "../loadEnv.js";
import express from "express";
import router from "../routes/ghm-appointments.js";
import pool from "../config/db.js";

const date = process.argv[2] || new Date().toISOString().split("T")[0];

const app = express();
app.use(express.json());
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();

const get = async (qs) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/ghm-appointments?${qs}`);
  const body = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body)}`);
  return body;
};

const post = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(out)}`);
  return out;
};

const REQUIRED = ["preferred_time_slot", "home_collection", "patient_id", "file_no"];

const check = async (label, body) => {
  const rows = body.data || [];
  console.log(`${label.padEnd(22)} rows ${String(rows.length).padStart(3)} / total ${body.total}`);
  if (!rows.length) return;
  const missing = REQUIRED.filter((k) => !(k in rows[0]));
  if (missing.length) throw new Error(`${label}: columns missing → ${missing.join(", ")}`);

  const pids = [...new Set(rows.map((r) => r.patient_id).filter(Boolean))];
  const lastMo = await post("/ghm-appointments/last-mo", { patient_ids: pids });
  const hit = Object.entries(lastMo)[0];
  console.log(
    `  last-mo resolved ${Object.keys(lastMo).length}/${pids.length} patients` +
      (hit ? ` e.g. patient ${hit[0]} → ${hit[1].name} (${hit[1].date})` : ""),
  );
};

try {
  await check("by_date", await get(`date=${date}&limit=20`));
  await check("followup", await get(`date=${date}&mode=followup&limit=20`));

  const name = (
    await pool.query(
      `SELECT patient_name FROM appointments WHERE patient_name <> '' ORDER BY id DESC LIMIT 1`,
    )
  ).rows[0]?.patient_name;
  if (name) {
    await check(
      `lookup "${name}"`,
      await get(`date=${date}&mode=lookup&q=${encodeURIComponent(name)}&limit=20`),
    );
  }

  await check("by_date + search", await get(`date=${date}&q=a&limit=20`));

  const all = await get(`date=${date}&limit=20`);
  const home = await get(`date=${date}&limit=20&home_collection=1`);
  console.log(
    `home filter          rows ${String(home.data.length).padStart(3)} / total ${home.total}` +
      ` (of ${all.total} unfiltered, summary says ${all.summary?.home_collection ?? "?"})`,
  );
  if (home.total > all.total) throw new Error("home filter returned more rows than unfiltered");
  if (home.data.some((r) => !r.home_collection))
    throw new Error("home filter returned a row without home_collection");
  if ((all.summary?.home_collection ?? 0) !== home.total)
    throw new Error(
      `summary.home_collection (${all.summary?.home_collection}) disagrees with filtered total (${home.total})`,
    );

  console.log("\nOK");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  server.close();
  await pool.end();
}
