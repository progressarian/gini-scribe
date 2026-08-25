import "../loadEnv.js";
import express from "express";
import router from "../routes/ghm-appointments.js";
import pool from "../config/db.js";
import { UNREACHABLE_STATUSES } from "../../shared/callStatuses.js";
import { CATEGORY_VALUES } from "../../shared/patientCategories.js";

const date = process.argv[2] || new Date().toISOString().split("T")[0];

const app = express();
app.use(express.json());
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();

const call = async (path) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`);
  const out = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(out)}`);
  return out;
};

const cs = (row) => row.call_status || "pending";
const isNew = (v) => !v || String(v).toLowerCase().startsWith("new");

// One predicate per pill, mirroring SUMMARY_BUCKETS on the server.
const PREDICATES = {
  came: (r) => r.show_no_show === "Show",
  no_show: (r) => r.show_no_show === "No Show",
  pending_show: (r) => !r.show_no_show,
  not_called: (r) => cs(r) === "pending",
  called: (r) => cs(r) === "called",
  not_picked: (r) => cs(r) === "not_picked",
  unreachable: (r) => UNREACHABLE_STATUSES.includes(cs(r)),
  rescheduled: (r) => cs(r) === "rescheduled",
  follow_up: (r) => !!r.visit_type && !isNew(r.visit_type),
  home_collection: (r) => r.home_collection === true,
  ...Object.fromEntries(CATEGORY_VALUES.map((v) => [`cat_${v}`, (r) => r.patient_category === v])),
};

const CALL_BUCKETS = ["not_called", "called", "not_picked", "unreachable", "rescheduled"];
const SHOW_BUCKETS = ["came", "no_show", "pending_show"];

const expect = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};

try {
  const base = await call(`/ghm-appointments?date=${date}&limit=1`);
  const summary = base.summary || {};
  console.log(
    `${date}: total ${summary.total} — ${Object.keys(PREDICATES)
      .map((b) => `${b}=${summary[b]}`)
      .join(" ")}`,
  );

  for (const b of Object.keys(PREDICATES)) {
    const r = await call(`/ghm-appointments?date=${date}&limit=100&bucket=${b}`);
    expect(
      `${b}: total matches pill`,
      r.total === (summary[b] || 0),
      `${r.total} vs ${summary[b]}`,
    );
    expect(
      `${b}: summary stays day-wide`,
      (r.summary?.total || 0) === (summary.total || 0),
      `${r.summary?.total} vs ${summary.total}`,
    );
    const stray = (r.data || []).filter((row) => !PREDICATES[b](row));
    expect(`${b}: every row belongs`, stray.length === 0, `${stray.length} stray row(s)`);
    expect(
      `${b}: page size honoured`,
      (r.data || []).length === Math.min(100, r.total),
      `${r.data?.length} rows for total ${r.total}`,
    );
  }

  for (const [group, list] of [
    ["calling", CALL_BUCKETS],
    ["show/no-show", SHOW_BUCKETS],
  ]) {
    const sum = list.reduce((n, b) => n + (summary[b] || 0), 0);
    expect(
      `${group} pills partition the day`,
      sum === (summary.total || 0),
      `${sum} vs ${summary.total}`,
    );
  }

  const bad = await call(`/ghm-appointments?date=${date}&limit=1&bucket=nonsense`);
  expect("unknown bucket is ignored", bad.total === (summary.total || 0));

  const lookup = await call(`/ghm-appointments?mode=lookup&q=a&limit=100&bucket=not_called`);
  const lookupStray = (lookup.data || []).filter((r) => !PREDICATES.not_called(r));
  expect(
    "lookup honours the filter",
    lookupStray.length === 0,
    `${lookupStray.length} stray row(s)`,
  );
  expect(
    "lookup total matches pill",
    lookup.total === (lookup.summary?.not_called || 0),
    `${lookup.total} vs ${lookup.summary?.not_called}`,
  );
} finally {
  server.close();
  await pool.end();
}
