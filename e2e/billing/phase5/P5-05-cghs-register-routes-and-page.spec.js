import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { CAPABILITIES, ROLES, hasCapability } from "../../../shared/permissions.js";
import { PAGE_CAPABILITIES } from "../../../src/config/routes.js";
import { CLAIM_BILLS_AT_ONCE } from "../../../shared/claimsRegister.js";
import { newTag, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  billClaim,
  mountClaims,
  pensionerBill,
  queryString,
  referralBill,
  setUpClaims,
} from "./p5-claims.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const PAGE = "/billing/cghs-register";
const tag = newTag();
let ids;
let api;

const ROUTE_FILE = fs.readFileSync(
  path.join(repoRoot, "server", "routes", "billingClaims.js"),
  "utf8",
);

const shownLeaves = (page) =>
  page.evaluate(() => {
    const leaves = [...document.querySelectorAll("body *")].filter(
      (el) =>
        !el.children.length &&
        el.textContent.trim() &&
        getComputedStyle(el).visibility === "visible",
    );
    const inPrint = leaves.filter((el) => el.closest(".cghs-print")).length;
    return { inPrint, outside: leaves.length - inPrint };
  });

const fakeRow = (i) => ({
  bill_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  bill_no: `P505/${String(i).padStart(6, "0")}`,
  bill_date: "2026-09-01",
  patient_id: 1,
  patient_name: `P505 ${i}`,
  uhid: `U${i}`,
  category: "P505",
  category_label: "CGHS › Pensioner",
  payer_name: "CGHS P505",
  doctor_id: 1,
  doctor_name: "Dr P505",
  bill_codes: [],
  referral_no: null,
  billed_claim: 70000,
  credited: 0,
  claim: 70000,
  days_pending: 3,
  claim_status: "pending",
  version: 1,
  settlement: null,
});

