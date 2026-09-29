import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { buildTestEnv, repoRoot } from "../../setup/testEnv.mjs";
import {
  autoConsultation,
  extraVisit,
  newTag,
  refused,
  setUp,
  tearDown,
  today,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const aliases = await import("../../../server/services/billing/serviceItemAliases.js");
const serviceItems = await import("../../../server/services/billing/serviceItems.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const payments = await import("../../../server/services/billing/payments.js");
const testMatch = await import("../../../server/services/billing/testMatch.js");
const testCancel = await import("../../../server/services/giniflow/testCancel.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: 9001, ip: "10.9.18.1" };
const RECEPTION = "/giniflow/station/reception";
const M = "/api/billing/master";
const visits = {};
const cat = {};
const items = {};
const codes = {};
let ids;
let autoBefore;

const ORDERED = {
  lipid: `P4 LIPID PROFILE ${tag}`,
  mystery: `P4 Mystery ${tag}`,
  screen: `P4 Lipid Screen ${tag}`,
  thyro: `P4 Thyro Screen ${tag}`,
  uacr: `P4 Microalbumin/Creatinine Ratio ${tag}`,
  cancelled: `P4 Cancelled Only ${tag}`,
  script: `P4 Script Name ${tag}`,
};

async function catalogue(key, name) {
  cat[key] = (
    await one(
      `INSERT INTO giniflow_test_catalog (test_name, price, category) VALUES ($1, 100, 'lab')
       RETURNING id`,
      [name],
    )
  ).id;
}

async function item(key, code, name, price, extra = {}) {
  codes[key] = `P4-${code}-${tag}`;
  items[key] = (
    await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [codes[key], name, ids.subgroup, price, extra.kind ?? "test", extra.testCatalogId ?? null],
    )
  ).id;
}

async function order(visitId, tests) {
  const made = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 0, 'payment_pending', 'lab') RETURNING id`,
    [visitId, tests.reduce((sum, t) => sum + t.price, 0)],
  );
  for (const t of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price, status)
       VALUES ($1, $2, $3, $4)`,
      [made.id, t.name, t.price, t.status ?? "ordered"],
    );
  }
  return made.id;
}

const liveItems = (visitId) =>
  query(`SELECT service_item_id FROM bill_lines WHERE visit_id = $1 AND is_live`, [visitId]).then(
    (r) => r.rows.map((row) => row.service_item_id),
  );

async function call(method, url, data) {
  const api = await apiAs("admin");
  const response = await api[method](url, data === undefined ? undefined : { data });
  const body = await response.json();
  await api.dispose();
  return { status: response.status(), body };
}

const aliasNames = (itemId) =>
  query(`SELECT name FROM service_item_aliases WHERE service_item_id = $1 ORDER BY name`, [
    itemId,
  ]).then((r) => r.rows.map((row) => row.name));

const matched = async (name) => (await testMatch.catalogTestsFor(db, [name])).get(name);

