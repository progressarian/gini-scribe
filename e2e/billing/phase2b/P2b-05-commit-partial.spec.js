import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import {
  admin,
  cleanUp,
  db,
  find,
  newTag,
  recAdmin,
  rowsOf,
  seed,
  sessions,
  upload,
} from "./p2b-fixture.mjs";

const { P, p, T } = newTag("P2B05");
const file = (name) => `${p}-${name}.xlsx`;
const EG = `${P}-EG`;
const EG2 = `${P}-EG2`;
const ES = `${P}-ES`;
const EI = `${P}-EI`;
const EJ = `${P}-EJ`;
const EK = `${P}-EK`;
const CAT = `${p}_a`;
const stranger = { actorId: USERS.reception.id, ip: "127.0.0.1", role: "reception_admin" };

const item = (code, name, price, subgroup = ES) => ({
  item_code: code,
  name: `${name} ${T}`,
  subgroup_code: subgroup,
  base_price: price,
  kind: "procedure",
});

const idsOf = async (id, filter) => (await sessions.listRows(id, filter, db)).rows.map((r) => r.id);

const decide = (id, decision, keys) =>
  sessions
    .listRows(id, { status: "override" }, db)
    .then(({ rows }) =>
      sessions.decideRows(
        id,
        { decision, row_ids: rows.filter((r) => keys.includes(r.key)).map((r) => r.id) },
        recAdmin,
        db,
      ),
    );

const priceOf = async (code) =>
  Number(
    (await query(`SELECT base_price FROM service_items WHERE code = $1`, [code])).rows[0]
      ?.base_price,
  );

const groupName = async (code) =>
  (await query(`SELECT name FROM service_groups WHERE code = $1`, [code])).rows[0]?.name ?? null;

const refusal = (promise) => promise.catch((e) => e);