async function forwardClaims(page, as) {
  await page.route(/\/api\/billing\/claims\//, async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const cors = {
      "access-control-allow-origin": (await request.headerValue("origin")) ?? "*",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-expose-headers": "content-disposition",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const res = await fetch(`${api.url}${target.pathname}${target.search}`, {
      method: request.method(),
      headers: {
        "x-test-user": String(USERS[as].id),
        ...(request.postData() ? { "content-type": "application/json" } : {}),
      },
      body: request.postData() ?? undefined,
    });
    const headers = Object.fromEntries(res.headers.entries());
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    await route.fulfill({
      status: res.status,
      headers: { ...headers, ...cors },
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
}

test.describe.serial("P5-05 CGHS register routes and page", () => {
  test.beforeAll(async () => {
    test.setTimeout(120000);
    ids = await setUpClaims(tag);
    api = await mountClaims();
    ids.pens = (await pensionerBill(ids, "PageA")).bill;
    ids.refr = (await referralBill(ids, "PageB")).bill;
    ids.left = (await pensionerBill(ids, "PageC")).bill;
  });

  test.afterAll(async () => {
    await api?.close();
    await tearDown(ids);
  });

  test("1. every route is a ${BASE} route behind BILLING_CLAIMS, and undo is admin only", async () => {
    expect(ROUTE_FILE).toMatch(/^const BASE = "\/billing\/claims";$/m);
    const declared = [...ROUTE_FILE.matchAll(/router\.(get|post|patch|put|delete)\(/g)].length;
    const gated = [...ROUTE_FILE.matchAll(/router\.\w+\(\s*`\$\{BASE\}[^`]*`,\s*claims,/g)].length;
    expect(declared).toBe(7);
    expect(gated).toBe(declared);
    expect(ROUTE_FILE).toMatch(/`\$\{BASE\}\/settlements\/:id\/undo`,\s*claims,\s*adminOnly,/);
    const holders = Object.values(ROLES).filter((role) =>
      hasCapability(role, CAPABILITIES.BILLING_CLAIMS),
    );
    expect(holders.sort()).toEqual(["admin", "reception_admin"]);
    expect(PAGE_CAPABILITIES[PAGE]).toBe(CAPABILITIES.BILLING_CLAIMS);

    for (const [as, status] of [
      ["reception", 403],
      ["coordinator", 403],
      ["reception_admin", 200],
      ["admin", 200],
    ]) {
      for (const route of ["/pending", "/cleared", "/pending/export", "/cleared/export"]) {
        expect((await api.call("GET", route, { as })).status, `${as} ${route}`).toBe(status);
      }
    }
    const clear = await api.call("POST", "/clear", { as: "reception", body: {} });
    expect(clear.status).toBe(403);
    const bad = await api.call("GET", `/pending${queryString({ from: "nope" })}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/From must be a date like/);
    const unknown = await api.call("GET", `/pending${queryString({ token: "x" })}`);
    expect(unknown.status).toBe(400);
  });

  test("2. the live API already refuses the register to reception", async () => {
    const reception = await apiAs("reception");
    for (const route of ["/api/billing/claims/pending", "/api/billing/claims/cleared"]) {
      expect((await reception.get(route)).status(), route).toBe(403);
    }
    expect((await reception.post("/api/billing/claims/clear", { data: {} })).status()).toBe(403);
    await reception.dispose();
  });

  test("3. as reception_admin, two bills are selected and cleared with one reference", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await forwardClaims(page, "reception_admin");
    await gotoReady(page, PAGE, () => page.getByRole("heading", { name: "CGHS register" }));
    await expect(page.locator(".tabs").getByRole("link", { name: /CGHS register/ })).toBeVisible();
    await page.getByLabel("Payer").selectOption(`CGHS ${tag}`);
    await expect(page.locator(".cghs-totals")).toContainText("3 bills · ₹1,750 pending");

    await page.getByLabel(`Select bill ${ids.pens.bill_no}`).check();
    await page.getByLabel(`Select bill ${ids.refr.bill_no}`).check();
    await page.getByRole("button", { name: /Clear selected \(2 · ₹1,050\)/ }).click();
    const dialog = page.getByRole("dialog", { name: "Clear selected bills" });
    await expect(dialog).toContainText(`2 bills · ₹1,050 claimed from CGHS ${tag}`);
    const amount = dialog.getByLabel("Amount received (₹)");
    await expect(amount).toHaveValue("1050.00");
    await dialog.getByLabel("Reference (UTR)").fill(`UTR-${tag}-PAGE`);
    await amount.fill("1000");
    await expect(dialog).toContainText("Difference ₹50 less than claimed");
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await amount.fill("1050");
    await expect(dialog).toContainText("The amount matches the selected claims.");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".cghs-totals")).toContainText("1 bill · ₹700 pending");

    const first = await billClaim(ids.pens.id);
    expect(first.claim_status).toBe("cleared");
    expect((await billClaim(ids.refr.id)).claim_settlement_id).toBe(first.claim_settlement_id);

    await page.getByRole("tab", { name: "Cleared" }).click();
    await page.getByLabel("Reference").fill(`${tag}-page`);
    const table = page.getByRole("table", { name: "Cleared claims" });
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(table).toContainText(ids.pens.bill_no);
    await expect(table).toContainText(ids.refr.bill_no);
    await expect(table).toContainText(`UTR-${tag}-PAGE`);
    await expect(table).toContainText(USERS.reception_admin.name);
    await expect(table.getByRole("button", { name: /Undo/ })).toHaveCount(0);
  });

  test("4. as admin, one bill is marked cleared from its row and the payment can be undone", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await forwardClaims(page, "admin");
    await gotoReady(page, PAGE, () => page.getByRole("heading", { name: "CGHS register" }));
    await page.getByLabel("Payer").selectOption(`CGHS ${tag}`);
    await page.getByRole("button", { name: `Mark bill ${ids.left.bill_no} cleared` }).click();
    const dialog = page.getByRole("dialog", { name: `Mark bill ${ids.left.bill_no} cleared` });
    await expect(dialog.getByLabel("Amount received (₹)")).toHaveValue("700.00");
    await dialog.getByLabel("Reference (UTR)").fill(`UTR-${tag}-ROW`);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".bill-allclear")).toContainText("No claims are pending here.");

    await page.getByRole("tab", { name: "Cleared" }).click();
    await page.getByLabel("Reference").fill(`${tag}-row`);
    await page.getByRole("button", { name: new RegExp(`Undo payment UTR-${tag}-ROW`) }).click();
    const undo = page.getByRole("dialog", { name: `Undo payment UTR-${tag}-ROW?` });
    await expect(undo.getByRole("button", { name: "Undo payment" })).toBeDisabled();
    await undo.getByLabel("Reason").fill("Typed against the wrong bill");
    await undo.getByRole("button", { name: "Undo payment" }).click();
    await expect(undo).toHaveCount(0);
    expect((await billClaim(ids.left.id)).claim_status).toBe("pending");
    await page.getByRole("tab", { name: "Pending" }).click();
    await expect(page.locator(".cghs-totals")).toContainText("1 bill · ₹700 pending");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export Pending (.xlsx)" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^cghs-pending(-\d{4}-\d{2}-\d{2})?\.xlsx$/);
  });

  test("5. as reception the menu entry is absent and the page is refused", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, "/", () => page.locator(".tabs"));
    await expect(page.locator(".tabs").getByRole("link", { name: /CGHS register/ })).toHaveCount(0);
    await gotoReady(page, PAGE, () => page.locator(".tabs"));
    await expect(page).not.toHaveURL(new RegExp(PAGE));
    await expect(page.getByRole("heading", { name: "CGHS register" })).toHaveCount(0);
  });

  test("6. the Billing Counter shows 'Cleared on <date>' for a cleared bill", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, `/giniflow/station/billing?visit=${ids.pens.visit_id}`, () =>
      page.getByText(ids.pens.bill_no).first(),
    );
    await page.getByRole("button", { name: `Open bill ${ids.pens.bill_no}` }).click();
    await expect(page.getByText(`Cleared on ${ids.day}`)).toBeVisible();
  });

  test("7. the register's print rules hide nothing on other pages printed after it", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await forwardClaims(page, "admin");
    await gotoReady(page, PAGE, () => page.getByRole("heading", { name: "CGHS register" }));
    await page.emulateMedia({ media: "print" });
    const register = await shownLeaves(page);
    expect(register.outside).toBe(0);
    expect(register.inPrint).toBeGreaterThan(0);
    await page.emulateMedia({ media: "screen" });
    await page.locator(".tabs").getByRole("link", { name: /OPD/ }).first().click();
    await expect(page.getByRole("heading", { name: "CGHS register" })).toHaveCount(0);
    await page.emulateMedia({ media: "print" });
    await expect.poll(async () => (await shownLeaves(page)).outside).toBeGreaterThan(0);
  });

  test("8. more bills than one payment may clear: Save is held and the print is off", async ({
    page,
  }) => {
    const rows = Array.from({ length: CLAIM_BILLS_AT_ONCE + 1 }, (_, i) => fakeRow(i));
    await page.route(/\/api\/billing\/claims\/pending(\?|$)/, (route) =>
      route.fulfill({
        json: {
          tab: "pending",
          filters: {},
          rows,
          totals: { count: rows.length + 10, amount: (rows.length + 10) * 70000 },
          truncated: true,
          options: { categories: [], doctors: [], payers: [] },
        },
      }),
    );
    await loginAs(page, "reception_admin");
    await gotoReady(page, PAGE, () => page.getByRole("heading", { name: "CGHS register" }));
    await expect(page.getByRole("button", { name: /Print pending list/ })).toBeDisabled();
    await page.getByRole("button", { name: "Select all filtered" }).click();
    await page.getByRole("button", { name: /Clear selected \(501 · / }).click();
    const dialog = page.getByRole("dialog", { name: "Clear selected bills" });
    await dialog.getByLabel("Reference (UTR)").fill(`UTR-${tag}-MANY`);
    await expect(dialog.getByRole("alert")).toContainText(
      `One payment can clear at most ${CLAIM_BILLS_AT_ONCE} bills`,
    );
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("checkbox", { name: "Select bill P505/000000" }).uncheck();
    await page.getByRole("button", { name: /Clear selected \(500 · / }).click();
    const fewer = page.getByRole("dialog", { name: "Clear selected bills" });
    await fewer.getByLabel("Reference (UTR)").fill(`UTR-${tag}-MANY`);
    await expect(fewer.getByRole("alert")).toHaveCount(0);
    await expect(fewer.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
