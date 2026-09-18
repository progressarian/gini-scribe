import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/serviceGroups.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.1.1.1" };
const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
const code = (name) => `${name}-${tag}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);

const auditFor = (table, id) =>
  query(
    `SELECT action, before, after, actor_id, ip FROM billing_audit
      WHERE entity = $1 AND entity_id = $2 ORDER BY id`,
    [table, String(id)],
  ).then((r) => r.rows);

const addItem = (subgroupId, name, active = true) =>
  query(
    `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, is_active)
     VALUES ($1, $2, $3, 100, 'procedure', $4) RETURNING id`,
    [code(`I-${name}-${crypto.randomBytes(2).toString("hex")}`), name, subgroupId, active],
  ).then((r) => r.rows[0].id);

test.describe.serial("P1-15 service groups and subgroups service", () => {
  const ids = {};

  test("1. create a group: saved, stamped with who made it, and audited", async () => {
    const group = await svc.createGroup(
      { code: code("LAB"), name: " Lab ", sort_order: 20 },
      ctx,
      db,
    );
    expect(group).toMatchObject({
      code: code("LAB"),
      name: "Lab",
      sort_order: 20,
      is_active: true,
    });
    ids.lab = group.id;
    const stamped = await query(`SELECT created_by, updated_by FROM service_groups WHERE id = $1`, [
      group.id,
    ]);
    expect(stamped.rows[0]).toEqual({ created_by: ctx.actorId, updated_by: ctx.actorId });
    const audit = await auditFor("service_groups", group.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "create",
      before: null,
      actor_id: ctx.actorId,
      ip: ctx.ip,
    });
    expect(audit[0].after).toMatchObject({ code: code("LAB"), name: "Lab" });
    ids.opd = (
      await svc.createGroup({ code: code("OPD"), name: "OPD", sort_order: 10 }, ctx, db)
    ).id;
  });

  test("2. bad input is refused with a clear message", async () => {
    const cases = [
      [{ code: code("lab").toLowerCase(), name: "Dup" }, 409, /already exists/],
      [{ code: "A B", name: "Space" }, 400, /blank or contain spaces/],
      [{ code: "", name: "Empty" }, 400, /blank or contain spaces/],
      [{ code: code("X1"), name: "  " }, 400, /Name can't be blank/],
      [{ code: code("X2"), name: "Order", sort_order: 1.5 }, 400, /whole number/],
    ];
    for (const [input, status, message] of cases) {
      const error = await failure(svc.createGroup(input, ctx, db));
      expect(error?.status, JSON.stringify(input)).toBe(status);
      expect(error.message).toMatch(message);
    }
  });

  test("3. update changes only what is sent, and is audited with before and after", async () => {
    const updated = await svc.updateGroup(ids.lab, { name: "Laboratory" }, ctx, db);
    expect(updated).toMatchObject({ code: code("LAB"), name: "Laboratory", sort_order: 20 });
    const audit = await auditFor("service_groups", ids.lab);
    expect(audit.at(-1)).toMatchObject({ action: "update" });
    expect(audit.at(-1).before.name).toBe("Lab");
    expect(audit.at(-1).after.name).toBe("Laboratory");
    expect((await failure(svc.updateGroup(ids.lab, { code: code("opd") }, ctx, db))).status).toBe(
      409,
    );
    expect((await failure(svc.updateGroup(ids.lab, {}, ctx, db))).status).toBe(400);
    expect((await failure(svc.updateGroup(-1, { name: "X" }, ctx, db))).status).toBe(404);
    const same = await svc.updateGroup(ids.lab, { code: code("lab") }, ctx, db);
    expect(same.code).toBe(code("lab"));
  });

  test("4. subgroups: created under a group, refused under a missing or deactivated one", async () => {
    const bio = await svc.createSubgroup(
      { group_id: ids.lab, code: code("BIO"), name: "Biochemistry", sort_order: 2 },
      ctx,
      db,
    );
    ids.bio = bio.id;
    ids.haem = (
      await svc.createSubgroup(
        { group_id: ids.lab, code: code("HAEM"), name: "Haematology", sort_order: 1 },
        ctx,
        db,
      )
    ).id;
    expect(bio.group_id).toBe(ids.lab);
    expect(
      (
        await failure(
          svc.createSubgroup({ group_id: 999999999, code: code("S0"), name: "X" }, ctx, db),
        )
      ).status,
    ).toBe(404);
    expect(
      (await failure(svc.createSubgroup({ code: code("S1"), name: "X" }, ctx, db))).status,
    ).toBe(400);
    expect(
      (
        await failure(
          svc.createSubgroup({ group_id: ids.opd, code: code("bio"), name: "Dup" }, ctx, db),
        )
      ).status,
    ).toBe(409);
    ids.inactive = (await svc.createGroup({ code: code("OLD"), name: "Old" }, ctx, db)).id;
    await svc.setGroupActive(ids.inactive, false, ctx, db);
    const blocked = await failure(
      svc.createSubgroup({ group_id: ids.inactive, code: code("S2"), name: "X" }, ctx, db),
    );
    expect(blocked.status).toBe(409);
    expect(blocked.message).toMatch(/Old is deactivated/);
  });

  test("5. the list nests subgroups in order, with item counts", async () => {
    await addItem(ids.bio, "HbA1c");
    await addItem(ids.bio, "Lipid");
    await addItem(ids.haem, "CBC");
    const groups = await svc.listGroups({}, db);
    const lab = groups.find((g) => g.id === ids.lab);
    expect(lab.item_count).toBe(3);
    expect(lab.subgroups.map((s) => [s.name, s.item_count])).toEqual([
      ["Haematology", 1],
      ["Biochemistry", 2],
    ]);
    const order = groups.filter((g) => [ids.opd, ids.lab].includes(g.id)).map((g) => g.id);
    expect(order).toEqual([ids.opd, ids.lab]);
    const active = await svc.listGroups({ activeOnly: true }, db);
    expect(active.some((g) => g.id === ids.inactive)).toBe(false);
  });

  test("6. deactivating needs the children deactivated first", async () => {
    const error = await failure(svc.setGroupActive(ids.lab, false, ctx, db));
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      "Laboratory still has 2 active subgroups: Biochemistry, Haematology. Deactivate them first.",
    );
    const sub = await failure(svc.setSubgroupActive(ids.haem, false, ctx, db));
    expect(sub.message).toBe("Haematology still has 1 active item: CBC. Deactivate it first.");
    await query(`UPDATE service_items SET is_active = FALSE WHERE subgroup_id = $1`, [ids.haem]);
    const off = await svc.setSubgroupActive(ids.haem, false, ctx, db);
    expect(off.is_active).toBe(false);
    expect((await auditFor("service_subgroups", ids.haem)).at(-1).action).toBe("deactivate");
    const again = await svc.setSubgroupActive(ids.haem, false, ctx, db);
    expect(again.is_active).toBe(false);
    expect(
      (await auditFor("service_subgroups", ids.haem)).filter((a) => a.action === "deactivate"),
    ).toHaveLength(1);
    const moveError = await failure(
      svc.updateSubgroup(ids.haem, { group_id: ids.inactive }, ctx, db),
    );
    expect(moveError.status).toBe(409);
    const on = await svc.setSubgroupActive(ids.haem, true, ctx, db);
    expect(on.is_active).toBe(true);
  });

  test("7. a used group or subgroup can't be deleted; an unused one can", async () => {
    const group = await failure(svc.deleteGroup(ids.lab, ctx, db));
    expect(group.status).toBe(409);
    expect(group.message).toBe(
      "Laboratory can't be deleted because it is still used: 2 subgroups under Laboratory. Deactivate it instead.",
    );
    const sub = await failure(svc.deleteSubgroup(ids.bio, ctx, db));
    expect(sub.status).toBe(409);
    expect(sub.uses[0].text).toBe("2 items in Biochemistry");
    const spare = await svc.createSubgroup(
      { group_id: ids.opd, code: code("SPARE"), name: "Spare" },
      ctx,
      db,
    );
    expect(await svc.deleteSubgroup(spare.id, ctx, db)).toEqual({ deleted: true, id: spare.id });
    expect((await query(`SELECT 1 FROM service_subgroups WHERE id = $1`, [spare.id])).rows).toEqual(
      [],
    );
    const audit = await auditFor("service_subgroups", spare.id);
    expect(audit.map((a) => a.action)).toEqual(["create", "delete"]);
    expect(audit[1].before.name).toBe("Spare");
    expect((await failure(svc.deleteGroup(-1, ctx, db))).status).toBe(404);
  });

  test("8. an item added while a delete is running still blocks it with the friendly 409", async () => {
    const racer = await db.connect();
    const target = await svc.createSubgroup(
      { group_id: ids.opd, code: code("RACE"), name: "Race" },
      ctx,
      db,
    );
    try {
      await racer.query("BEGIN");
      await racer.query(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind) VALUES ($1, 'Racing item', $2, 1, 'other')`,
        [code("I-RACE"), target.id],
      );
      const deleting = failure(svc.deleteSubgroup(target.id, ctx, db));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await racer.query("COMMIT");
      const error = await deleting;
      expect(error?.status).toBe(409);
      expect(error.message).toMatch(/1 item in Race/);
    } finally {
      await racer.query("ROLLBACK").catch(() => {});
      racer.release();
    }
  });

  test("9. a failed write leaves no row and no audit entry", async () => {
    const before = await query(`SELECT count(*)::int AS n FROM billing_audit`);
    const error = await failure(
      svc.createGroup({ code: code("GHOST"), name: "Ghost" }, { actorId: -999, ip: null }, db),
    );
    expect(error).not.toBeNull();
    expect(
      (await query(`SELECT 1 FROM service_groups WHERE code = $1`, [code("GHOST")])).rows,
    ).toEqual([]);
    const after = await query(`SELECT count(*)::int AS n FROM billing_audit`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("10. inside a caller's transaction the service joins it: all or nothing", async () => {
    const outer = await db.connect();
    try {
      await outer.query("BEGIN");
      const group = await svc.createGroup({ code: code("TX1"), name: "Tx one" }, ctx, outer);
      await svc.createSubgroup(
        { group_id: group.id, code: code("TX1S"), name: "Tx sub" },
        ctx,
        outer,
      );
      const dup = await failure(svc.createGroup({ code: code("tx1"), name: "Tx dup" }, ctx, outer));
      expect(dup.status, "a refusal inside does not break the outer transaction").toBe(409);
      await svc.createGroup({ code: code("TX2"), name: "Tx two" }, ctx, outer);
      await outer.query("ROLLBACK");
    } finally {
      outer.release();
    }
    const left = await query(`SELECT code FROM service_groups WHERE code = ANY($1)`, [
      [code("TX1"), code("TX2")],
    ]);
    expect(left.rows, "rolled back with the caller").toEqual([]);
    const audit = await query(
      `SELECT count(*)::int AS n FROM billing_audit WHERE after->>'code' = ANY($1)`,
      [[code("TX1"), code("TX1S"), code("TX2")]],
    );
    expect(audit.rows[0].n).toBe(0);

    const committed = await db.connect();
    try {
      await committed.query("BEGIN");
      await svc.createGroup({ code: code("TX3"), name: "Tx three" }, ctx, committed);
      await committed.query("COMMIT");
    } finally {
      committed.release();
    }
    const kept = await query(`SELECT code FROM service_groups WHERE code = $1`, [code("TX3")]);
    expect(kept.rows).toHaveLength(1);
  });

  test("11. a connection with no open transaction is refused", async () => {
    const bare = await db.connect();
    try {
      const error = await failure(svc.createGroup({ code: code("BARE"), name: "Bare" }, ctx, bare));
      expect(error.message).toMatch(/no open transaction/);
    } finally {
      bare.release();
    }
    expect(
      (await query(`SELECT 1 FROM service_groups WHERE code = $1`, [code("BARE")])).rows,
    ).toEqual([]);
  });

  test("12. extra keys in ctx can't change what the audit row says", async () => {
    const group = await svc.createGroup(
      { code: code("CTX"), name: "Ctx" },
      { ...ctx, entity: "forged", action: "delete", entityId: "999" },
      db,
    );
    const [row] = await auditFor("service_groups", group.id);
    expect(row).toMatchObject({ action: "create", actor_id: ctx.actorId, ip: ctx.ip });
  });

  test("13. names are unique under the same parent, ignoring case", async () => {
    const group = await failure(
      svc.createGroup({ code: code("LAB2"), name: "LABORATORY" }, ctx, db),
    );
    expect(group.status).toBe(409);
    expect(group.message).toBe('A group called "Laboratory" already exists');
    const sub = await failure(
      svc.createSubgroup({ group_id: ids.lab, code: code("BIO2"), name: "biochemistry" }, ctx, db),
    );
    expect(sub.message).toBe('A subgroup called "Biochemistry" already exists in Laboratory');
    const elsewhere = await svc.createSubgroup(
      { group_id: ids.opd, code: code("BIO3"), name: "Biochemistry" },
      ctx,
      db,
    );
    expect(elsewhere.group_id).toBe(ids.opd);
    const rename = await failure(svc.updateSubgroup(ids.haem, { name: "BIOCHEMISTRY" }, ctx, db));
    expect(rename.status).toBe(409);
    const move = await failure(svc.updateSubgroup(elsewhere.id, { group_id: ids.lab }, ctx, db));
    expect(move.status, "moving into a group that already has that name").toBe(409);
    const renameGroup = await failure(svc.updateGroup(ids.opd, { name: "laboratory" }, ctx, db));
    expect(renameGroup.status).toBe(409);
    const own = await svc.updateGroup(ids.lab, { name: "LABORATORY" }, ctx, db);
    expect(own.name, "changing the case of its own name is fine").toBe("LABORATORY");
  });

  test("14. on/off must be a real true or false, and sort order a real whole number", async () => {
    for (const value of ["false", "true", 0, 1, null]) {
      const group = await failure(svc.setGroupActive(ids.lab, value, ctx, db));
      expect(group?.status, JSON.stringify(value)).toBe(400);
      expect(group.message).toBe("Active must be true or false");
      const sub = await failure(svc.setSubgroupActive(ids.bio, value, ctx, db));
      expect(sub?.status, JSON.stringify(value)).toBe(400);
    }
    const still = await query(`SELECT is_active FROM service_groups WHERE id = $1`, [ids.lab]);
    expect(still.rows[0].is_active).toBe(true);
    for (const order of [true, [], "abc", "1.5"]) {
      const error = await failure(svc.updateGroup(ids.lab, { sort_order: order }, ctx, db));
      expect(error?.status, JSON.stringify(order)).toBe(400);
    }
    const text = await svc.updateGroup(ids.lab, { sort_order: " 7 " }, ctx, db);
    expect(text.sort_order).toBe(7);
  });
});
