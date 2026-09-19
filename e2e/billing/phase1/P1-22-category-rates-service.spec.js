import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/categoryRates.js");
const schemes = await import("../../../server/services/patientSchemes.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.6.6.6" };
const tag = crypto.randomBytes(3).toString("hex");
const c = (name) => `${name}_${tag}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);
const ids = {};

const refused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, label).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};
const rowOf = (grid, id) => grid.items.find((i) => i.service_item_id === id);
const save = (extra) =>
  svc.saveRate({ scheme_code: c("cghs"), service_item_id: ids.consult, ...extra }, ctx, db);
const auditFor = (key) =>
  query(
    `SELECT action, before, after FROM billing_audit WHERE entity = 'category_item_rates' AND entity_id = $1 ORDER BY id`,
    [key],
  ).then((r) => r.rows);

test.describe.serial("P1-22 category rates service", () => {
  test.beforeAll(async () => {
    await schemes.createScheme({ code: c("cghs"), label: `CGHS ${tag}` }, db, ctx);
    await schemes.createScheme(
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      db,
      ctx,
    );
    await schemes.createScheme({ code: c("retired"), label: `Retired ${tag}` }, db, ctx);
    await schemes.updateScheme(c("retired"), { is_active: false }, db, ctx);
    const group = await query(
      `INSERT INTO service_groups (code, name) VALUES ($1, $2) RETURNING id`,
      [`RG-${tag}`, `Rates ${tag}`],
    );
    ids.group = group.rows[0].id;
    const sub = await query(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, 'Rates sub') RETURNING id`,
      [ids.group, `RS-${tag}`],
    );
    ids.sub = sub.rows[0].id;
    const item = (code, name, price, active = true) =>
      query(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, is_active) VALUES ($1, $2, $3, $4, 'procedure', $5) RETURNING id`,
        [`${code}-${tag}`, name, ids.sub, price, active],
      ).then((r) => r.rows[0].id);
    ids.consult = await item("CONS", "Consultant meet", 1000);
    ids.dressing = await item("DRESS", "Dressing", 300);
    ids.off = await item("OFF", "Old item", 50, false);
  });

  test("1. with no rates every item shows its General price", async () => {
    const grid = await svc.rateGrid(c("paid"), { groupId: ids.group, date: "2026-10-01" }, db);
    expect(grid.category).toMatchObject({
      code: c("paid"),
      parent_code: c("cghs"),
      display_label: `CGHS ${tag} › CGHS Paid`,
    });
    expect(grid.items.map((i) => i.name)).toEqual(["Consultant meet", "Dressing"]);
    expect(rowOf(grid, ids.consult)).toMatchObject({
      base_price: 1000,
      own: null,
      rate: 1000,
      rate_source: "base",
      bill_name: "Consultant meet",
      bill_name_source: "base",
      bill_code: null,
      bill_code_source: null,
    });
  });

  test("2. a sub-category inherits the parent's rate, and its own row overrides it", async () => {
    const saved = await save({
      rate: 700,
      bill_name: "Consultant meet CC02",
      bill_code: "CC02",
      valid_from: "2026-10-01",
    });
    expect(saved.rate).toMatchObject({
      rate: 700,
      bill_code: "CC02",
      valid_from: "2026-10-01",
      valid_to: null,
    });
    expect(saved.closed).toEqual([]);
    const inherited = rowOf(
      await svc.rateGrid(c("paid"), { groupId: ids.group, date: "2026-10-15" }, db),
      ids.consult,
    );
    expect(inherited).toMatchObject({
      rate: 700,
      rate_source: "parent",
      bill_code: "CC02",
      bill_code_source: "parent",
      own: null,
    });
    await svc.saveRate(
      { scheme_code: c("paid"), service_item_id: ids.consult, rate: 650, valid_from: "2026-10-01" },
      ctx,
      db,
    );
    const own = rowOf(
      await svc.rateGrid(c("paid"), { groupId: ids.group, date: "2026-10-15" }, db),
      ids.consult,
    );
    expect(own).toMatchObject({
      rate: 650,
      rate_source: "own",
      bill_name: "Consultant meet CC02",
      bill_name_source: "parent",
      bill_code: "CC02",
      bill_code_source: "parent",
    });
    const beforeStart = rowOf(
      await svc.rateGrid(c("paid"), { groupId: ids.group, date: "2026-09-30" }, db),
      ids.consult,
    );
    expect(beforeStart.rate_source, "not yet started").toBe("base");
  });

  test("3. saving the same start date again updates that row", async () => {
    const updated = await save({ rate: 720, bill_code: "CC02", valid_from: "2026-10-01" });
    expect(updated.rate.rate).toBe(720);
    const history = await svc.rateHistory({ schemeCode: c("cghs"), itemId: ids.consult }, db);
    expect(history).toHaveLength(1);
    const audit = await auditFor(`${c("cghs")}:${ids.consult}:2026-10-01`);
    expect(audit.map((a) => a.action)).toEqual(["create", "update"]);
    expect(Number(audit[1].before.rate)).toBe(700);
    expect(Number(audit[1].after.rate)).toBe(720);
  });

  test("4. a new open-ended rate card ends the current one the day before", async () => {
    const next = await save({ rate: 800, bill_code: "CC02", valid_from: "2027-04-01" });
    expect(next.closed).toEqual([
      expect.objectContaining({ valid_from: "2026-10-01", valid_to: "2027-03-31", rate: 720 }),
    ]);
    const history = await svc.rateHistory({ schemeCode: c("cghs"), itemId: ids.consult }, db);
    expect(history.map((h) => [h.valid_from, h.valid_to, h.rate])).toEqual([
      ["2027-04-01", null, 800],
      ["2026-10-01", "2027-03-31", 720],
    ]);
    const march = rowOf(
      await svc.rateGrid(c("cghs"), { groupId: ids.group, date: "2027-03-31" }, db),
      ids.consult,
    );
    expect(march).toMatchObject({ rate: 720, next_valid_from: "2027-04-01" });
    const april = rowOf(
      await svc.rateGrid(c("cghs"), { groupId: ids.group, date: "2027-04-01" }, db),
      ids.consult,
    );
    expect(april).toMatchObject({ rate: 800, next_valid_from: null });
    const closedAudit = await auditFor(`${c("cghs")}:${ids.consult}:2026-10-01`);
    expect(closedAudit.at(-1)).toMatchObject({ action: "update" });
    expect(closedAudit.at(-1).after.valid_to).toBe("2027-03-31");
  });

  test("5. any other overlap is refused, naming the dates", async () => {
    await refused(
      save({ rate: 1, valid_from: "2026-12-01" }),
      409,
      /overlap another rate for the same item \(2026-10-01 to 2027-03-31; 2027-04-01 to open-ended\)/,
    );
    await refused(
      save({ rate: 1, valid_from: "2027-05-01", valid_to: "2027-05-31" }),
      409,
      /2027-04-01 to open-ended/,
    );
    await refused(
      save({ rate: 1, valid_from: "2027-03-01", valid_to: "2027-04-15" }),
      409,
      /\(2026-10-01 to 2027-03-31; 2027-04-01 to open-ended\)/,
    );
    const history = await svc.rateHistory({ schemeCode: c("cghs"), itemId: ids.consult }, db);
    expect(history, "nothing changed").toHaveLength(2);
  });

  test("6. bad input is refused with a clear message", async () => {
    const cases = [
      [{ rate: -1 }, 400, /can't be negative/],
      [{ rate: 1.005 }, 400, /at most 2 decimals/],
      [{ rate: true }, 400, /amount in rupees/],
      [{ rate: 1, valid_from: "2026-02-30" }, 400, /date like/],
      [{ rate: 1, valid_from: "01-10-2026" }, 400, /date like/],
      [
        { rate: 1, valid_from: "2030-05-02", valid_to: "2030-05-01" },
        400,
        /can't be before the start/,
      ],
      [{ valid_from: "2030-01-01" }, 400, /must change something/],
      [{ bill_code: "C C", valid_from: "2030-01-01" }, 400, /can't contain spaces/],
      [{ bill_name: 5, valid_from: "2030-01-01" }, 400, /must be text/],
      [{ rate: 1, scheme_code: c("retired") }, 409, /is retired/],
      [{ rate: 1, scheme_code: "nope_nope" }, 404, /doesn't exist/],
      [{ rate: 1, service_item_id: ids.off }, 409, /is deactivated/],
      [{ rate: 1, service_item_id: 999999999 }, 404, /doesn't exist/],
      [{ rate: 1, service_item_id: "abc" }, 400, /Choose an item/],
    ];
    for (const [extra, status, message] of cases) {
      await refused(save(extra), status, message, JSON.stringify(extra));
    }
  });

  test("7. a rate can be deleted, and the delete is audited", async () => {
    await svc.saveRate(
      {
        scheme_code: c("cghs"),
        service_item_id: ids.dressing,
        rate: 250,
        valid_from: "2026-10-01",
      },
      ctx,
      db,
    );
    expect(
      await svc.deleteRate(
        { scheme_code: c("cghs"), service_item_id: ids.dressing, valid_from: "2026-10-01" },
        ctx,
        db,
      ),
    ).toEqual({ deleted: true, previous: null, reopened: null });
    const audit = await auditFor(`${c("cghs")}:${ids.dressing}:2026-10-01`);
    expect(audit.map((a) => a.action)).toEqual(["create", "delete"]);
    await refused(
      svc.deleteRate(
        { scheme_code: c("cghs"), service_item_id: ids.dressing, valid_from: "2026-10-01" },
        ctx,
        db,
      ),
      404,
    );
  });

  test("8. two rate cards saved at the same moment never overlap", async () => {
    const first = await db.connect();
    try {
      await first.query("BEGIN");
      await svc.saveRate(
        {
          scheme_code: c("paid"),
          service_item_id: ids.consult,
          rate: 600,
          valid_from: "2027-06-01",
        },
        ctx,
        first,
      );
      const second = svc.saveRate(
        {
          scheme_code: c("paid"),
          service_item_id: ids.consult,
          rate: 610,
          valid_from: "2027-09-01",
        },
        ctx,
        db,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query("COMMIT");
      const saved = await second;
      expect(saved.closed.map((r) => [r.valid_from, r.valid_to])).toEqual([
        ["2027-06-01", "2027-08-31"],
      ]);
    } finally {
      await first.query("ROLLBACK").catch(() => {});
      first.release();
    }
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM category_item_rates a JOIN category_item_rates b
          ON a.scheme_code = b.scheme_code AND a.service_item_id = b.service_item_id AND a.valid_from < b.valid_from
       WHERE a.scheme_code = $1 AND a.service_item_id = $2
         AND (a.valid_to IS NULL OR b.valid_from <= a.valid_to)`,
      [c("paid"), ids.consult],
    );
    expect(rows[0].n, "no two rows cover the same day").toBe(0);
  });

  test("9. inside a caller's transaction it joins it", async () => {
    const outer = await db.connect();
    try {
      await outer.query("BEGIN");
      await svc.saveRate(
        {
          scheme_code: c("cghs"),
          service_item_id: ids.dressing,
          rate: 1,
          valid_from: "2031-01-01",
        },
        ctx,
        outer,
      );
      await outer.query("ROLLBACK");
    } finally {
      outer.release();
    }
    expect(await svc.rateHistory({ schemeCode: c("cghs"), itemId: ids.dressing }, db)).toEqual([]);
  });

  test("10. undoing a mistaken rate card: the delete offers to reopen the previous rate", async () => {
    const item = ids.dressing;
    const base = { scheme_code: c("cghs"), service_item_id: item };
    await svc.saveRate({ ...base, rate: 200, valid_from: "2028-01-01" }, ctx, db);
    const mistake = await svc.saveRate({ ...base, rate: 999, valid_from: "2028-06-01" }, ctx, db);
    expect(mistake.closed.map((r) => r.valid_to)).toEqual(["2028-05-31"]);
    const asked = await svc.deleteRate({ ...base, valid_from: "2028-06-01" }, ctx, db);
    expect(asked, "by default the previous rate is only reported").toMatchObject({
      deleted: true,
      reopened: null,
      previous: { valid_from: "2028-01-01", valid_to: "2028-05-31", rate: 200 },
    });
    const gap = (
      await svc.rateGrid(c("cghs"), { groupId: ids.group, date: "2028-07-01" }, db)
    ).items.find((i) => i.service_item_id === item);
    expect(gap.rate_source, "left alone, June onwards falls back to the General price").toBe(
      "base",
    );

    await svc.saveRate({ ...base, rate: 999, valid_from: "2028-06-01" }, ctx, db);
    const undone = await svc.deleteRate(
      { ...base, valid_from: "2028-06-01", reopen_previous: true },
      ctx,
      db,
    );
    expect(undone.reopened).toMatchObject({ valid_from: "2028-01-01", valid_to: null, rate: 200 });
    const july = (
      await svc.rateGrid(c("cghs"), { groupId: ids.group, date: "2028-07-01" }, db)
    ).items.find((i) => i.service_item_id === item);
    expect(july).toMatchObject({ rate: 200, rate_source: "own" });
    const audit = await auditFor(`${c("cghs")}:${item}:2028-01-01`);
    expect(audit.at(-1)).toMatchObject({ action: "update" });
    expect(audit.at(-1).after.valid_to).toBeNull();

    const alone = { scheme_code: c("paid"), service_item_id: item };
    await svc.saveRate(
      { ...alone, rate: 5, valid_from: "2029-01-01", valid_to: "2029-01-31" },
      ctx,
      db,
    );
    const lonely = await failure(
      svc.deleteRate({ ...alone, valid_from: "2029-01-01", reopen_previous: true }, ctx, db),
    );
    expect(lonely?.status).toBe(409);
    expect(lonely.message).toMatch(/nothing to reopen/);
    expect(
      (await svc.rateHistory({ schemeCode: c("paid"), itemId: item }, db)).map((r) => r.valid_from),
      "the refused reopen undid the delete too",
    ).toContain("2029-01-01");
    await refused(
      svc.deleteRate({ ...alone, valid_from: "2029-01-01", reopen_previous: "yes" }, ctx, db),
      400,
      /true or false/,
    );
  });

  test("11. a rate starting in the past is flagged so the screen can ask first", async () => {
    const past = await svc.saveRate(
      {
        scheme_code: c("cghs"),
        service_item_id: ids.dressing,
        bill_code: "OLD1",
        valid_from: "2020-01-01",
        valid_to: "2020-12-31",
      },
      ctx,
      db,
    );
    expect(past.starts_in_past).toBe(true);
    const future = await svc.saveRate(
      {
        scheme_code: c("cghs"),
        service_item_id: ids.dressing,
        bill_code: "NEW1",
        valid_from: "2035-01-01",
      },
      ctx,
      db,
    );
    expect(future.starts_in_past).toBe(false);
  });
});
