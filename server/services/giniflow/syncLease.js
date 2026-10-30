import os from "node:os";
import { randomUUID } from "node:crypto";

const leaseMs = () => Number(process.env.GINIFLOW_SYNC_LEASE_MS) || 120000;
const freshMs = () => {
  const raw = process.env.GINIFLOW_SYNC_FRESH_MS;
  return raw === undefined || raw === "" || !(Number(raw) >= 0) ? 15000 : Number(raw);
};

export async function takeSyncLease(db, day, { reuseRecent = true } = {}) {
  const holder = `${os.hostname()}:${process.pid}:${randomUUID()}`;
  const { rows } = await db.query(
    `INSERT INTO giniflow_sync_leases (day, holder, started_at, until)
     VALUES ($1::date, $2, NOW(), NOW() + $3 * INTERVAL '1 millisecond')
     ON CONFLICT (day) DO UPDATE
        SET holder = EXCLUDED.holder, started_at = NOW(), until = EXCLUDED.until, finished_at = NULL
      WHERE giniflow_sync_leases.until <= NOW()
        AND (NOT $4::boolean
             OR giniflow_sync_leases.finished_at IS NULL
             OR giniflow_sync_leases.finished_at <= NOW() - $5 * INTERVAL '1 millisecond')
     RETURNING holder`,
    [day, holder, leaseMs(), reuseRecent, freshMs()],
  );
  if (rows.length) return { holder };
  const { rows: held } = await db.query(
    `SELECT until > NOW() AS running FROM giniflow_sync_leases WHERE day = $1::date`,
    [day],
  );
  return { skipped: held[0]?.running ? "running" : "fresh" };
}

export async function finishSyncLease(db, day, holder, { ok = true } = {}) {
  await db.query(
    `UPDATE giniflow_sync_leases
        SET until = NOW(), finished_at = CASE WHEN $3::boolean THEN NOW() ELSE finished_at END
      WHERE day = $1::date AND holder = $2`,
    [day, holder, ok],
  );
}
