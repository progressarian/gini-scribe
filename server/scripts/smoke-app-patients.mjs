import "../loadEnv.js";
import express from "express";
import router from "../routes/appPatients.js";
import pool from "../config/db.js";

const app = express();
app.use((req, _res, next) => {
  req.doctor = { id: 0, name: "smoke" };
  next();
});
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const get = async (path) => {
  const t = Date.now();
  const r = await fetch(base + path);
  const body = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}: ${JSON.stringify(body)}`);
  return { body, ms: Date.now() - t };
};

const show = (label, body, ms) =>
  console.log(
    `${label.padEnd(34)} rows ${String(body.data.length).padStart(3)} / total ${String(body.total).padStart(4)}  page ${body.page}/${body.totalPages}  ${ms}ms`,
  );

try {
  const { body: all, ms } = await get("/api/app-patients/non-gini?limit=100");
  show("baseline", all, ms);
  if (!Array.isArray(all.data)) throw new Error("data is not an array");

  const p1 = await get("/api/app-patients/non-gini?limit=5&page=1");
  const p2 = await get("/api/app-patients/non-gini?limit=5&page=2");
  show("page 1 (limit 5)", p1.body, p1.ms);
  show("page 2 (limit 5)", p2.body, p2.ms);
  if (p1.body.total !== all.total) throw new Error("total changed between pages");
  const ids1 = p1.body.data.map((r) => r.genie_id);
  const ids2 = p2.body.data.map((r) => r.genie_id);
  const overlap = ids1.filter((id) => ids2.includes(id));
  if (overlap.length) throw new Error(`pages overlap: ${overlap.length} rows repeated`);

  const asc = await get("/api/app-patients/non-gini?sort=name&dir=asc&limit=100");
  const desc = await get("/api/app-patients/non-gini?sort=name&dir=desc&limit=100");
  const names = asc.body.data.map((r) => (r.name || "").toLowerCase());
  const sorted = [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  if (JSON.stringify(names) !== JSON.stringify(sorted)) throw new Error("name asc not sorted");
  if (
    asc.body.data.length > 1 &&
    asc.body.data[0].genie_id === desc.body.data[0].genie_id &&
    asc.body.total > 1
  ) {
    throw new Error("dir=desc returned the same first row as asc");
  }
  console.log(`sort name asc/desc                 ok (${asc.body.data.length} rows)`);

  const dates = (
    await get("/api/app-patients/non-gini?sort=created_at&dir=desc&limit=100")
  ).body.data.map((r) => (r.created_at ? Date.parse(r.created_at) : 0));
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] > dates[i - 1]) throw new Error("created_at desc not sorted");
  }
  console.log("sort created_at desc               ok");

  const complete = await get("/api/app-patients/non-gini?profile=complete&limit=100");
  const incomplete = await get("/api/app-patients/non-gini?profile=incomplete&limit=100");
  if (complete.body.data.some((r) => !r.profile_complete))
    throw new Error("profile=complete leaks");
  if (incomplete.body.data.some((r) => r.profile_complete))
    throw new Error("profile=incomplete leaks");
  if (complete.body.total + incomplete.body.total !== all.total)
    throw new Error(
      `profile buckets ${complete.body.total}+${incomplete.body.total} != total ${all.total}`,
    );
  show("profile=complete", complete.body, complete.ms);
  show("profile=incomplete", incomplete.body, incomplete.ms);

  const first = all.data.find((r) => r.name);
  if (first) {
    const term = first.name.trim().split(/\s+/)[0].slice(0, 3);
    const s = await get(`/api/app-patients/non-gini?q=${encodeURIComponent(term)}&limit=100`);
    show(`search q="${term}"`, s.body, s.ms);
    if (s.body.total > all.total) throw new Error("search widened the result set");
    if (!s.body.data.some((r) => (r.name || "").toLowerCase().includes(term.toLowerCase())))
      throw new Error("search returned no row containing the term");
  }

  const { body: conds, ms: cms } = await get("/api/app-patients/conditions");
  console.log(
    `conditions options                 ${conds.data.length} distinct  ${cms}ms  e.g. ${conds.data
      .slice(0, 3)
      .map((c) => `${c.name} (${c.patients})`)
      .join(", ")}`,
  );
  if (conds.data.length) {
    const name = conds.data[0].name;
    const f = await get(
      `/api/app-patients/non-gini?condition=${encodeURIComponent(name)}&limit=100`,
    );
    show(`condition="${name}"`, f.body, f.ms);
    if (f.body.total > all.total) throw new Error("condition filter widened the result set");
  }

  const counted = all.data.filter((r) => Object.keys(r.counts || {}).length).length;
  console.log(`counts present on               ${counted}/${all.data.length} rows`);

  console.log("\nOK");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  server.close();
  await pool.end();
}
