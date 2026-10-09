import { test, expect } from "@playwright/test";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { db } from "../billing/phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { tryAcquireCronLease } = await import("../../server/services/cron/lowPriority.js");

const key = 990000000 + Math.floor(Math.random() * 1_000_000);
const name = `cron_lease:${key}`;
const timing = { db, ttlMs: 600, renewMs: 150 };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const holder = async () => (await one(`SELECT value FROM app_kv WHERE key = $1`, [name])).value;

test.describe.serial("G77 a stuck cron run cannot hold its lease forever", () => {
  test.afterAll(async () => {
    await query(`DELETE FROM app_kv WHERE key = $1`, [name]);
  });

  test("1. a run that keeps going is renewed, so nobody else can start", async () => {
    const release = await tryAcquireCronLease("Lease test", key, {
      ...timing,
      maxHoldMs: 60_000,
      owner: "worker-a",
    });
    expect(release).toBeTruthy();
    await pause(1200);
    expect(
      await tryAcquireCronLease("Lease test", key, { ...timing, owner: "worker-b" }),
    ).toBeNull();
    await release();
    const next = await tryAcquireCronLease("Lease test", key, { ...timing, owner: "worker-b" });
    expect(next).toBeTruthy();
    await next();
  });

  test("2. a run stuck past its limit stops renewing, and the next worker takes over", async () => {
    const stuck = await tryAcquireCronLease("Lease test", key, {
      ...timing,
      maxHoldMs: 400,
      owner: "worker-a",
    });
    expect(stuck).toBeTruthy();
    expect(
      await tryAcquireCronLease("Lease test", key, { ...timing, owner: "worker-b" }),
    ).toBeNull();
    await expect
      .poll(
        async () => {
          const taken = await tryAcquireCronLease("Lease test", key, {
            ...timing,
            owner: "worker-b",
          });
          if (!taken) return null;
          await taken();
          return "taken";
        },
        { timeout: 5000, intervals: [200] },
      )
      .toBe("taken");
    await stuck();
    expect((await holder()).owner).toBe("worker-b");
  });
});
