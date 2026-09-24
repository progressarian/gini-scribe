import { test, expect } from "@playwright/test";
import { query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { admin, cleanUp, db, newTag, recAdmin, sessions, upload } from "./p2b-fixture.mjs";

const { P, p, T } = newTag("P2B07");
const file = (name) => `${p}-${name}.xlsx`;
const stranger = { actorId: USERS.reception.id, ip: "127.0.0.1", role: "reception_admin" };
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

const refusal = (promise) => promise.catch((e) => e);

test.describe.serial("P2b-07 expiry and abandon", () => {
  test.beforeAll(async () => {
    await cleanUp(P, p);
  });

  test.afterAll(async () => {
    await cleanUp(P, p);
  });

  test("1. a session lasts 24 hours; after that it can't be committed or decided", async () => {
    const session = await upload(sheets(2), file("expire"), recAdmin);
    await age(session.id, 23);
    expect((await sessions.getSession(session.id, db)).expired).toBe(false);
    await age(session.id, 25);
    const read = await sessions.getSession(session.id, db);
    expect(read).toMatchObject({ status: "open", expired: true });
    const commit = await refusal(sessions.commitSession(session.id, { ctx: recAdmin }, db));
    expect([commit.status, commit.message]).toEqual([
      410,
      "This import expired 24 hours after it was uploaded; upload the file again",
    ]);
    expect((await query(`SELECT 1 FROM service_groups WHERE code = $1`, [`${P}-G0`])).rows).toEqual(
      [],
    );
    const rows = await sessions.listRows(session.id, {}, db);
    expect(rows.total).toBe(2);
  });

  test("2. abandon: the rows and the file go at once, it is audited, and nothing can follow", async () => {
    const session = await upload(sheets(3), file("abandon"), recAdmin);
    const other = await refusal(sessions.abandonSession(session.id, stranger, db));
    expect(other.status).toBe(403);
    const result = await sessions.abandonSession(session.id, recAdmin, db);
    expect(result).toEqual({ id: session.id, status: "abandoned", rows_removed: 3 });
    expect(await exists(session.id)).toEqual({ status: "abandoned", has_file: false, rows: 0 });
    const { rows } = await query(
      `SELECT action, actor_id, before FROM billing_audit
        WHERE entity = 'billing_import_sessions' AND entity_id = $1 ORDER BY id`,
      [session.id],
    );
    expect(rows.map((r) => r.action)).toEqual(["create", "cancel"]);
    expect(rows[1].before).toEqual({ file_name: file("abandon"), rows: 3 });
    const commit = await refusal(sessions.commitSession(session.id, { ctx: recAdmin }, db));
    expect(commit.status).toBe(409);
    const again = await refusal(sessions.abandonSession(session.id, recAdmin, db));
    expect([again.status, again.message]).toEqual([
      409,
      "This import was abandoned; upload the file again",
    ]);
  });

  test("3. an expired session can be abandoned; a committed one can't", async () => {
    const expired = await upload(sheets(1), file("expired-abandon"), recAdmin);
    await age(expired.id, 30);
    expect((await sessions.abandonSession(expired.id, admin, db)).status).toBe("abandoned");
    const done = await upload(sheets(1), file("committed"), recAdmin);
    await sessions.commitSession(done.id, { ctx: recAdmin }, db);
    const refused = await refusal(sessions.abandonSession(done.id, recAdmin, db));
    expect(refused.status).toBe(409);
    expect(refused.message).toMatch(/already saved/);
  });

  test("4. expired and abandoned sessions are deleted with their rows; committed ones stay as the report", async () => {
    const kept = await upload(
      { Groups: [{ group_code: `${P}-K`, name: `Kept ${T}` }] },
      file("report"),
      recAdmin,
    );
    await sessions.commitSession(kept.id, { ctx: recAdmin }, db);
    await age(kept.id, 100);
    const stale = await upload(sheets(2), file("stale"), recAdmin);
    const abandoned = await upload(sheets(2), file("gone"), recAdmin);
    const fresh = await upload(sheets(2), file("fresh"), recAdmin);
    await age(stale.id, 48);
    await sessions.abandonSession(abandoned.id, recAdmin, db);

    const removed = await sessions.purgeStaleSessions(db);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await exists(stale.id)).toBeNull();
    expect(await exists(abandoned.id)).toBeNull();
    expect(
      (
        await query(`SELECT count(*)::int AS n FROM billing_import_rows WHERE session_id = $1`, [
          stale.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(await exists(fresh.id)).toEqual({ status: "open", has_file: true, rows: 2 });
    expect(await exists(kept.id)).toEqual({ status: "committed", has_file: true, rows: 1 });
    const report = await sessions.listRows(kept.id, { outcome: "saved" }, db);
    expect(report.rows.map((r) => r.key)).toEqual([`${P}-K`]);
    const gone = await refusal(sessions.getSession(stale.id, db));
    expect(gone.status).toBe(404);
    expect(gone.message).toBe(
      "That import session no longer exists (it expired or was abandoned); upload the file again",
    );
  });

  test("5. each upload clears out stale sessions first", async () => {
    const stale = await upload(sheets(1), file("stale2"), recAdmin);
    await age(stale.id, 30);
    await upload(sheets(1), file("next"), admin);
    expect(await exists(stale.id)).toBeNull();
  });
});
