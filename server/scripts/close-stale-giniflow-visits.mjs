import "../loadEnv.js";
import pool from "../config/db.js";

const apply = process.argv.includes("--apply");
const includeNeverArrived = process.argv.includes("--never-arrived");
const abandonOpen = process.argv.includes("--abandon-open");

const { rows } = await pool.query(`
  SELECT v.id, v.visit_date::text AS visit_date, v.current_status,
         COALESCE(a.status, '<none>') AS hr_status, p.name,
         EXISTS (SELECT 1 FROM giniflow_visit_events e
                  WHERE e.visit_id = v.id AND e.status <> 'booked') AS moved
    FROM giniflow_visits v
    LEFT JOIN appointments a ON a.id = v.appointment_id
    JOIN patients p ON p.id = v.patient_id
   WHERE v.visit_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
     AND v.current_status NOT IN ('exited','dispensed','cancelled','no_show','abandoned')
   ORDER BY v.visit_date, p.name`);

const target = (r) => {
  if (r.hr_status === "no_show") return "no_show";
  if (r.hr_status === "cancelled") return "cancelled";
  if (includeNeverArrived && r.current_status === "booked" && !r.moved) return "no_show";
  if (abandonOpen && r.moved) return "abandoned";
  return null;
};

const changes = rows
  .map((r) => ({ ...r, to: target(r) }))
  .filter((r) => r.to && r.to !== r.current_status);
const untouched = rows.length - changes.length;

const byReason = {};
for (const r of changes)
  byReason[`${r.current_status} → ${r.to}`] = (byReason[`${r.current_status} → ${r.to}`] || 0) + 1;
console.table(byReason);
console.log(
  `${rows.length} stale visits · ${changes.length} correctable · ${untouched} left alone`,
);

if (!apply) {
  console.log(
    "\nDry run. Re-run with --apply to write. --never-arrived covers booked-and-never-moved; --abandon-open closes visits that reached a station but were never finished.",
  );
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const r of changes) {
    await client.query(
      `UPDATE giniflow_visits SET current_status = $2, updated_at = NOW() WHERE id = $1`,
      [r.id, r.to],
    );
    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at, meta)
       VALUES ($1, $2, 'system', ($3::date + time '23:59:59') AT TIME ZONE 'Asia/Kolkata',
               jsonb_build_object('backfill', 'close-stale-giniflow-visits',
                                  'from', $4::text, 'healthray', $5::text))`,
      [r.id, r.to, r.visit_date, r.current_status, r.hr_status],
    );
  }
  await client.query("COMMIT");
  console.log(`Applied ${changes.length} corrections.`);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
  await pool.end();
}