test.describe.serial("P2b-05 commit: partial", () => {
  test.beforeAll(async () => {
    await cleanUp(P, p);
    await seed(
      {
        Groups: [
          { group_code: EG, name: `Exist ${T}` },
          { group_code: EG2, name: `Other ${T}` },
        ],
        Subgroups: [{ subgroup_code: ES, group_code: EG, name: `ESub ${T}` }],
        Items: [item(EI, "Dressing", 500), item(EJ, "Splint", 200), item(EK, "Kit", 100)],
        Categories: [{ category_code: CAT, label: `Scheme ${T}`, payer_name: "Payer" }],
        "Payment rules": [
          {
            category_code: CAT,
            rule_name: "Dressing amount",
            item_code: EI,
            patient_pays: "amount",
            patient_value: 400,
            remainder: "claim",
          },
        ],
      },
      file("base"),
    );
  });

  test.afterAll(async () => {
    await cleanUp(P, p);
  });

  test("1. ready and overridden rows are saved; kept, undecided, unchanged and failed rows are not", async () => {
    const session = await upload(
      {
        Groups: [
          { group_code: `${P}-NG`, name: `New ${T}` },
          { group_code: EG, name: `Exist renamed ${T}` },
          { group_code: EG2, name: `Other renamed ${T}` },
        ],
        Subgroups: [
          { subgroup_code: ES, group_code: EG, name: `ESub ${T}` },
          { subgroup_code: `${P}-NS`, group_code: `${P}-NG`, name: `New sub ${T}` },
        ],
        Items: [
          item(EJ, "Splint", 250),
          item(EK, "Kit", 120),
          item(`${P}-NI`, "New item", 75, `${P}-NS`),
          item(`${P}-BAD`, "Bad", -1),
        ],
      },
      file("one"),
      recAdmin,
    );
    await decide(session.id, "override", [EG, EK]);
    await decide(session.id, "keep", [EG2]);

    const result = await sessions.commitSession(session.id, { ctx: recAdmin }, db);
    expect(result.saved).toBe(true);
    expect(result.outcome).toEqual({ saved: 5, kept: 2, failed: 1, unchanged: 1 });

    expect(await groupName(`${P}-NG`)).toBe(`New ${T}`);
    expect(await groupName(EG)).toBe(`Exist renamed ${T}`);
    expect(await groupName(EG2)).toBe(`Other ${T}`);
    expect(await priceOf(EJ)).toBe(200);
    expect(await priceOf(EK)).toBe(120);
    expect(await priceOf(`${P}-NI`)).toBe(75);
    expect((await query(`SELECT 1 FROM service_items WHERE code = $1`, [`${P}-BAD`])).rows).toEqual(
      [],
    );

    const rows = await rowsOf(session.id);
    expect(rows.map((r) => [r.sheet, r.row_no, r.outcome])).toEqual([
      ["Groups", 2, "saved"],
      ["Groups", 3, "saved"],
      ["Groups", 4, "kept"],
      ["Items", 2, "kept"],
      ["Items", 3, "saved"],
      ["Items", 4, "saved"],
      ["Items", 5, "failed"],
      ["Subgroups", 2, "unchanged"],
      ["Subgroups", 3, "saved"],
    ]);
    expect(find(rows, "Items", 2).decision).toBe("pending");

    const { rows: imports } = await query(
      `SELECT id, status, imported_by, counts FROM billing_imports WHERE id = $1`,
      [result.importId],
    );
    expect(imports[0]).toMatchObject({ status: "saved", imported_by: recAdmin.actorId });
    expect(imports[0].counts).toEqual({
      Groups: { new: 1, update: 1, unchanged: 0, kept: 1, failed: 0 },
      Subgroups: { new: 1, update: 0, unchanged: 1, kept: 0, failed: 0 },
      Items: { new: 1, update: 1, unchanged: 0, kept: 1, failed: 1 },
    });
    expect(result.session).toMatchObject({
      status: "committed",
      import_id: result.importId,
      committed_by: recAdmin.actorId,
    });
    expect(result.session.counts.outcome).toEqual(result.outcome);

    const { rows: audit } = await query(
      `SELECT entity, action FROM billing_audit WHERE import_id = $1 ORDER BY id`,
      [result.importId],
    );
    expect(audit.map((a) => `${a.entity}:${a.action}`).sort()).toEqual(
      [
        "billing_imports:import",
        "service_groups:create",
        "service_groups:update",
        "service_subgroups:create",
        "service_items:create",
        "service_items:update",
      ].sort(),
    );
    const { rows: importAudit } = await query(
      `SELECT after FROM billing_audit WHERE import_id = $1 AND entity = 'billing_imports'`,
      [result.importId],
    );
    expect(importAudit[0].after.session_id).toBe(session.id);
    const { rows: history } = await query(
      `SELECT i.code, h.old_price::float8 AS old, h.new_price::float8 AS new, h.reason
         FROM service_item_price_history h JOIN service_items i ON i.id = h.service_item_id
        WHERE i.code = ANY($1) ORDER BY h.id`,
      [[EK, `${P}-NI`, EJ]],
    );
    expect(history.filter((h) => h.reason !== "Created" || h.code === `${P}-NI`)).toEqual([
      { code: `${P}-NI`, old: null, new: 75, reason: "Created" },
      { code: EK, old: 100, new: 120, reason: `Bulk import: ${file("one")}` },
    ]);
  });

  test("2. a row changed in Scribe after the upload is not overwritten; the rest is saved", async () => {
    const session = await upload(
      {
        Groups: [{ group_code: `${P}-NG2`, name: `Second ${T}` }],
        Items: [item(EI, "Dressing", 600)],
      },
      file("changed"),
      recAdmin,
    );
    await decide(session.id, "override", [EI]);
    await query(`UPDATE service_items SET base_price = 550 WHERE code = $1`, [EI]);
    const result = await sessions.commitSession(session.id, { ctx: recAdmin }, db);
    expect(result.outcome).toEqual({ saved: 1, kept: 0, failed: 1, unchanged: 0 });
    expect(await priceOf(EI)).toBe(550);
    expect(await groupName(`${P}-NG2`)).toBe(`Second ${T}`);
    const row = find(await rowsOf(session.id), "Items", 2);
    expect(row.outcome).toBe("failed");
    expect(row.status).toBe("override");
    expect(row.reason).toBe("Changed since you uploaded (now base_price ₹550) — upload again");
    expect(row.errors).toEqual([{ column: "base_price", message: row.reason }]);
  });

  test("3. a new row that fails at commit fails the new rows under it, naming it", async () => {
    const session = await upload(
      {
        Groups: [
          { group_code: `${P}-NG3`, name: `Third ${T}` },
          { group_code: `${P}-NG4`, name: `Fourth ${T}` },
        ],
        Subgroups: [{ subgroup_code: `${P}-NS3`, group_code: `${P}-NG3`, name: `Third sub ${T}` }],
        Items: [item(`${P}-NI3`, "Third item", 10, `${P}-NS3`)],
      },
      file("cascade"),
      recAdmin,
    );
    await query(`INSERT INTO service_groups (code, name) VALUES ($1, $2)`, [
      `${P}-SCREEN`,
      `Third ${T}`,
    ]);
    const result = await sessions.commitSession(session.id, { ctx: recAdmin }, db);
    expect(result.outcome).toEqual({ saved: 1, kept: 0, failed: 3, unchanged: 0 });
    const rows = await rowsOf(session.id);
    const group = find(rows, "Groups", 2);
    expect(group.reason).toMatch(/A group called "Third .*" already exists \(.*-SCREEN, Scribe\)/);
    const sub = find(rows, "Subgroups", 2);
    expect(sub).toMatchObject({
      outcome: "failed",
      reason: "Depends on Groups row 2, which failed",
      depends_on: group.id,
    });
    expect(find(rows, "Items", 2)).toMatchObject({
      outcome: "failed",
      reason: "Depends on Subgroups row 2, which failed",
      depends_on: sub.id,
    });
    expect(await groupName(`${P}-NG4`)).toBe(`Fourth ${T}`);
    expect(await groupName(`${P}-NG3`)).toBeNull();
  });

  test("4. a kept parent still exists, so rows under it are saved", async () => {
    const session = await upload(
      {
        Groups: [{ group_code: EG, name: `Exist again ${T}` }],
        Subgroups: [{ subgroup_code: `${P}-KS`, group_code: EG, name: `Kid ${T}` }],
      },
      file("kept-parent"),
      recAdmin,
    );
    await decide(session.id, "keep", [EG]);
    const result = await sessions.commitSession(session.id, { ctx: recAdmin }, db);
    expect(result.outcome).toEqual({ saved: 1, kept: 1, failed: 0, unchanged: 0 });
    expect(await groupName(EG)).toBe(`Exist renamed ${T}`);
    const { rows } = await query(
      `SELECT g.code FROM service_subgroups s JOIN service_groups g ON g.id = s.group_id WHERE s.code = $1`,
      [`${P}-KS`],
    );
    expect(rows).toEqual([{ code: EG }]);
  });

  test("5. price checks run again on what is saved: a rule that needed a kept price fails", async () => {
    const session = await upload(
      {
        Items: [item(EJ, "Splint", 500)],
        "Payment rules": [
          {
            category_code: CAT,
            rule_name: "Splint amount",
            item_code: EJ,
            patient_pays: "amount",
            patient_value: 300,
            remainder: "claim",
          },
          {
            category_code: CAT,
            rule_name: "Kit full",
            item_code: EK,
            patient_pays: "full",
            remainder: "claim",
          },
        ],
      },
      file("recheck"),
      recAdmin,
    );
    const before = await rowsOf(session.id);
    expect(find(before, "Payment rules", 2).status).toBe("ready");
    const result = await sessions.commitSession(session.id, { ctx: recAdmin }, db);
    expect(result.outcome).toEqual({ saved: 1, kept: 1, failed: 1, unchanged: 0 });
    const rule = find(await rowsOf(session.id), "Payment rules", 2);
    expect(rule.outcome).toBe("failed");
    expect(rule.reason).toMatch(
      /The patient can't pay ₹300 for items that cost less: Splint .*₹200/,
    );
    expect(await priceOf(EJ)).toBe(200);
    const { rows } = await query(
      `SELECT name FROM category_payment_rules WHERE scheme_code = $1 ORDER BY name`,
      [CAT],
    );
    expect(rows.map((r) => r.name)).toEqual(["Dressing amount", "Kit full"]);
  });

  test("6. when every row to save fails, the import is recorded as failed and nothing is written", async () => {
    const session = await upload({ Items: [item(EK, "Kit", 130)] }, file("all-fail"), recAdmin);
    await decide(session.id, "override", [EK]);
    await query(`UPDATE service_items SET name = $2 WHERE code = $1`, [EK, `Kit on screen ${T}`]);
    const result = await sessions.commitSession(session.id, { ctx: recAdmin }, db);
    expect(result.saved).toBe(false);
    expect(result.outcome).toEqual({ saved: 0, kept: 0, failed: 1, unchanged: 0 });
    expect(await priceOf(EK)).toBe(120);
    const { rows } = await query(`SELECT status FROM billing_imports WHERE id = $1`, [
      result.importId,
    ]);
    expect(rows[0].status).toBe("failed");
    const [row] = await rowsOf(session.id);
    expect(row.reason).toBe(
      `Changed since you uploaded (now name "Kit on screen ${T}") — upload again`,
    );
  });

  test("7. nothing to save, another person, and a second commit are refused", async () => {
    const session = await upload(
      { Items: [item(EJ, "Splint", 200), item(EK, "Kit", 999)] },
      file("refusals"),
      recAdmin,
    );
    const empty = await refusal(sessions.commitSession(session.id, { ctx: recAdmin }, db));
    expect([empty.status, empty.message]).toEqual([
      409,
      "Nothing to save: no row is ready and none of the 1 change is overridden. Override the changes you want, or abandon this import",
    ]);
    await decide(session.id, "override", [EK]);
    const other = await refusal(sessions.commitSession(session.id, { ctx: stranger }, db));
    expect(other.status).toBe(403);
    const bad = await refusal(sessions.commitSession("nope", { ctx: recAdmin }, db));
    expect([bad.status, bad.message]).toEqual([400, "Choose a valid import session"]);
    const done = await sessions.commitSession(session.id, { ctx: admin }, db);
    expect(done.session.committed_by).toBe(admin.actorId);
    const twice = await refusal(sessions.commitSession(session.id, { ctx: admin }, db));
    expect(twice.status).toBe(409);
    expect(twice.message).toBe(
      `This import is already saved (import ${done.importId}); its rows are kept as that import's report`,
    );
  });

  test("8. a failure halfway through saves nothing and leaves the session open", async () => {
    const session = await upload(
      { Groups: [{ group_code: `${P}-HALF`, name: `Half ${T}` }] },
      file("halfway"),
      recAdmin,
    );
    const pool = getPool();
    const failing = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (text, params) =>
            /INSERT INTO billing_imports/.test(String(text?.text ?? text))
              ? Promise.reject(new Error("the disk is full"))
              : client.query(text, params),
          release: () => client.release(),
        };
      },
    };
    const error = await refusal(sessions.commitSession(session.id, { ctx: recAdmin }, failing));
    expect(error.message).toBe("the disk is full");
    expect(await groupName(`${P}-HALF`)).toBeNull();
    const again = await sessions.getSession(session.id, db);
    expect(again.status).toBe("open");
    expect(again.live.outcome).toEqual({ saved: 0, kept: 0, failed: 0, unchanged: 0 });
    const { rows } = await query(
      `SELECT status FROM billing_imports WHERE file_name = $1 ORDER BY id`,
      [file("halfway")],
    );
    expect(rows).toEqual([{ status: "failed" }]);
    const retried = await sessions.commitSession(session.id, { ctx: recAdmin }, db);
    expect(retried.outcome.saved).toBe(1);
    expect(await groupName(`${P}-HALF`)).toBe(`Half ${T}`);
  });
});
