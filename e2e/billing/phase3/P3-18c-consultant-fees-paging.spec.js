import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginAs, tokensFor } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const items = await import("../../../server/services/billing/serviceItems.js");
const groups = await import("../../../server/services/billing/serviceGroups.js");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const PREFIX = `Dr P318C ${tag}`;
const ctx = { actorId: USERS.reception_admin.id, ip: "10.3.18.3" };
const PRICED = Array.from(
  { length: 12 },
  (_, i) => `${PREFIX} Pg${String(i + 1).padStart(2, "0")}`,
);
const HALF = `${PREFIX} NpA`;
const BARE = [`${PREFIX} NpB`, `${PREFIX} NpC`];
const VISITS = ["New", "Follow Up"];
const URL = "/api/billing/master/consultant-fees";
const seed = { doctors: {} };

const codeOf = (index, visit) => `P318C-${T}-${index}-${visit === "New" ? "NEW" : "FU"}`;

async function get(page, path, params) {
  const { access } = await tokensFor("reception_admin");
  const response = await page.request.get(path, {
    params,
    headers: { Authorization: `Bearer ${access}` },
  });
  return { status: response.status(), json: await response.json() };
}

const doctorsOf = (rows) => [...new Set(rows.filter((r) => !r.is_default).map((r) => r.doctor_id))];
const fees = (page) => page.locator(".cf-fees");
const showView = (page, name) =>
  page
    .getByRole("group", { name: "Consultant fees view" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
const feeGrid = (page) => page.getByRole("table", { name: "Consultant fees" });
const notPriced = (page) => page.getByRole("table", { name: "Not priced" });

async function openFees(page) {
  await loginAs(page, "reception_admin");
  await gotoReady(page, "/settings/consultant-fees", () => feeGrid(page));
}

test.describe.serial("P3-18c consultant fees search and server-side paging", () => {
  test.beforeAll(async () => {
    const group = await groups.createGroup(
      { code: `P318CG-${T}`, name: `P318C Group ${tag}` },
      ctx,
    );
    const subgroup = await groups.createSubgroup(
      { group_id: group.id, code: `P318CS-${T}`, name: `P318C Sub ${tag}` },
      ctx,
    );
    const addDoctor = async (name) =>
      (
        await one(
          `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
          [name],
        )
      ).id;
    const addItem = (doctorId, index, visit) =>
      items.createItem(
        {
          code: codeOf(index, visit),
          name: `P318C consult ${index} ${visit} ${tag}`,
          subgroup_id: subgroup.id,
          base_price: 500,
          kind: "consultation",
          doctor_id: doctorId,
          visit_type: visit,
        },
        ctx,
      );
    for (const [index, name] of PRICED.entries()) {
      seed.doctors[name] = await addDoctor(name);
      for (const visit of VISITS) await addItem(seed.doctors[name], index + 1, visit);
    }
    seed.doctors[HALF] = await addDoctor(HALF);
    await addItem(seed.doctors[HALF], 0, "New");
    for (const name of BARE) seed.doctors[name] = await addDoctor(name);
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code LIKE $1)`,
      [`P318C-${T}-%`],
    );
    await query(`DELETE FROM service_items WHERE code LIKE $1`, [`P318C-${T}-%`]);
    await query(`DELETE FROM service_subgroups WHERE code = $1`, [`P318CS-${T}`]);
    await query(`DELETE FROM service_groups WHERE code = $1`, [`P318CG-${T}`]);
    await query(`DELETE FROM doctors WHERE name LIKE $1`, [`${PREFIX} %`]);
  });

  test("1. the grid pages on the server: page_size=2 returns 2 doctors and the whole total", async ({
    page,
  }) => {
    const { status, json } = await get(page, URL, { q: `P318C ${tag}`, page_size: "2" });
    expect(status).toBe(200);
    expect(json).toMatchObject({ total: 13, page: 1, page_size: 2 });
    expect(doctorsOf(json.rows)).toHaveLength(2);
    expect(json.rows.map((r) => [r.doctor_name, r.visit_type])).toEqual([
      [HALF, "New"],
      [PRICED[0], "New"],
      [PRICED[0], "Follow Up"],
    ]);
    expect(json.not_priced).toBeUndefined();
  });

  test("2. a doctor's New and Follow Up rows never split across pages", async ({ page }) => {
    const seen = new Map();
    for (const number of [1, 2, 3]) {
      const { json } = await get(page, URL, {
        q: `P318C ${tag}`,
        page: String(number),
        page_size: "5",
      });
      expect(json.total).toBe(13);
      expect(doctorsOf(json.rows)).toHaveLength(number < 3 ? 5 : 3);
      for (const row of json.rows) {
        expect(seen.get(row.doctor_id) ?? number).toBe(number);
        seen.set(row.doctor_id, number);
      }
      for (const id of doctorsOf(json.rows)) {
        const expected = id === seed.doctors[HALF] ? 1 : 2;
        expect(json.rows.filter((r) => r.doctor_id === id)).toHaveLength(expected);
      }
    }
    expect(seen.size).toBe(13);
    const past = await get(page, URL, { q: `P318C ${tag}`, page: "4", page_size: "5" });
    expect(past.json).toMatchObject({ total: 13, rows: [] });
  });

  test("3. search matches doctor name, short name or item code", async ({ page }) => {
    const byCode = await get(page, URL, { q: codeOf(3, "Follow Up"), page_size: "25" });
    expect(byCode.json.total).toBe(1);
    expect(byCode.json.rows.map((r) => r.item.code).sort()).toEqual(
      [codeOf(3, "Follow Up"), codeOf(3, "New")].sort(),
    );
    const byName = await get(page, URL, { q: `${tag} pg1`, page_size: "25" });
    expect(byName.json.total).toBe(3);
    const nothing = await get(page, URL, { q: `P318C ${tag} none`, page_size: "25" });
    expect(nothing.json).toMatchObject({ total: 0, rows: [] });
  });

  test("4. page_size is limited to 100 and page must be 1 or more", async ({ page }) => {
    expect((await get(page, URL, { page_size: "100" })).status).toBe(200);
    const big = await get(page, URL, { page_size: "101" });
    expect(big.status).toBe(400);
    expect(big.json.error).toBe("Page size can be at most 100");
    expect((await get(page, `${URL}/not-priced`, { page_size: "101" })).status).toBe(400);
    expect((await get(page, URL, { page: "0" })).status).toBe(400);
  });

  test("5. Not priced pages on the server by doctor, and its count stays the whole set", async ({
    page,
  }) => {
    const whole = await get(page, `${URL}/not-priced`, {});
    const first = await get(page, `${URL}/not-priced`, { q: `P318C ${tag}`, page_size: "2" });
    expect(first.json).toMatchObject({
      total: 5,
      total_doctors: 3,
      count: whole.json.count,
      missing_defaults: [],
      page: 1,
      page_size: 2,
    });
    expect(first.json.rows.map((r) => [r.doctor_name, r.visit_type])).toEqual([
      [HALF, "Follow Up"],
      [BARE[0], "New"],
      [BARE[0], "Follow Up"],
    ]);
    const second = await get(page, `${URL}/not-priced`, {
      q: `P318C ${tag}`,
      page: "2",
      page_size: "2",
    });
    expect(second.json.rows.map((r) => [r.doctor_name, r.visit_type])).toEqual([
      [BARE[1], "New"],
      [BARE[1], "Follow Up"],
    ]);
  });

  test("6. the Fees search pages the grid, and changing the search goes back to page 1", async ({
    page,
  }) => {
    await openFees(page);
    await fees(page)
      .getByRole("searchbox", { name: "Search doctor or item code" })
      .fill(`P318C ${tag}`);
    await expect(fees(page).locator(".pgn__range")).toHaveText("Showing 1–13 of 13 doctors");
    await fees(page).getByRole("button", { name: "Rows per page" }).click();
    await page.getByRole("option", { name: "10", exact: true }).click();
    await expect(fees(page).locator(".pgn__range")).toHaveText("Showing 1–10 of 13 doctors");
    await fees(page).getByRole("button", { name: "Next ›" }).click();
    await expect(fees(page).locator(".pgn__page")).toHaveText("Page 2 of 2");
    await expect(feeGrid(page).getByRole("rowheader")).toHaveCount(6);
    await expect(feeGrid(page)).toContainText(PRICED[11]);
    await fees(page)
      .getByRole("searchbox", { name: "Search doctor or item code" })
      .fill(`P318C ${tag} Pg`);
    await expect(fees(page).locator(".pgn__page")).toHaveText("Page 1 of 2");
    await expect(fees(page).locator(".pgn__range")).toHaveText("Showing 1–10 of 12 doctors");
    await expect(feeGrid(page)).toContainText(PRICED[0]);
    await expect(feeGrid(page)).not.toContainText(HALF);
  });

  test("7. the Doctor filter combines with the search", async ({ page }) => {
    await openFees(page);
    await page.getByLabel("Doctor", { exact: true }).selectOption(String(seed.doctors[PRICED[2]]));
    const search = fees(page).getByRole("searchbox", { name: "Search doctor or item code" });
    await search.fill(codeOf(3, "New"));
    await expect(feeGrid(page).getByRole("rowheader")).toHaveCount(2);
    await search.fill(codeOf(4, "New"));
    await expect(fees(page)).toContainText("No doctor or item code matches that search.");
  });

  test("8. the Not priced search narrows the list on the server; the count stays whole", async ({
    page,
  }) => {
    await openFees(page);
    await showView(page, "Not priced");
    const card = page.locator(".cf-notpriced");
    const count = card.locator(".fset__count");
    const before = await count.textContent();
    await card
      .getByRole("searchbox", { name: "Search doctors without a fee" })
      .fill(`P318C ${tag}`);
    await expect(notPriced(page).getByRole("button", { name: /^Create item for / })).toHaveCount(5);
    await expect(card.locator(".pgn__range")).toHaveText("Showing 1–3 of 3 doctors");
    await expect(count).toHaveText(before);
    await expect(
      notPriced(page).getByRole("button", { name: /^Create item for Hospital default/ }),
    ).toHaveCount(0);
    await card.getByRole("searchbox", { name: "Search doctors without a fee" }).fill("zzz-none");
    await expect(card).toContainText("No doctor without a fee matches that search.");
  });
});
