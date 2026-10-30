import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { extraVisit, newTag, setUp, tearDown } from "../billing/phase4/p4-bills-fixture.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const sync = await import("../../server/services/giniflow/appointmentSync.js");
const triage = await import("../../server/services/giniflow/triage.js");

const tag = newTag();
let ids;
let made;
let tomorrow;

const clearLeases = () =>
  query(`DELETE FROM giniflow_sync_leases WHERE day IN ($1::date, $2::date)`, [ids.day, tomorrow]);

const holdLease = (day, holder = "elsewhere") =>
  query(
    `INSERT INTO giniflow_sync_leases (day, holder, started_at, until)
     VALUES ($1::date, $2, NOW(), NOW() + INTERVAL '1 minute')
     ON CONFLICT (day) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until,
                                     finished_at = NULL`,
    [day, holder],
  );

const leaseOf = (day) =>
  one(
    `SELECT holder, until <= NOW() AS free, finished_at FROM giniflow_sync_leases WHERE day = $1::date`,
    [day],
  );

const withFreshWindow = async (ms, run) => {
  const before = process.env.GINIFLOW_SYNC_FRESH_MS;
  process.env.GINIFLOW_SYNC_FRESH_MS = String(ms);
  try {
    return await run();
  } finally {
    process.env.GINIFLOW_SYNC_FRESH_MS = before;
  }
};

test.describe.serial("G130 flow sync runs one at a time", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    tomorrow = (await one(`SELECT ($1::date + 1)::text AS d`, [ids.day])).d;
    made = await extraVisit(ids, "OneSync", { healthray: false });
    await query(`UPDATE appointments SET status = 'checkedin' WHERE id = $1`, [made.appointment]);
  });

  test.beforeEach(async () => {
    await clearLeases();
  });

  test.afterAll(async () => {
    await clearLeases();
    await tearDown(ids);
  });

  test("1. two syncs started together: one runs, the other skips as running", async () => {
    await query(`DELETE FROM giniflow_visits WHERE id = $1`, [made.visit]);
    const results = await Promise.all([
      sync.syncAppointmentsToFlow({ date: ids.day, db }),
      sync.syncAppointmentsToFlow({ date: ids.day, db }),
    ]);
    expect(results.filter((r) => r.skippedRun === "running")).toHaveLength(1);
    expect(results.filter((r) => !r.skippedRun)).toHaveLength(1);
    const visits = await query(`SELECT id FROM giniflow_visits WHERE patient_id = $1`, [
      made.patient,
    ]);
    expect(visits.rows).toHaveLength(1);
    made.visit = visits.rows[0].id;
    const lease = await leaseOf(ids.day);
    expect(lease.free).toBe(true);
    expect(lease.finished_at).not.toBeNull();
  });

  test("2. a sync right after another is skipped inside the 15 s window", async () => {
    await withFreshWindow(15000, async () => {
      const first = await sync.syncAppointmentsToFlow({ date: ids.day, db });
      expect(first.skippedRun).toBeUndefined();
      const second = await sync.syncAppointmentsToFlow({ date: ids.day, db });
      expect(second).toEqual({ date: ids.day, skippedRun: "fresh" });
      const asked = await sync.syncAppointmentsToFlow({ date: ids.day, db, reuseRecent: false });
      expect(asked.skippedRun).toBeUndefined();
      await query(
        `UPDATE giniflow_sync_leases SET finished_at = NOW() - INTERVAL '16 seconds' WHERE day = $1::date`,
        [ids.day],
      );
      const later = await sync.syncAppointmentsToFlow({ date: ids.day, db });
      expect(later.skippedRun).toBeUndefined();
    });
  });

  test("3. a lease left by a crashed run is taken over once it expires", async () => {
    await holdLease(ids.day, "crashed");
    expect((await sync.syncAppointmentsToFlow({ date: ids.day, db })).skippedRun).toBe("running");
    await query(
      `UPDATE giniflow_sync_leases SET until = NOW() - INTERVAL '1 second' WHERE day = $1::date`,
      [ids.day],
    );
    const taken = await sync.syncAppointmentsToFlow({ date: ids.day, db });
    expect(taken.skippedRun).toBeUndefined();
    expect((await leaseOf(ids.day)).holder).not.toBe("crashed");
  });

  test("4. a sync that throws frees the lease and the next call runs", async () => {
    const failing = {
      query: (text, params) => db.query(text, params),
      connect: () => Promise.reject(new Error("connection lost")),
    };
    await withFreshWindow(15000, async () => {
      await expect(sync.syncAppointmentsToFlow({ date: ids.day, db: failing })).rejects.toThrow(
        "connection lost",
      );
      const lease = await leaseOf(ids.day);
      expect(lease.free).toBe(true);
      expect(lease.finished_at).toBeNull();
      const next = await sync.syncAppointmentsToFlow({ date: ids.day, db });
      expect(next.skippedRun).toBeUndefined();
    });
  });

  test("5. today and tomorrow don't block each other", async () => {
    await holdLease(tomorrow);
    const today = await sync.syncAppointmentsToFlow({ date: ids.day, db });
    expect(today.skippedRun).toBeUndefined();
    await clearLeases();
    await holdLease(ids.day);
    const next = await sync.syncAppointmentsToFlow({ date: tomorrow, db });
    expect(next.skippedRun).toBeUndefined();
  });

  test("6. the triage board still shows the day and reports the skip", async () => {
    await holdLease(ids.day);
    const day = await triage.getTriageDay(ids.day, { db });
    expect(day.ensured).toEqual({ skipped: "running" });
    const cards = [...day.columns.flatMap((c) => c.cards), ...day.uncategorised];
    expect(cards.some((c) => c.name?.includes(tag))).toBe(true);
    await clearLeases();
    const ran = await triage.getTriageDay(ids.day, { db });
    expect(ran.ensured.skipped).toBeUndefined();
    expect(typeof ran.ensured.considered).toBe("number");
  });
});
