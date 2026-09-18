import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/taxCodes.js");

const db = getPool();
const ctx = { actorId: USERS.admin.id, ip: "10.2.2.2" };
const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
const code = (name) => `${name}-${tag}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);

const auditFor = (id) =>
  query(
    `SELECT action, before, after, actor_id FROM billing_audit
      WHERE entity = 'tax_codes' AND entity_id = $1 ORDER BY id`,
    [String(id)],
  ).then((r) => r.rows);

let subgroupId = null;
const addItem = (name, taxCodeId, active = true) =>
  query(
    `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, tax_code_id, is_active)
     VALUES ($1, $2, $3, 100, 'procedure', $4, $5) RETURNING id`,
    [code(`I-${crypto.randomBytes(2).toString("hex")}`), name, subgroupId, taxCodeId, active],
  ).then((r) => r.rows[0].id);

test.describe.serial("P1-16 tax codes service", () => {
  const ids = {};

  test.beforeAll(async () => {
    const group = await query(
      `INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`,
      [code("TG"), `Tax group ${tag}`],
    );
    const sub = await query(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Tax sub') RETURNING id`,
      [group.rows[0].id, code("TS")],
    );
    subgroupId = sub.rows[0].id;
  });

  test("1. create: saved with defaults, stamped and audited", async () => {
    const exempt = await svc.createTaxCode({ code: code("EXEMPT"), sac_hsn: "999312" }, ctx, db);
    expect(exempt).toMatchObject({
      code: code("EXEMPT"),
      sac_hsn: "999312",
      rate_pct: 0,
      is_active: true,
    });
    ids.exempt = exempt.id;
    const gst = await svc.createTaxCode({ code: code("GST18"), rate_pct: "18" }, ctx, db);
    expect(gst).toMatchObject({ rate_pct: 18, sac_hsn: null });
    ids.gst = gst.id;
    const audit = await auditFor(gst.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "create", actor_id: ctx.actorId });
    const stamped = await query(`SELECT created_by, updated_by FROM tax_codes WHERE id = $1`, [
      gst.id,
    ]);
    expect(stamped.rows[0]).toEqual({ created_by: ctx.actorId, updated_by: ctx.actorId });
  });

  test("2. rate must be 0–100 with at most 2 decimals; SAC/HSN 4, 6 or 8 digits", async () => {
    for (const [input, message] of [
      [{ rate_pct: -1 }, /between 0 and 100/],
      [{ rate_pct: 100.01 }, /between 0 and 100/],
      [{ rate_pct: "abc" }, /between 0 and 100/],
      [{ rate_pct: 18.005 }, /at most 2 decimals/],
      [{ sac_hsn: "12345" }, /4, 6 or 8 digits/],
      [{ sac_hsn: "99-31" }, /4, 6 or 8 digits/],
      [{ code: "GST 5" }, /blank or contain spaces/],
    ]) {
      const error = await failure(svc.createTaxCode({ code: code("BAD"), ...input }, ctx, db));
      expect(error?.status, JSON.stringify(input)).toBe(400);
      expect(error.message).toMatch(message);
    }
    for (const [suffix, rate] of [
      ["R029", 0.29],
      ["R100", 100],
      ["R125", 12.5],
    ]) {
      const ok = await svc.createTaxCode({ code: code(suffix), rate_pct: rate }, ctx, db);
      expect(ok.rate_pct, String(rate)).toBe(rate);
    }
    const hsn = await svc.createTaxCode({ code: code("HSN8"), sac_hsn: " 30049099 " }, ctx, db);
    expect(hsn.sac_hsn).toBe("30049099");
  });

  test("3. codes are unique ignoring case", async () => {
    const error = await failure(svc.createTaxCode({ code: code("gst18").toLowerCase() }, ctx, db));
    expect(error.status).toBe(409);
    expect(error.message).toBe(`A tax code with code "${code("GST18")}" already exists`);
    const rename = await failure(svc.updateTaxCode(ids.exempt, { code: code("GST18") }, ctx, db));
    expect(rename.status).toBe(409);
  });

  test("4. update changes only what is sent, and is audited", async () => {
    const updated = await svc.updateTaxCode(ids.gst, { rate_pct: 5, sac_hsn: "999312" }, ctx, db);
    expect(updated).toMatchObject({ code: code("GST18"), rate_pct: 5, sac_hsn: "999312" });
    const cleared = await svc.updateTaxCode(ids.gst, { sac_hsn: "" }, ctx, db);
    expect(cleared.sac_hsn).toBeNull();
    const audit = await auditFor(ids.gst);
    expect(audit[1]).toMatchObject({ action: "update" });
    expect(Number(audit[1].before.rate_pct)).toBe(18);
    expect(Number(audit[1].after.rate_pct)).toBe(5);
    expect((await failure(svc.updateTaxCode(ids.gst, {}, ctx, db))).status).toBe(400);
    expect((await failure(svc.updateTaxCode(-1, { rate_pct: 1 }, ctx, db))).status).toBe(404);
  });

  test("5. the list shows item counts, lowest rate first", async () => {
    await addItem("Dressing", ids.gst);
    await addItem("Old plaster", ids.gst, false);
    const list = await svc.listTaxCodes({}, db);
    const mine = list.filter((t) => t.code.endsWith(tag));
    expect(mine.find((t) => t.id === ids.gst).item_count).toBe(2);
    expect(mine.find((t) => t.id === ids.exempt).item_count).toBe(0);
    const rates = mine.map((t) => t.rate_pct);
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
  });

  test("6. a tax code used by an active item can't be deactivated", async () => {
    const error = await failure(svc.setTaxCodeActive(ids.gst, false, ctx, db));
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      `${code("GST18")} is still used by 1 active item: Dressing. Give it another tax code first.`,
    );
    expect(error.active).toEqual(["Dressing"]);
    await query(`UPDATE service_items SET tax_code_id = $1 WHERE tax_code_id = $2 AND is_active`, [
      ids.exempt,
      ids.gst,
    ]);
    const off = await svc.setTaxCodeActive(ids.gst, false, ctx, db);
    expect(off.is_active).toBe(false);
    const on = await svc.setTaxCodeActive(ids.gst, true, ctx, db);
    expect(on.is_active).toBe(true);
    const actions = (await auditFor(ids.gst)).map((a) => a.action);
    expect(actions.slice(-2)).toEqual(["deactivate", "activate"]);
    const active = await svc.listTaxCodes({ activeOnly: true }, db);
    expect(active.every((t) => t.is_active)).toBe(true);
  });

  test("7. a used tax code can't be deleted; an unused one can", async () => {
    const used = await failure(svc.deleteTaxCode(ids.gst, ctx, db));
    expect(used.status).toBe(409);
    expect(used.message).toBe(
      `${code("GST18")} can't be deleted because it is still used: 1 item uses tax code ${code("GST18")}. Deactivate it instead.`,
    );
    const spare = await svc.createTaxCode({ code: code("SPARE") }, ctx, db);
    expect(await svc.deleteTaxCode(spare.id, ctx, db)).toEqual({ deleted: true, id: spare.id });
    expect((await auditFor(spare.id)).map((a) => a.action)).toEqual(["create", "delete"]);
    expect((await failure(svc.deleteTaxCode(-1, ctx, db))).status).toBe(404);
  });

  test("8. inside a caller's transaction it joins it", async () => {
    const outer = await db.connect();
    try {
      await outer.query("BEGIN");
      await svc.createTaxCode({ code: code("TX") }, ctx, outer);
      await outer.query("ROLLBACK");
    } finally {
      outer.release();
    }
    expect((await query(`SELECT 1 FROM tax_codes WHERE code = $1`, [code("TX")])).rows).toEqual([]);
  });

  test("9. on/off must be a real true or false, and numbers must be numbers", async () => {
    for (const value of ["false", "true", 0, 1, null, undefined]) {
      const error = await failure(svc.setTaxCodeActive(ids.gst, value, ctx, db));
      expect(error?.status, JSON.stringify(value)).toBe(400);
      expect(error.message).toBe("Active must be true or false");
    }
    const still = await query(`SELECT is_active FROM tax_codes WHERE id = $1`, [ids.gst]);
    expect(still.rows[0].is_active, "nothing was switched off").toBe(true);
    for (const rate of [true, false, [], {}, "abc", "1e2", "12,5"]) {
      const error = await failure(svc.updateTaxCode(ids.gst, { rate_pct: rate }, ctx, db));
      expect(error?.status, JSON.stringify(rate)).toBe(400);
    }
    const blank = await svc.updateTaxCode(ids.gst, { rate_pct: "  " }, ctx, db);
    expect(blank.rate_pct, "blank text means 0").toBe(0);
    const text = await svc.updateTaxCode(ids.gst, { rate_pct: " 12.5 " }, ctx, db);
    expect(text.rate_pct).toBe(12.5);
  });
});
