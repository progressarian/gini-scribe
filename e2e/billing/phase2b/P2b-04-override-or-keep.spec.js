import { test, expect } from "@playwright/test";
import { query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import {
  admin,
  cleanUp,
  db,
  newTag,
  recAdmin,
  rowsOf,
  seed,
  sessions,
  upload,
} from "./p2b-fixture.mjs";

const { P, p, T } = newTag("P2B04");
const file = (name) => `${p}-${name}.xlsx`;
const otherRecAdmin = { actorId: USERS.reception.id, ip: "127.0.0.1", role: "reception_admin" };
let session = null;

const renamed = () => ({
  Groups: [
    ...Array.from({ length: 6 }, (_, i) => ({
      group_code: `${P}-G${i}`,
      name: `${i < 3 ? "Lab" : "Ward"} renamed ${i} ${T}`,
    })),
    { group_code: `${P}-NEW`, name: `New ${T}` },
  ],
  Subgroups: [{ subgroup_code: `${P}-S0`, group_code: `${P}-G0`, name: `Sub renamed ${T}` }],
});

const decisionsOf = async (id) =>
  Object.fromEntries(
    (await rowsOf(id)).filter((r) => r.status === "override").map((r) => [r.row_key, r.decision]),
  );
const refusal = (promise) => promise.catch((e) => e);

test.describe.serial("P2b-04 override or keep", () => {
  test.beforeAll(async () => {
    await cleanUp(P, p);
    await seed(
      {
        Groups: Array.from({ length: 6 }, (_, i) => ({
          group_code: `${P}-G${i}`,
          name: `Group ${i} ${T}`,
        })),
        Subgroups: [{ subgroup_code: `${P}-S0`, group_code: `${P}-G0`, name: `Sub ${T}` }],
      },
      file("base"),
    );
    session = await upload(renamed(), file("decide"), recAdmin);
  });

  test.afterAll(async () => {
    await cleanUp(P, p);
  });

  test("1. one row at a time: the decision is saved and counted", async () => {
    const [row] = (await sessions.listRows(session.id, { q: `${P}-G1` }, db)).rows;
    const result = await sessions.decideRows(
      session.id,
      { decision: "override", row_ids: [row.id] },
      recAdmin,
      db,
    );
    expect(result).toMatchObject({ decision: "override", matched: 1, changed: 1 });
    expect(result.counts.decision).toEqual({ pending: 6, override: 1, keep: 0 });
    expect(result.counts.plan).toMatchObject({ save: 2, keep: 6, undecided: 6 });
    const again = await sessions.decideRows(
      session.id,
      { decision: "override", row_ids: [String(row.id)] },
      recAdmin,
      db,
    );
    expect(again).toMatchObject({ matched: 1, changed: 0 });
    const keep = await sessions.decideRows(
      session.id,
      { decision: "keep", row_ids: [row.id] },
      recAdmin,
      db,
    );
    expect(keep.counts.decision).toEqual({ pending: 6, override: 0, keep: 1 });
  });

  test("2. every row matching the filter: sheet and search, only rows that need an override", async () => {
    const result = await sessions.decideRows(
      session.id,
      { decision: "override", filter: { sheet: "Groups", q: "lab renamed" } },
      recAdmin,
      db,
    );
    expect(result).toMatchObject({ matched: 3, changed: 3 });
    expect(await decisionsOf(session.id)).toEqual({
      [`${P}-G0`]: "override",
      [`${P}-G1`]: "override",
      [`${P}-G2`]: "override",
      [`${P}-G3`]: "pending",
      [`${P}-G4`]: "pending",
      [`${P}-G5`]: "pending",
      [`${P}-S0`]: "pending",
    });
    const rest = await sessions.decideRows(session.id, { decision: "keep", filter: {} }, admin, db);
    expect(rest).toMatchObject({ matched: 7, changed: 7 });
    expect(Object.values(await decisionsOf(session.id))).toEqual(Array(7).fill("keep"));
    const undo = await sessions.decideRows(
      session.id,
      { decision: "pending", filter: { sheet: "Subgroups" } },
      recAdmin,
      db,
    );
    expect(undo.counts.decision).toEqual({ pending: 1, override: 0, keep: 6 });
  });

  test("3. every decision is written to the change log", async () => {
    const { rows } = await query(
      `SELECT action, actor_id, after FROM billing_audit
        WHERE entity = 'billing_import_sessions' AND entity_id = $1 AND action = 'update'
        ORDER BY id`,
      [session.id],
    );
    expect(rows.map((r) => [r.actor_id, r.after.decision, r.after.changed])).toEqual([
      [recAdmin.actorId, "override", 1],
      [recAdmin.actorId, "override", 0],
      [recAdmin.actorId, "keep", 1],
      [recAdmin.actorId, "override", 3],
      [admin.actorId, "keep", 7],
      [recAdmin.actorId, "pending", 1],
    ]);
    expect(rows[3].after.filter).toEqual({ sheet: "Groups", q: "lab renamed" });
    expect(rows[0].after.row_ids).toHaveLength(1);
  });

  test("4. only rows that need an override take a decision", async () => {
    const all = (await sessions.listRows(session.id, {}, db)).rows;
    const ready = all.find((r) => r.status === "ready");
    const wrong = await refusal(
      sessions.decideRows(session.id, { decision: "override", row_ids: [ready.id] }, admin, db),
    );
    expect(wrong.status).toBe(409);
    expect(wrong.message).toBe(
      `Only rows that need an override take a decision: Groups row ${ready.row} is ready`,
    );
    const filtered = await refusal(
      sessions.decideRows(session.id, { decision: "keep", filter: { status: "ready" } }, admin, db),
    );
    expect([filtered.status, filtered.message]).toEqual([
      400,
      "Only rows that need an override take a decision; filter on those",
    ]);
    const none = await refusal(
      sessions.decideRows(
        session.id,
        { decision: "keep", filter: { q: "zzz-nothing" } },
        admin,
        db,
      ),
    );
    expect([none.status, none.message]).toEqual([
      409,
      "No row matching this filter needs an override",
    ]);
  });

  test("5. bad requests are refused in words", async () => {
    const [row] = (await sessions.listRows(session.id, { status: "override" }, db)).rows;
    const ask = (input, ctx = admin) => refusal(sessions.decideRows(session.id, input, ctx, db));
    expect((await ask({ decision: "maybe", row_ids: [row.id] })).message).toBe(
      "Decision must be one of: pending, override, keep",
    );
    expect((await ask({ row_ids: [row.id] })).message).toBe("Choose override or keep");
    expect((await ask({ decision: "keep" })).message).toBe(
      "Send either the rows (row_ids) or a filter, not both",
    );
    expect((await ask({ decision: "keep", row_ids: [row.id], filter: {} })).status).toBe(400);
    expect((await ask({ decision: "keep", row_ids: [] })).message).toBe(
      "Choose the rows to decide",
    );
    expect((await ask({ decision: "keep", row_ids: ["x"] })).status).toBe(400);
    expect(
      (await ask({ decision: "keep", row_ids: Array.from({ length: 501 }, (_, i) => i + 1) }))
        .message,
    ).toMatch(/At most 500 rows/);
    const stranger = await ask({ decision: "keep", row_ids: [row.id, 999999999] });
    expect([stranger.status, stranger.message]).toEqual([
      404,
      "Not rows of this import: 999999999",
    ]);
    expect((await ask({ decision: "keep", row_ids: [row.id] }, {})).status).toBe(400);
  });

  test("6. only the uploader or an admin may decide", async () => {
    const [row] = (await sessions.listRows(session.id, { status: "override" }, db)).rows;
    const other = await refusal(
      sessions.decideRows(session.id, { decision: "keep", row_ids: [row.id] }, otherRecAdmin, db),
    );
    expect([other.status, other.message]).toEqual([
      403,
      "Only the person who uploaded this file, or an admin, can change this import",
    ]);
    const byAdmin = await sessions.decideRows(
      session.id,
      { decision: "override", row_ids: [row.id] },
      admin,
      db,
    );
    expect(byAdmin.changed).toBe(1);
  });

  test("7. a committed, abandoned or expired session refuses decisions", async () => {
    const expired = await upload(renamed(), file("expired"), recAdmin);
    await query(
      `UPDATE billing_import_sessions
          SET uploaded_at = NOW() - interval '25 hours', expires_at = NOW() - interval '1 hour'
        WHERE id = $1`,
      [expired.id],
    );
    const late = await refusal(
      sessions.decideRows(expired.id, { decision: "keep", filter: {} }, recAdmin, db),
    );
    expect(late.status).toBe(410);
    expect(late.message).toMatch(/expired 24 hours after it was uploaded/);

    const abandoned = await upload(renamed(), file("abandoned"), recAdmin);
    await sessions.abandonSession(abandoned.id, recAdmin, db);
    const gone = await refusal(
      sessions.decideRows(abandoned.id, { decision: "keep", filter: {} }, recAdmin, db),
    );
    expect([gone.status, gone.message]).toEqual([
      409,
      "This import was abandoned; upload the file again",
    ]);

    await sessions.commitSession(session.id, { ctx: recAdmin }, db);
    const done = await refusal(
      sessions.decideRows(session.id, { decision: "keep", filter: {} }, recAdmin, db),
    );
    expect(done.status).toBe(409);
    expect(done.message).toMatch(/This import is already saved \(import \d+\)/);
  });
});
