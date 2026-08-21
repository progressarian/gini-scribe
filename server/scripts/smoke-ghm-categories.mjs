import "../loadEnv.js";
import express from "express";
import router from "../routes/ghm-appointments.js";
import pool from "../config/db.js";
import { CATEGORY_VALUES } from "../../shared/patientCategories.js";

const date = process.argv[2] || new Date().toISOString().split("T")[0];

const app = express();
app.use(express.json());
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();

const call = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

const expect = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};

const rows = await pool.query(
  `SELECT id, patient_category FROM appointments
    WHERE appointment_date = $1 ORDER BY id LIMIT $2`,
  [date, CATEGORY_VALUES.length],
);
if (rows.rows.length < CATEGORY_VALUES.length) {
  console.log(
    `Need ${CATEGORY_VALUES.length} appointments on ${date}; found ${rows.rows.length}. Pass a busier date as argv[2].`,
  );
  server.close();
  await pool.end();
  process.exit(0);
}
const ids = rows.rows.map((r) => r.id);
const restore = new Map(rows.rows.map((r) => [r.id, r.patient_category]));

try {
  const bad = await call("PATCH", `/ghm-appointments/${ids[0]}`, { patient_category: "vip" });
  expect("unknown category refused", bad.status === 400, JSON.stringify(bad.body));

  for (const [i, v] of CATEGORY_VALUES.entries()) {
    const r = await call("PATCH", `/ghm-appointments/${ids[i]}`, { patient_category: v });
    expect(`set ${v}`, r.status === 200 && r.body.patient_category === v, JSON.stringify(r.body));
  }

  const counts = await call("GET", `/ghm-appointments/category-counts?date=${date}`);
  expect(
    "category-counts covers every category",
    CATEGORY_VALUES.every((v) => (counts.body.categories?.[v]?.count || 0) >= 1),
    JSON.stringify(counts.body.categories),
  );

  const many = await call("PATCH", `/ghm-appointments/${ids[1]}`, { patient_category: "cghs" });
  expect("no daily limit — a second CGHS patient is accepted", many.status === 200);

  const clear = await call("PATCH", `/ghm-appointments/${ids[0]}`, { patient_category: "" });
  expect("category can be cleared", clear.status === 200 && !clear.body.patient_category);

  const list = await call("GET", `/ghm-appointments?date=${date}&limit=1`);
  const summary = list.body.summary || {};
  expect(
    "list summary carries per-category counts",
    CATEGORY_VALUES.every((v) => `cat_${v}` in summary),
    Object.keys(summary)
      .filter((k) => k.startsWith("cat_"))
      .join(", "),
  );
  expect(
    "list row carries patient_category",
    !list.body.data?.length || "patient_category" in list.body.data[0],
  );
} finally {
  for (const [id, prev] of restore) {
    await pool.query("UPDATE appointments SET patient_category=$2 WHERE id=$1", [id, prev]);
  }
  console.log(`Restored ${restore.size} appointments`);
  server.close();
  await pool.end();
}
