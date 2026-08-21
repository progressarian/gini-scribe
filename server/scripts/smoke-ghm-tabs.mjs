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
  return { status: r.status, body: await r.json() };
};

const expect = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};

const isNew = (v) =>
  String(v || "")
    .toLowerCase()
    .startsWith("new");

try {
  const all = await get(`date=${date}&limit=100&page=1&export=1`);
  const rows = all.body.data || [];
  console.log(`Day list for ${date}: ${rows.length} rows`);

  const fresh = await get(`date=${date}&limit=100&page=1&export=1&visit=new`);
  expect(
    "New Patients tab returns only new visits",
    fresh.status === 200 && (fresh.body.data || []).every((r) => isNew(r.visit_type)),
    `${fresh.body.data?.length} rows`,
  );

  const fu = await get(`date=${date}&limit=100&page=1&export=1&visit=followup`);
  expect(
    "Follow-Up tab returns only non-new visits with a type",
    fu.status === 200 && (fu.body.data || []).every((r) => r.visit_type && !isNew(r.visit_type)),
    `${fu.body.data?.length} rows`,
  );

  const untyped = rows.filter((r) => !r.visit_type).length;
  expect(
    "New + Follow-up covers the day (minus rows with no visit type)",
    (fresh.body.data?.length || 0) + (fu.body.data?.length || 0) === rows.length - untyped,
    `${fresh.body.data?.length} + ${fu.body.data?.length} vs ${rows.length} - ${untyped} untyped`,
  );

  // Seed one row per status so the tabs are tested with something in them,
  // then put the original values back.
  const seed = rows.slice(0, 2);
  const restore = new Map();
  for (const [i, st] of ["cancelled", "rescheduled"].entries()) {
    if (!seed[i]) continue;
    const prev = await pool.query("SELECT call_status FROM appointments WHERE id=$1", [seed[i].id]);
    restore.set(seed[i].id, prev.rows[0]?.call_status ?? null);
    await pool.query("UPDATE appointments SET call_status=$2 WHERE id=$1", [seed[i].id, st]);
  }

  try {
    for (const [i, st] of ["cancelled", "rescheduled"].entries()) {
      const r = await get(`date=${date}&limit=100&page=1&export=1&call_status=${st}`);
      const data = r.body.data || [];
      expect(
        `${st} tab returns only ${st} rows`,
        r.status === 200 && data.every((x) => x.call_status_any === st),
        `${data.length} rows`,
      );
      expect(
        `${st} tab finds the seeded patient`,
        !seed[i] || data.some((x) => x.id === seed[i].id),
        seed[i] ? `looking for #${seed[i].id}` : "no row to seed",
      );
    }
  } finally {
    for (const [id, prev] of restore) {
      await pool.query("UPDATE appointments SET call_status=$2 WHERE id=$1", [id, prev]);
    }
    console.log(`Restored ${restore.size} call statuses`);
  }

  const bad = await get(`date=${date}&limit=10&page=1&call_status=nonsense`);
  expect("unknown call status refused", bad.status === 400, JSON.stringify(bad.body));

  const summaryScoped = fresh.body.summary || {};
  expect(
    "summary is scoped to the tab",
    (summaryScoped.total || 0) === (fresh.body.data?.length || 0),
    `summary.total ${summaryScoped.total} vs rows ${fresh.body.data?.length}`,
  );
} finally {
  server.close();
  await pool.end();
}