function linkScript(...args) {
  const env = buildTestEnv();
  assertTestDatabase(env.DATABASE_URL);
  expect(env.DATABASE_URL).toContain("localhost:5435/gini_scribe_test");
  const run = spawnSync(process.execPath, ["scripts/link-ordered-names.mjs", ...args], {
    cwd: path.join(repoRoot, "server"),
    env,
    encoding: "utf8",
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const viewSwitch = (page) => page.getByRole("group", { name: "Services view" });
const orderedTable = (page) => page.getByRole("table", { name: "Ordered names with no price" });
const orderedTab = (page) =>
  page
    .getByRole("tablist", { name: "Not priced lists" })
    .getByRole("tab", { name: /Ordered names with no price/ });

async function openOrderedNames(page, needle) {
  await loginAs(page, "admin");
  await gotoReady(page, "/settings/services", () =>
    viewSwitch(page).getByRole("button", { name: /^Not priced/ }),
  );
  await viewSwitch(page)
    .getByRole("button", { name: /^Not priced/ })
    .click();
  await orderedTab(page).click();
  await page.getByRole("searchbox", { name: "Search this list" }).fill(needle);
}

async function noSideScroll(page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

test.describe.serial("P4C-18 also billed as names for services", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    await catalogue("lipid", `P4 Lipid panel ${tag}`);
    await catalogue("uacr", `P4 UACR ${tag}`);
    await catalogue("thyro", `P4 Thyroid ${tag}`);
    await item("lipid", "LIP", `P4 Lipid Profile Service ${tag}`, 450, {
      testCatalogId: cat.lipid,
    });
    await item("uacr", "UA", `P4 Urine Microalbumin Creatinine Ratio ${tag}`, 700, {
      testCatalogId: cat.uacr,
    });
    await item("thyro", "TH", `P4 Thyroid Service ${tag}`, 300, { testCatalogId: cat.thyro });
    await item("proc", "PR", `P4 Dressing Pack ${tag}`, 80, { kind: "procedure" });
    for (const label of ["C18A", "C18B", "C18C"]) {
      visits[label] = await extraVisit(ids, label);
      await query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role) VALUES ($1, $2, 'doctor')`,
        [visits[label].visit, "doctor_done"],
      );
    }
    visits.C18A.order = await order(visits.C18A.visit, [
      { name: ORDERED.lipid, price: 450 },
      { name: ORDERED.mystery, price: 90 },
    ]);
    visits.C18B.order = await order(visits.C18B.visit, [
      { name: ORDERED.screen, price: 400 },
      { name: ORDERED.thyro, price: 300 },
      { name: ORDERED.uacr, price: 700 },
      { name: ORDERED.cancelled, price: 50, status: "cancelled" },
    ]);
    visits.C18C.order = await order(visits.C18C.visit, [{ name: ORDERED.uacr, price: 700 }]);
  });

  test.afterAll(async () => {
    try {
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
      const visitIds = Object.values(visits).map((v) => v.visit);
      await query(`DELETE FROM giniflow_test_cancellations WHERE visit_id = ANY($1::uuid[])`, [
        visitIds,
      ]).catch(() => {});
    } finally {
      await tearDown(ids);
    }
  });

  test("1. an alias prices an ordered name: prefilled on open, gone from the no-price list", async ({
    page,
  }) => {
    expect(await matched(ORDERED.lipid)).toBeNull();
    const added = await call("post", `${M}/items/${items.lipid}/aliases`, {
      name: `  ${ORDERED.lipid} `,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ service_item_id: items.lipid, name: ORDERED.lipid });
    expect(added.body.flat_name).toBe(ORDERED.lipid.toLowerCase().replace(/[^a-z0-9]/g, ""));
    expect(await matched(ORDERED.lipid)).toBe(cat.lipid);
    expect(await matched(ORDERED.lipid.toLowerCase())).toBe(cat.lipid);

    const api = await apiAs("reception");
    const opened = await api.post(`/api/billing/visits/${visits.C18A.visit}/bills`, { data: {} });
    expect(opened.status()).toBe(200);
    const notPriced = await (
      await api.get(`/api/billing/visits/${visits.C18A.visit}/not-priced`)
    ).json();
    await api.dispose();
    expect(await liveItems(visits.C18A.visit)).toEqual([items.lipid]);
    expect(notPriced).toEqual([ORDERED.mystery]);

    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visits.C18A.visit}`, () =>
      page.getByRole("region", { name: "Ordered tests with no price" }),
    );
    const unpriced = page.getByRole("region", { name: "Ordered tests with no price" });
    await expect(unpriced).toContainText(ORDERED.mystery);
    await expect(unpriced).not.toContainText(ORDERED.lipid);
    await expect(unpriced).toContainText(
      "Ask an admin to link this name to a service or create the item.",
    );
    await expect(page.getByRole("region", { name: "Bill lines" })).toContainText(
      `P4 Lipid Profile Service ${tag}`,
    );
  });

  test("2. reception money pairs the aliased test with its line, so it isn't collected twice", async () => {
    const draft = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      visits.C18A.visit,
    ]);
    const { uncovered } = await one(`SELECT ${payments.UNCOVERED_SQL("$1", "$2")} AS uncovered`, [
      draft.id,
      visits.C18A.order,
    ]);
    expect(Number(uncovered)).toBe(90);
    const api = await apiAs("reception");
    const body = await (
      await api.get("/api/billing/counter/patients", { params: { q: tag } })
    ).json();
    await api.dispose();
    const row = [...body.toBill, ...body.billed, ...body.waiting].find(
      (r) => r.name === `P4 C18A ${tag}`,
    );
    expect(row.hints).toMatchObject({ notPriced: 1 });
  });

  test("2b. cancelling the aliased test on the floor releases its bill line", async () => {
    const lipidTest = await one(
      `SELECT id FROM giniflow_lab_order_tests WHERE lab_order_id = $1 AND test_name = $2`,
      [visits.C18A.order, ORDERED.lipid],
    );
    await testCancel.cancelTest(
      {
        target: { orderId: visits.C18A.order, testId: lipidTest.id },
        reason: "patient_declined",
        source: "station",
        actorId: USERS.reception.id,
        actorRole: "reception",
      },
      db,
    );
    expect(await liveItems(visits.C18A.visit)).toEqual([]);
  });

  test("3. refusals: duplicate, non-test item, another service's test name, own test name, blank", async () => {
    await refused(
      aliases.addAlias(items.uacr, { name: ORDERED.lipid.toUpperCase() }, admin, db),
      409,
      new RegExp(`already billed as ${codes.lipid}`),
      "an alias of another item",
    );
    await refused(
      aliases.addAlias(items.lipid, { name: ORDERED.lipid }, admin, db),
      409,
      new RegExp(`already billed as ${codes.lipid}`),
      "the same alias twice",
    );
    await refused(
      aliases.addAlias(items.proc, { name: `P4 Pack Alias ${tag}` }, admin, db),
      400,
      /Only test items/,
      "a procedure item",
    );
    await refused(
      aliases.addAlias(items.lipid, { name: `p4-uacr-${tag}` }, admin, db),
      409,
      new RegExp(`already the name of service ${codes.uacr}`),
      "another service's lab test name",
    );
    await refused(
      aliases.addAlias(items.lipid, { name: `P4 LIPID PANEL ${tag}` }, admin, db),
      409,
      /no need to add it/,
      "its own lab test name",
    );
    await refused(aliases.addAlias(items.lipid, { name: "   " }, admin, db), 400, /blank/, "blank");
    await refused(
      aliases.addAlias(items.lipid, { name: "--" }, admin, db),
      400,
      /letter or digit/,
      "punctuation only",
    );
    const blank = await call("post", `${M}/items/${items.lipid}/aliases`, { name: " " });
    expect(blank.status).toBe(400);
    const dup = await call("post", `${M}/items/${items.uacr}/aliases`, { name: ORDERED.lipid });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain(codes.lipid);
    const proc = await call("post", `${M}/items/${items.proc}/aliases`, { name: `P4 X ${tag}` });
    expect(proc.status).toBe(400);
    expect(await aliasNames(items.uacr)).toEqual([]);
    expect(await aliasNames(items.proc)).toEqual([]);
    const reception = await apiAs("reception");
    const forbidden = await reception.post(`${M}/items/${items.lipid}/aliases`, {
      data: { name: `P4 Nope ${tag}` },
    });
    await reception.dispose();
    expect(forbidden.status()).toBe(403);
  });

  test("4. removing an alias makes the name unpriced again, and both changes are audited", async () => {
    const added = await call("post", `${M}/items/${items.lipid}/aliases`, {
      name: ORDERED.screen,
    });
    expect(added.status).toBe(201);
    expect(await matched(ORDERED.screen)).toBe(cat.lipid);
    expect(await visitLines.notPricedForVisit(visits.C18B.visit, db)).not.toContain(ORDERED.screen);
    const listed = await call("get", `${M}/items/${items.lipid}/aliases`);
    expect(listed.body.map((a) => a.name).sort()).toEqual([ORDERED.lipid, ORDERED.screen].sort());
    const { items: rows } = await serviceItems.listItems({ q: codes.lipid }, db);
    expect(rows[0].aliases.map((a) => a.name).sort()).toEqual(
      [ORDERED.lipid, ORDERED.screen].sort(),
    );

    const removed = await call("delete", `${M}/items/${items.lipid}/aliases/${added.body.id}`);
    expect(removed.status).toBe(200);
    expect(await matched(ORDERED.screen)).toBeNull();
    expect(await visitLines.notPricedForVisit(visits.C18B.visit, db)).toContain(ORDERED.screen);
    const audit = await query(
      `SELECT action FROM billing_audit WHERE entity = 'service_item_aliases' AND entity_id = $1
        ORDER BY at`,
      [String(added.body.id)],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(["create", "delete"]);
    const again = await call("delete", `${M}/items/${items.lipid}/aliases/${added.body.id}`);
    expect(again.status).toBe(404);
  });

  test("5. a deactivated item's alias does not price", async () => {
    await aliases.addAlias(items.thyro, { name: ORDERED.thyro }, admin, db);
    expect(await matched(ORDERED.thyro)).toBe(cat.thyro);
    await serviceItems.setItemActive(items.thyro, false, admin, db);
    try {
      expect(await matched(ORDERED.thyro)).toBeNull();
      expect(await visitLines.notPricedForVisit(visits.C18B.visit, db)).toContain(ORDERED.thyro);
    } finally {
      await serviceItems.setItemActive(items.thyro, true, admin, db);
    }
    expect(await matched(ORDERED.thyro)).toBe(cat.thyro);
  });

  test("6. the not-priced list shows ordered names with counts, without priced or cancelled ones", async () => {
    const { status, body } = await call("get", `${M}/items/not-priced`);
    expect(status).toBe(200);
    const mine = body.orderedNames.filter((row) => row.test_name.endsWith(tag));
    const byName = Object.fromEntries(mine.map((row) => [row.test_name, row]));
    expect(Object.keys(byName).sort()).toEqual(
      [ORDERED.mystery, ORDERED.screen, ORDERED.uacr].sort(),
    );
    expect(byName[ORDERED.uacr]).toMatchObject({
      times_ordered: 2,
      last_ordered: await today(),
    });
    expect(byName[ORDERED.uacr].suggestion).toMatchObject({
      item_id: items.uacr,
      code: codes.uacr,
    });
    expect(byName[ORDERED.mystery].times_ordered).toBe(1);
  });

  test("7. linking a name from the Not priced tab removes its row", async ({ page }) => {
    await openOrderedNames(page, tag);
    const table = orderedTable(page);
    const row = table.getByRole("row", { name: new RegExp(ORDERED.uacr.replace("/", "\\/")) });
    await expect(row).toContainText("2");
    await expect(row).toContainText(await today());
    const countBefore = Number((await orderedTab(page).innerText()).match(/\d+/)[0]);
    await row
      .getByRole("searchbox", { name: `Search services for ${ORDERED.uacr}` })
      .fill(codes.uacr);
    await row.getByRole("button", { name: new RegExp(`^Link to ${codes.uacr} — `) }).click();
    await expect(row).toHaveCount(0);
    await expect(orderedTab(page)).toContainText(String(countBefore - 1));
    expect(await aliasNames(items.uacr)).toEqual([ORDERED.uacr]);
    expect(await matched(ORDERED.uacr)).toBe(cat.uacr);
  });

  test("8. the item dialog adds and removes also-billed-as names", async ({ page }) => {
    const extra = `P4 Thyroid Alt ${tag}`;
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/services", () =>
      page.getByRole("searchbox", { name: "Search items" }),
    );
    await page.getByRole("searchbox", { name: "Search items" }).fill(codes.thyro);
    await page.getByRole("button", { name: `Edit P4 Thyroid Service ${tag}`, exact: true }).click();
    const section = page.getByRole("dialog").getByRole("region", { name: "Also billed as" });
    const names = section.getByRole("list", { name: "Also billed as names" });
    await expect(names).toContainText(ORDERED.thyro);
    await section.getByLabel("Add a name").fill(extra);
    await section.getByRole("button", { name: "Add", exact: true }).click();
    await expect(names).toContainText(extra);
    await expect(section.getByLabel("Add a name")).toHaveValue("");
    expect(await aliasNames(items.thyro)).toEqual([ORDERED.thyro, extra].sort());

    await section.getByLabel("Add a name").fill(ORDERED.lipid);
    await section.getByLabel("Add a name").press("Enter");
    await expect(section.getByRole("alert")).toContainText(`already billed as ${codes.lipid}`);
    await expect(page.getByRole("dialog")).toBeVisible();

    await section.getByRole("button", { name: `Remove ${extra}`, exact: true }).click();
    await expect(names).not.toContainText(extra);
    expect(await aliasNames(items.thyro)).toEqual([ORDERED.thyro]);
  });

  test("9. the data script: dry run saves nothing, --apply links, refusals block", async () => {
    await order(visits.C18B.visit, [{ name: ORDERED.script, price: 450 }]);
    const pair = `${ORDERED.script}=${codes.lipid}`;
    const dry = linkScript(pair);
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toContain("localhost:5435/gini_scribe_test");
    expect(dry.out).toContain("now: no lab test — not priced");
    expect(dry.out).toContain(`${ORDERED.script} → ${codes.lipid}`);
    expect(dry.out).toContain(`lab test "P4 Lipid panel ${tag}" — ${codes.lipid} ₹450`);
    expect(dry.out).toContain("Dry run only");
    expect(await aliasNames(items.lipid)).toEqual([ORDERED.lipid]);

    const blocked = linkScript(pair, `${ORDERED.lipid}=${codes.uacr}`, "--apply");
    expect(blocked.status, blocked.out).toBe(2);
    expect(blocked.out).toContain("REFUSED");
    expect(blocked.out).toContain(`already billed as ${codes.lipid}`);
    expect(await aliasNames(items.lipid)).toEqual([ORDERED.lipid]);

    const applied = linkScript(pair, "--apply");
    expect(applied.status, applied.out).toBe(0);
    expect(applied.out).toContain("Saved.");
    expect(await aliasNames(items.lipid)).toEqual([ORDERED.lipid, ORDERED.script].sort());
    expect(await matched(ORDERED.script)).toBe(cat.lipid);
  });

  test("10. phone width: the Not priced list and the item dialog fit without side scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openOrderedNames(page, tag);
    const row = orderedTable(page).getByRole("row", { name: new RegExp(ORDERED.mystery) });
    await expect(row).toBeVisible();
    await row
      .getByRole("searchbox", { name: `Search services for ${ORDERED.mystery}` })
      .fill(codes.thyro);
    await expect(
      row.getByRole("button", { name: new RegExp(`^Link to ${codes.thyro}`) }),
    ).toBeVisible();
    await noSideScroll(page);

    await viewSwitch(page).getByRole("button", { name: "Items", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search items" }).fill(codes.thyro);
    await page.getByRole("button", { name: `Edit P4 Thyroid Service ${tag}`, exact: true }).click();
    const section = page.getByRole("dialog").getByRole("region", { name: "Also billed as" });
    await expect(section.getByRole("button", { name: "Add", exact: true })).toBeVisible();
    await noSideScroll(page);
    const box = await section.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});
