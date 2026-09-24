import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { desk, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const requests = await import("../../../server/services/billing/billingRequests.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.4.9", role: "admin" };
let ids;

const open = (page) =>
  gotoReady(page, `/giniflow/station/billing?visit=${ids.visit}`, () =>
    page.getByRole("region", { name: "Add items" }),
  );

const results = (page) =>
  page
    .getByRole("region", { name: "Add items" })
    .getByRole("list", { name: "Item search results" });

const mine = (page) => page.getByRole("region", { name: "My requests" });

const search = async (page, text) => {
  await page.getByLabel("Search items").fill(text);
};

const liveLines = async () =>
  (await query(`SELECT service_item_id FROM bill_lines WHERE bill_id = $1 AND is_live`, [ids.bill]))
    .rows;

test.describe.serial("P4-30 add items, repeat and new-item requests", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await bills.addLine(ids.bill, { item_id: ids.dressing }, desk, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the item search shows active items only", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    await search(page, tag);
    await expect(results(page).getByText(`Ankle brace ${tag}`)).toBeVisible();

    await query(`UPDATE service_items SET is_active = FALSE WHERE id = $1`, [ids.brace]);
    try {
      await open(page);
      await search(page, tag);
      await expect(results(page).getByText(`Consultation New ${tag}`)).toBeVisible();
      await expect(results(page).getByText(`Ankle brace ${tag}`)).toHaveCount(0);
    } finally {
      await query(`UPDATE service_items SET is_active = TRUE WHERE id = $1`, [ids.brace]);
    }
  });

  test("2. an item already on the visit is greyed, with the admin asked instead", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await open(page);
    await search(page, `Dressing ${tag}`);
    const row = results(page)
      .getByRole("listitem")
      .filter({ hasText: `Dressing ${tag}` });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Ask admin to bill again" })).toBeVisible();
  });

  test("3. a new-item request goes from the desk to the bill", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    const wanted = `P4 Wanted ${tag}`;
    await search(page, wanted);
    await page.getByRole("button", { name: "Request new item" }).click();
    await expect(page.getByLabel("Item name")).toHaveValue(wanted);
    await page.getByLabel("Group").fill("Procedures");
    await page.getByLabel("Why is it needed?").fill("The doctor did it today");
    await page.getByRole("button", { name: "Send request" }).click();

    await expect(mine(page).getByText(wanted)).toBeVisible();
    await expect(mine(page).getByText("Waiting for an admin")).toBeVisible();

    const pending = (await requests.listRequests({ kind: "new_item", status: "pending" }, db)).find(
      (entry) => entry.proposed_name === wanted,
    );
    expect(pending).toBeTruthy();
    await requests.approveRequest(
      pending.id,
      {
        note: "Created",
        item: {
          code: `P4-NEW-${tag}`,
          subgroup_id: ids.subgroup,
          base_price: 300,
          kind: "procedure",
        },
      },
      admin,
      db,
    );

    await open(page);
    const row = mine(page).getByRole("listitem").filter({ hasText: wanted });
    await expect(row.getByText("Approved")).toBeVisible();
    await row.getByRole("button", { name: "Add to bill" }).click();

    await expect(page.getByRole("table", { name: "Bill lines" }).getByText(wanted)).toBeVisible();
    const saved = await bills.readBill(ids.bill, db);
    expect(saved.lines.some((line) => line.bill_name === wanted)).toBe(true);
  });

  test("4. a repeat request lets the same item be billed a second time", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    const before = (await liveLines()).filter((row) => row.service_item_id === ids.dressing).length;
    expect(before).toBe(1);

    await search(page, `Dressing ${tag}`);
    await results(page)
      .getByRole("listitem")
      .filter({ hasText: `Dressing ${tag}` })
      .getByRole("button", { name: "Ask admin to bill again" })
      .click();
    await page.getByLabel("Why must it be billed again?").fill("A second dressing after lunch");
    await page.getByRole("button", { name: "Send request" }).click();
    await expect(mine(page).getByText("Waiting for an admin")).toBeVisible();

    const pending = (
      await requests.listRequests({ kind: "repeat_item", status: "pending" }, db)
    ).find((entry) => entry.visit_id === ids.visit);
    expect(pending).toBeTruthy();
    await requests.approveRequest(pending.id, { note: "Allowed once" }, admin, db);

    await open(page);
    const row = mine(page)
      .getByRole("listitem")
      .filter({ hasText: `Dressing ${tag}` })
      .filter({ hasText: "Approved" });
    await row.getByRole("button", { name: "Add to bill" }).click();

    await expect(
      page
        .getByRole("table", { name: "Bill lines" })
        .getByRole("row")
        .filter({ hasText: `Dressing ${tag}` }),
    ).toHaveCount(2);
    const after = (await liveLines()).filter((row) => row.service_item_id === ids.dressing).length;
    expect(after).toBe(2);
    expect((await requests.getRequest(pending.id, db)).status).toBe("used");
  });
  test("5. the desk's own item search is active-only and carries no price", async () => {
    const api = await apiAs("reception");
    const response = await api.get(`/api/billing/items/search?q=${tag}`);
    expect(response.status()).toBe(200);
    const items = (await response.json()).items;
    expect(items.some((item) => item.name === `Dressing ${tag}`)).toBe(true);
    const banned = ["base_price", "price", "rate", "mrp", "bill_name", "bill_code", "discount"];
    for (const item of items) {
      for (const field of banned) expect(item).not.toHaveProperty(field);
    }

    await query(`UPDATE service_items SET is_active = FALSE WHERE id = $1`, [ids.brace]);
    try {
      const again = await api.get(`/api/billing/items/search?q=${tag}`);
      expect((await again.json()).items.some((item) => item.id === ids.brace)).toBe(false);
    } finally {
      await query(`UPDATE service_items SET is_active = TRUE WHERE id = $1`, [ids.brace]);
      await api.dispose();
    }
  });

  test("6. the search and the desk settings are refused without the desk capability", async () => {
    const api = await apiAs("coordinator");
    expect((await api.get(`/api/billing/items/search?q=${tag}`)).status()).toBe(403);
    expect((await api.get(`/api/billing/desk-settings`)).status()).toBe(403);
    await api.dispose();
  });
});
