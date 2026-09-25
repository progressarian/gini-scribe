import { test, expect } from "@playwright/test";
import { query } from "../../helpers/db.mjs";
import { cleanUp, db, newTag, recAdmin, sessions, upload } from "./p2b-fixture.mjs";

const { runImportSessionSweep } =
  await import("../../../server/services/cron/importSessionSweep.js");
const { tryAcquireCronLock, CRON_LOCK_KEYS } =
  await import("../../../server/services/cron/lowPriority.js");

const { P, p, T } = newTag("P2B10");
const file = (name) => `${p}-${name}.xlsx`;
const sheets = (n) => ({
  Groups: Array.from({ length: n }, (_, i) => ({ group_code: `${P}-G${i}`, name: `G ${i} ${T}` })),
});

const age = (id, hours) =>
  query(
    `UPDATE billing_import_sessions
        SET uploaded_at = NOW() - make_interval(hours => $2),
            expires_at = NOW() - make_interval(hours => $2) + interval '24 hours'
      WHERE id = $1`,
    [id, hours],
  );

const exists = async (id) => {
  const { rows } = await query(
    `SELECT s.status, s.file IS NOT NULL AS has_file,
            (SELECT count(*)::int FROM billing_import_rows r WHERE r.session_id = s.id) AS rows
       FROM billing_import_sessions s WHERE s.id = $1`,
    [id],
  );
  return rows[0] ?? null;
};

const logged = async (run) => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return { result: await run(), lines };
  } finally {
    console.log = original;
  }
};

test.describe.serial("P2b-12 daily sweep of stale import sessions", () => {
  test.beforeAll(async () => {
    await cleanUp(P, p);
  });

  test.afterAll(async () => {
    await cleanUp(P, p);
  });

  test("1. the sweep removes expired and abandoned sessions and keeps open and committed ones", async () => {
    const committed = await upload(
      { Groups: [{ group_code: `${P}-K`, name: `Kept ${T}` }] },
      file("committed"),
      recAdmin,
    );
    await sessions.commitSession(committed.id, { ctx: recAdmin }, db);
    await age(committed.id, 100);
    const expired = await upload(sheets(2), file("expired"), recAdmin);
    const abandoned = await upload(sheets(2), file("abandoned"), recAdmin);
    const open = await upload(sheets(2), file("open"), recAdmin);
    await age(expired.id, 48);
    await sessions.abandonSession(abandoned.id, recAdmin, db);

    const { result, lines } = await logged(runImportSessionSweep);
    expect(result.removed).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.includes("[Import Session Sweep]"))).toBe(true);
    expect(await exists(expired.id)).toBeNull();
    expect(await exists(abandoned.id)).toBeNull();
    expect(
      (
        await query(`SELECT count(*)::int AS n FROM billing_import_rows WHERE session_id = $1`, [
          expired.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(await exists(open.id)).toEqual({ status: "open", has_file: true, rows: 2 });
    expect(await exists(committed.id)).toEqual({ status: "committed", has_file: true, rows: 1 });
  });

  test("2. with nothing to do it removes nothing and logs nothing", async () => {
    const { result, lines } = await logged(runImportSessionSweep);
    expect(result).toEqual({ removed: 0 });
    expect(lines.filter((l) => l.includes("[Import Session Sweep]"))).toEqual([]);
  });

  test("3. a sweep already holding the lock makes the next one skip without touching anything", async () => {
    const expired = await upload(sheets(1), file("locked"), recAdmin);
    await age(expired.id, 30);
    const release = await tryAcquireCronLock(
      "import-session-sweep",
      CRON_LOCK_KEYS.IMPORT_SESSION_SWEEP,
    );
    expect(release).not.toBeNull();
    try {
      expect(await runImportSessionSweep()).toEqual({ skipped: "locked" });
      expect(await exists(expired.id)).toMatchObject({ status: "open" });
    } finally {
      await release();
    }
    expect((await runImportSessionSweep()).removed).toBeGreaterThanOrEqual(1);
    expect(await exists(expired.id)).toBeNull();
  });
});
