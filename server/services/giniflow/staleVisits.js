import pool from "../../config/db.js";

const STALE_SQL = `
  SELECT v.id, v.visit_date::text AS visit_date, v.current_status,
         COALESCE(a.status, '<none>') AS hr_status,
         EXISTS (SELECT 1 FROM giniflow_visit_events e
                  WHERE e.visit_id = v.id AND e.status <> 'booked') AS moved
    FROM giniflow_visits v
    LEFT JOIN appointments a ON a.id = v.appointment_id
   WHERE v.visit_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
     AND v.current_status NOT IN ('exited','dispensed','cancelled','no_show','abandoned')
   ORDER BY v.visit_date`;

// A visit nobody closed is not a visit that never happened, and it is not one
// that finished either. `no_show` for a patient who never moved off `booked`,
// `abandoned` for one who reached a station and was left there — neither
// invents an exit time, and neither counts as a completed journey.
export const targetStatus = (row) => {
  if (row.hr_status === "no_show") return "no_show";
  if (row.hr_status === "cancelled") return "cancelled";
  if (!row.moved && row.current_status === "booked") return "no_show";
  return "abandoned";
};

export async function sweepStaleVisits({ db = pool, apply = true, source = "cron" } = {}) {
  const { rows } = await db.query(STALE_SQL);
  const changes = rows
    .map((r) => ({ ...r, to: targetStatus(r) }))
    .filter((r) => r.to !== r.current_status);
  if (!apply || changes.length === 0)
    return { found: rows.length, changed: changes.length, changes };

  const client = await db.connect();
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
                 jsonb_build_object('backfill', $4::text, 'from', $5::text, 'healthray', $6::text))`,
        [r.id, r.to, r.visit_date, source, r.current_status, r.hr_status],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { found: rows.length, changed: changes.length, changes };
}
