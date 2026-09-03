import "../loadEnv.js";
import pool from "../config/db.js";

// One-off recovery for 3 Sep 2026: todaysShowSync flipped the whole day's
// appointment list to no_show at 05:37 IST off a stale "Today's Appt" sheet
// column, and Gini Flow mirrored it into giniflow_visits — emptying every
// station board. Run with --apply; without it, prints what it would change.

const APPLY = process.argv.includes("--apply");
const DAY = "2026-09-03";
const FLIPPED_FROM = "2026-09-03T00:07:21Z";
const FLIPPED_TO = "2026-09-03T00:07:22Z";
const PLACEHOLDER_DAY = "2026-09-02";
const PLACEHOLDER_AFTER = "2026-09-02T18:00:00Z";

const show = async (label, sql, params = []) => {
  const { rows } = await pool.query(sql, params);
  console.log(`\n== ${label}`);
  console.table(rows);
  return rows;
};

await show(
  "appointments to reset -> scheduled",
  `SELECT count(*)::int AS n FROM appointments
    WHERE appointment_date = $1::date AND status = 'no_show'
      AND updated_at >= $2::timestamptz AND updated_at < $3::timestamptz`,
  [DAY, FLIPPED_FROM, FLIPPED_TO],
);

await show(
  "visits to reset -> booked",
  `SELECT count(*)::int AS n FROM giniflow_visits v
     JOIN appointments a ON a.id = v.appointment_id
    WHERE v.visit_date = $1::date AND v.current_status = 'no_show'
      AND a.appointment_date = $1::date
      AND a.updated_at >= $2::timestamptz AND a.updated_at < $3::timestamptz`,
  [DAY, FLIPPED_FROM, FLIPPED_TO],
);

const PLACEHOLDER_WHERE = `
      appointment_date = $1::date AND status = 'no_show' AND is_walkin = true
      AND created_at > $2::timestamptz
      AND NOT EXISTS (SELECT 1 FROM giniflow_visits v WHERE v.appointment_id = appointments.id)
      AND NOT EXISTS (
            SELECT 1 FROM consultations c
             WHERE c.patient_id = appointments.patient_id AND c.visit_date = $1::date
          )`;

await show(
  "bogus placeholders to delete (2 Sep)",
  `SELECT count(*)::int AS n FROM appointments WHERE ${PLACEHOLDER_WHERE}`,
  [PLACEHOLDER_DAY, PLACEHOLDER_AFTER],
);

if (!APPLY) {
  console.log("\nDry run — pass --apply to write.");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const appts = await client.query(
    `UPDATE appointments SET status = 'scheduled', updated_at = NOW()
      WHERE appointment_date = $1::date AND status = 'no_show'
        AND updated_at >= $2::timestamptz AND updated_at < $3::timestamptz
      RETURNING id`,
    [DAY, FLIPPED_FROM, FLIPPED_TO],
  );

  const visits = await client.query(
    `UPDATE giniflow_visits v SET current_status = 'booked', updated_at = NOW()
      WHERE v.visit_date = $1::date AND v.current_status = 'no_show'
        AND v.appointment_id = ANY($2::int[])
      RETURNING v.id`,
    [DAY, appts.rows.map((r) => r.id)],
  );

  // The false no_show events stay in the log — it is append-only — but a
  // correcting event is written so the visit's history explains the jump back.
  for (const v of visits.rows) {
    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, meta)
       VALUES ($1, 'booked', 'system', $2::jsonb)`,
      [
        v.id,
        JSON.stringify({
          source: "recovery",
          reason: "false no_show from stale Today's Appt sheet column",
          reverted_event_at: FLIPPED_FROM,
        }),
      ],
    );
  }

  const deleted = await client.query(
    `DELETE FROM appointments WHERE ${PLACEHOLDER_WHERE} RETURNING id`,
    [PLACEHOLDER_DAY, PLACEHOLDER_AFTER],
  );

  await client.query("COMMIT");
  console.log(
    `\nApplied — appointments reset: ${appts.rowCount}, visits reset: ${visits.rowCount}, placeholders deleted: ${deleted.rowCount}`,
  );
} catch (e) {
  await client.query("ROLLBACK");
  console.error("Rolled back:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
