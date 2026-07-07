// One-time cleanup: collapse duplicate flow_visits rows to one per patient/day.
//
// flow_visits had no per-patient/day uniqueness, so a patient could accumulate
// several rows in a day (re-check-in after completion, a manual check-in plus an
// appointment-linked row, etc.). Because the Coordinator board counted rows,
// this over-reported "Completed" (e.g. 54 rows for 42 real patients).
//
// For each (patient, visit_date) group with >1 non-cancelled row this keeps the
// winner — most-complete, tie-broken by latest check-in, the SAME rule the app
// uses (server/routes/flow.js dedupeVisitsByPatient) — and SOFT-CANCELS the
// losers (status='cancelled' + a merge note). Soft-cancel preserves the
// flow_visit_steps history/audit and drops the rows from every completed count.
//
// Patients are keyed by patient_db_id when present, else patient_id (file no).
//
// Usage (from the gini-scribe repo root):
//   node dedupe-flow-visits.mjs                 # dry-run (default) — prints plan
//   node dedupe-flow-visits.mjs --apply         # write the soft-cancels
//   node dedupe-flow-visits.mjs --date=2026-07-07        # limit to one day
//   node dedupe-flow-visits.mjs --apply --date=2026-07-07
//
// Idempotent — re-running finds nothing once applied. ⚠️ .env points at the
// PRODUCTION DB; run --dry-run first and review, then --apply off-hours.

import "dotenv/config";

const { default: pool } = await import("./server/config/db.js");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dateArg = args.find((a) => a.startsWith("--date="))?.split("=")[1] || null;

// Same ranking as the app's dedupeVisitsByPatient.
const RANK = { completed: 3, in_progress: 2, waiting: 1, paused: 1, cancelled: 0 };
const patientKey = (r) =>
  r.patient_db_id != null ? `db:${r.patient_db_id}` : `file:${r.patient_id}`;

// Pick the survivor: highest rank, tie-broken by latest check-in.
function pickWinner(rows) {
  return rows.reduce((best, v) => {
    const rv = RANK[v.status] ?? 0;
    const rc = RANK[best.status] ?? 0;
    const better =
      rv !== rc
        ? rv > rc
        : new Date(v.checkin_time).getTime() > new Date(best.checkin_time).getTime();
    return better ? v : best;
  });
}

const where = ["status <> 'cancelled'"];
const params = [];
if (dateArg) {
  params.push(dateArg);
  where.push(`visit_date = $${params.length}`);
}

const { rows } = await pool.query(
  `SELECT id, patient_id, patient_db_id, patient_name, visit_date, status, checkin_time, notes
     FROM flow_visits
    WHERE ${where.join(" AND ")}
    ORDER BY visit_date, checkin_time`,
  params,
);

console.log(
  `\nMode: ${apply ? "APPLY (writing)" : "DRY-RUN (no writes)"}${dateArg ? `  date=${dateArg}` : "  (all dates)"}`,
);
console.log(`Scanned ${rows.length} non-cancelled flow_visits rows.\n`);

// Group by (patient key, visit_date).
const groups = new Map();
for (const r of rows) {
  const day =
    r.visit_date instanceof Date ? r.visit_date.toISOString().slice(0, 10) : String(r.visit_date);
  const key = `${patientKey(r)}|${day}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const losers = [];
let dupGroups = 0;
for (const [key, g] of groups) {
  if (g.length < 2) continue;
  dupGroups++;
  const winner = pickWinner(g);
  const day = key.split("|")[1];
  console.log(
    `${day}  ${winner.patient_name} [${key.split("|")[0]}] — ${g.length} rows; keep ${winner.id} (${winner.status}), cancel ${g.length - 1}:`,
  );
  for (const r of g) {
    const mark = r.id === winner.id ? "KEEP  " : "cancel";
    console.log(
      `    ${mark} ${r.id}  status=${r.status}  checkin=${new Date(r.checkin_time).toISOString()}`,
    );
    if (r.id !== winner.id) losers.push({ id: r.id, winnerId: winner.id });
  }
}

console.log(
  `\n${dupGroups} patient/day group(s) with duplicates; ${losers.length} row(s) to soft-cancel.`,
);

if (!apply) {
  console.log("\nDry-run only. Re-run with --apply to write the soft-cancels.\n");
  await pool.end();
  process.exit(0);
}

let cancelled = 0;
for (const l of losers) {
  const res = await pool.query(
    `UPDATE flow_visits
        SET status='cancelled',
            notes = COALESCE(notes,'') || ' [dup-merged→' || $2 || ']',
            updated_at = NOW()
      WHERE id = $1 AND status <> 'cancelled'`,
    [l.id, l.winnerId],
  );
  cancelled += res.rowCount;
}

console.log(`\nSoft-cancelled ${cancelled} duplicate row(s).\n`);
await pool.end();
process.exit(0);
