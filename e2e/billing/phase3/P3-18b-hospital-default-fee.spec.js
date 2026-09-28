import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginAs } from "../../helpers/auth.mjs";
import { one, query } from "../../helpers/db.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { consultantFeeGrid } = await import("../../../server/services/billing/consultantFees.js");

const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const NOFEE = `Dr Zeta P318B ${tag}`;
const CODES = { New: `P318B-DEF-NEW-${T}`, "Follow Up": `P318B-DEF-FU-${T}` };
const SUGGESTED = { New: "CONS-DEFAULT-NEW", "Follow Up": "CONS-DEFAULT-FU" };
const PRICES = { New: "600", "Follow Up": "300" };
const seed = {};

const notPriced = (page) => page.getByRole("table", { name: "Not priced" });
const createButton = (page, who, visit) =>
  notPriced(page).getByRole("button", { name: `Create item for ${who} (${visit})`, exact: true });
const rowOf = (page, who, visit) =>
  notPriced(page)
    .getByRole("row")
    .filter({
      has: page.getByRole("button", { name: `Create item for ${who} (${visit})`, exact: true }),
    });

const showView = (page, name) =>
  page
    .getByRole("group", { name: "Consultant fees view" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
const noGroups = (page) =>
  page.route(/\/api\/billing\/master\/groups(\?|$)/, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: [] }) : route.continue(),
  );

async function openFees(page) {
  await noGroups(page);
  await loginAs(page, "reception_admin");
  await gotoReady(page, "/settings/consultant-fees?view=not-priced", () =>
    page.getByLabel("Category", { exact: true }),
  );
  await expect(notPriced(page)).toBeVisible();
}

async function createDefault(page, visit) {
  await createButton(page, "Hospital default", visit).click();
  const box = page.getByRole("dialog", { name: `Hospital default ${visit} consultation item` });
  await expect(box).toBeVisible();
  await expect(box.getByLabel("Name", { exact: true })).toHaveValue(
    `Consultation — Hospital default (${visit})`,
  );
  await expect(box.getByLabel("Code", { exact: true })).toHaveValue(SUGGESTED[visit]);
  await expect(box.getByLabel("Subgroup", { exact: true })).toHaveCount(0);
  await box.getByLabel("Code", { exact: true }).fill(CODES[visit]);
  await box.getByLabel("Price (₹)", { exact: true }).fill(PRICES[visit]);
  await box.getByRole("button", { name: "Create item", exact: true }).click();
  await expect(box).toBeHidden();
}

test.describe.serial("P3-18b hospital default fee on the Consultant fees page", () => {
  test.beforeAll(async () => {
    const existing = await one(
      `SELECT count(*)::int AS n FROM service_items
        WHERE kind = 'consultation' AND doctor_id IS NULL AND is_active`,
    );
    expect(existing.n, "the test database already has a hospital default fee").toBe(0);
    seed.nofee = (
      await one(
        `INSERT INTO doctors (name, role, pin, is_active) VALUES ($1, 'consultant', 'x', TRUE) RETURNING id`,
        [NOFEE],
      )
    ).id;
  });

  test.afterAll(async () => {
    const codes = Object.values(CODES);
    await query(
      `DELETE FROM service_item_price_history WHERE service_item_id IN
         (SELECT id FROM service_items WHERE code = ANY ($1))`,
      [codes],
    );
    await query(`DELETE FROM service_items WHERE code = ANY ($1)`, [codes]);
    await query(`DELETE FROM doctors WHERE name = $1`, [NOFEE]);
  });

  test("1. with no default, Not priced lists the hospital default first and doctors are billed nothing", async ({
    page,
  }) => {
    await openFees(page);
    const body = notPriced(page).locator("tbody tr");
    await expect(body.nth(0)).toContainText("Hospital default");
    await expect(body.nth(0)).toContainText("New");
    await expect(body.nth(1)).toContainText("Hospital default");
    await expect(body.nth(1)).toContainText("Follow Up");
    for (const visit of ["New", "Follow Up"]) {
      await expect(rowOf(page, NOFEE, visit)).toContainText("Nothing — no fee");
    }
    await showView(page, "Fees");
    await expect(
      page.getByRole("table", { name: "Consultant fees" }).getByRole("rowheader", {
        name: /^Hospital default/,
      }),
    ).toHaveCount(0);
  });

  test("2. creating the New default with no groups present covers the doctors' New visits", async ({
    page,
  }) => {
    await openFees(page);
    await createDefault(page, "New");
    await expect(createButton(page, "Hospital default", "New")).toHaveCount(0);
    await expect(createButton(page, "Hospital default", "Follow Up")).toBeVisible();
    await expect(rowOf(page, NOFEE, "New")).toContainText("Hospital default fee");
    await expect(rowOf(page, NOFEE, "Follow Up")).toContainText("Nothing — no fee");
    await showView(page, "Fees");
    const grid = page.getByRole("table", { name: "Consultant fees" });
    const row = grid.getByRole("row").filter({ hasText: CODES.New });
    await expect(row.getByRole("rowheader")).toContainText("Hospital default");
    await expect(row).toContainText("New");
    await expect(row).toContainText("₹600");
  });

  test("3. creating the Follow Up default empties the hospital default rows", async ({ page }) => {
    await openFees(page);
    await createDefault(page, "Follow Up");
    await expect(
      notPriced(page).getByRole("button", { name: /^Create item for Hospital default/ }),
    ).toHaveCount(0);
    for (const visit of ["New", "Follow Up"]) {
      await expect(rowOf(page, NOFEE, visit)).toContainText("Hospital default fee");
    }
    await showView(page, "Fees");
    const grid = page.getByRole("table", { name: "Consultant fees" });
    await expect(grid.getByRole("rowheader", { name: /^Hospital default/ })).toHaveCount(2);
    const items = await query(
      `SELECT i.visit_type, i.name, i.base_price::text, i.doctor_id, s.is_active AS subgroup_active
         FROM service_items i JOIN service_subgroups s ON s.id = i.subgroup_id
        WHERE i.code = ANY ($1) ORDER BY i.visit_type DESC`,
      [Object.values(CODES)],
    );
    expect(items.rows).toEqual([
      {
        visit_type: "New",
        name: "Consultation — Hospital default (New)",
        base_price: "600.00",
        doctor_id: null,
        subgroup_active: true,
      },
      {
        visit_type: "Follow Up",
        name: "Consultation — Hospital default (Follow Up)",
        base_price: "300.00",
        doctor_id: null,
        subgroup_active: true,
      },
    ]);
  });

  test("4. filtered to one doctor, the grid still knows the default covers them", async () => {
    const grid = await consultantFeeGrid({ doctorId: seed.nofee });
    expect(grid.rows.filter((r) => r.is_default)).toEqual([]);
    expect(grid.not_priced.map((d) => [d.visit_type, d.default_covers])).toEqual([
      ["New", true],
      ["Follow Up", true],
    ]);
  });
});
