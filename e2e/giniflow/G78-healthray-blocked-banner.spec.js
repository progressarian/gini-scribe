import { test, expect } from "@playwright/test";
import { query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { getHealthrayStatus } = await import("../../server/services/giniflow/healthrayRefresh.js");

const KEYS = ["healthray_login_cooldown", "healthray_sync_last_ok"];
const MIN = 60_000;
let saved = [];

async function setKv(key, value, minutesAgo) {
  await query(
    `INSERT INTO app_kv (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW() - make_interval(mins => $3))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), minutesAgo],
  );
}

async function blockedAgo(minutes) {
  await setKv(
    "healthray_login_cooldown",
    { until: Date.now() + 5 * MIN, reason: "IP likely blocked (http=403)", blockCount: 1 },
    minutes,
  );
}

const lastOkAgo = (minutes) =>
  setKv("healthray_sync_last_ok", { at: Date.now() - minutes * MIN }, minutes);

test.describe.serial("G78 Reception names a HealthRay block instead of 'sync stopped'", () => {
  test.beforeAll(async () => {
    saved = (await query(`SELECT key, value, updated_at FROM app_kv WHERE key = ANY($1)`, [KEYS]))
      .rows;
  });

  test.afterAll(async () => {
    await query(`DELETE FROM app_kv WHERE key = ANY($1)`, [KEYS]);
    for (const row of saved) {
      await query(`INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2, $3)`, [
        row.key,
        row.value,
        row.updated_at,
      ]);
    }
  });

  test("1. one last sync on the old login after the block does not hide the block", async () => {
    await blockedAgo(27);
    await lastOkAgo(24);
    const status = await getHealthrayStatus(db);
    expect(status.blockedUntil).not.toBeNull();
    expect(status.blockedReason).toContain("403");
    expect(status.syncQuiet).toBe(false);
  });

  test("2. a worker still syncing during the block keeps the board on 'synced'", async () => {
    await blockedAgo(27);
    await lastOkAgo(2);
    const status = await getHealthrayStatus(db);
    expect(status.blockedUntil).toBeNull();
  });

  test("3. a block with no sync since keeps showing as blocked", async () => {
    await blockedAgo(10);
    await lastOkAgo(40);
    expect((await getHealthrayStatus(db)).blockedUntil).not.toBeNull();
  });
});
