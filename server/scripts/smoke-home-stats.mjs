import "../loadEnv.js";
import express from "express";
import router from "../routes/home-stats.js";
import pool from "../config/db.js";

const date = process.argv[2] || new Date().toISOString().split("T")[0];

const app = express();
app.use((req, _res, next) => {
  const raw = req.headers["x-test-session"];
  if (raw) req.doctor = JSON.parse(raw);
  next();
});
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();

const get = async (session) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/home-stats?date=${date}`, {
    headers: session ? { "x-test-session": JSON.stringify(session) } : {},
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body)}`);
  return body;
};

try {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='completed')::int seen
       FROM appointments WHERE appointment_date = $1`,
    [date],
  );
  const truth = rows[0];

  const admin = await get({ doctor_id: 1, doctor_name: "Dr. Anil Bhansali", role: "admin" });
  console.log(`date ${date}`);
  console.log("admin (hospital-wide):", admin.scope, admin.stats);
  if (admin.scope !== "all") throw new Error(`admin scope ${admin.scope}, want all`);
  if (admin.stats.total !== truth.total)
    throw new Error(`total ${admin.stats.total} != ${truth.total}`);
  if (admin.stats.seen !== truth.seen) throw new Error(`seen ${admin.stats.seen} != ${truth.seen}`);

  const s = admin.stats;
  const summed = s.seen + s.waiting + s.upcoming + s.no_show + s.cancelled;
  if (summed !== s.total) throw new Error(`buckets ${summed} != total ${s.total}`);

  const doc = await pool.query(
    `SELECT d.id, d.name, d.short_name FROM doctors d
      WHERE d.role='consultant' AND EXISTS (
        SELECT 1 FROM appointments a
         WHERE a.appointment_date=$1 AND (a.doctor_id=d.id OR a.doctor_name ILIKE d.name)
      ) LIMIT 1`,
    [date],
  );
  if (!doc.rows.length) {
    console.log("\n(no consultant has appointments on this date — scoped case not exercised)");
  } else {
    const d = doc.rows[0];
    const mine = await get({
      doctor_id: d.id,
      doctor_name: d.name,
      short_name: d.short_name,
      role: "consultant",
    });
    console.log(`consultant ${d.name}:`, mine.scope, mine.stats);
    if (mine.scope !== "mine") throw new Error(`consultant scope ${mine.scope}, want mine`);
    if (mine.stats.total > admin.stats.total)
      throw new Error(`own total ${mine.stats.total} exceeds hospital ${admin.stats.total}`);
    if (mine.stats.total === 0)
      throw new Error("consultant with appointments got 0 — match failed");
    if (mine.doctor == null) throw new Error("scoped response did not name the doctor");
  }

  const anon = await get({ role: "consultant" }); // no doctor_id
  console.log("consultant without a doctor_id:", anon.scope, anon.stats.total);
  if (anon.scope !== "all") throw new Error("missing doctor_id should fall back to all");

  console.log("\nOK");
} catch (e) {
  console.error("FAILED:", e.message || e);
  process.exitCode = 1;
} finally {
  server.close();
  await pool.end();
}
