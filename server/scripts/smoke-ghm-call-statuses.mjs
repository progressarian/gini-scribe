import "../loadEnv.js";
import express from "express";
import router from "../routes/ghm-appointments.js";
import pool from "../config/db.js";
import { CALL_STATUSES, UNREACHABLE_STATUSES } from "../../shared/callStatuses.js";

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
  const out = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(out)}`);
  return out;
};

const BUCKETS = ["called", "not_picked", "rescheduled", "unreachable", "not_called"];

// Mirrors SUMMARY_BUCKET in GHMPage — the tile a status counts towards.
const bucketOf = (v) =>
  ({ called: "called", not_picked: "not_picked", rescheduled: "rescheduled" })[v] ||
  (UNREACHABLE_STATUSES.includes(v) ? "unreachable" : null) ||
  (!v || v === "pending" ? "not_called" : null);

const summaryFor = async () =>
  (await call("GET", `/ghm-appointments?date=${date}&limit=1`)).summary || {};

const expect = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};

const first = await call("GET", `/ghm-appointments?date=${date}&limit=1`);
const row = first.data?.[0];
if (!row) {
  console.log(`No appointments on ${date} — pass a date with rows as argv[2].`);
  server.close();
  await pool.end();
  process.exit(0);
}
const original = { call_status: row.call_status_any ?? "pending", call_date: row.call_date };
console.log(`Using appointment #${row.id} on ${date} (was ${original.call_status})`);

try {
  await call("PATCH", `/ghm-appointments/${row.id}`, {
    call_status: "no_call_needed",
    call_date: date,
  });
  const base = await summaryFor();

  for (const s of CALL_STATUSES) {
    await call("PATCH", `/ghm-appointments/${row.id}`, { call_status: s.value, call_date: date });
    const now = await summaryFor();
    const want = bucketOf(s.value);
    const wrong = BUCKETS.filter((b) => (now[b] || 0) !== (base[b] || 0) + (b === want ? 1 : 0));
    expect(
      `${s.value.padEnd(15)} → ${want || "no tile"}`,
      wrong.length === 0,
      wrong.length ? wrong.map((b) => `${b} ${base[b]}→${now[b]}`).join(", ") : "",
    );
  }
} finally {
  await call("PATCH", `/ghm-appointments/${row.id}`, {
    call_status: original.call_status,
    call_date: original.call_date ? String(original.call_date).slice(0, 10) : "",
  });
  console.log(
    `Restored #${row.id} to ${original.call_status} / ${original.call_date || "no date"}`,
  );
  server.close();
  await pool.end();
}
