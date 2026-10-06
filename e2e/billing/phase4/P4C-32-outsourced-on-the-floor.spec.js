import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { labOrder, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const items = await import("../../../server/services/billing/serviceItems.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.32", role: "admin" };
let ids;

const findOrder = (data, lists) =>
  lists.flatMap((list) => data[list] || []).find((order) => order.orderId === ids.order);

const testFlags = (order) =>
  Object.fromEntries(order.tests.map((test) => [test.name, test.outsourced]));

const receptionQueue = async () => {
  const api = await apiAs("reception");
  const response = await api.get(`/api/giniflow/stations/reception/queue?date=${ids.day}`);
  expect(response.status()).toBe(200);
  const data = await response.json();
  await api.dispose();
  return data;
};

const labQueue = async () => {
  const api = await apiAs("lab");
  const response = await api.get(`/api/giniflow/stations/lab/queue?date=${ids.day}`);
  expect(response.status()).toBe(200);
  const data = await response.json();
  await api.dispose();
  return data;
};

test.describe.serial("P4C-32 outsourced tests are labelled on the floor", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    await items.updateItem(ids.hba1c, { is_outsourced: true }, admin, db);
    ids.order = await labOrder(ids, [ids.hba1cName, ids.looseName]);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the reception queue marks each outsourced test, and nothing else changes", async () => {
    const data = await receptionQueue();
    const order = findOrder(data, ["pending", "awaitingSample", "cleared"]);
    expect(order, "the order is in reception's queue").toBeTruthy();
    expect(testFlags(order)).toEqual({ [ids.hba1cName]: true, [ids.looseName]: false });
    expect(order.paymentStatus).toBe("pending");
    expect(data.pending.some((row) => row.orderId === ids.order)).toBe(true);
  });

  test("2. the lab queue marks each outsourced test on the order and its unified row", async () => {
    const data = await labQueue();
    const buckets = Object.keys(data).filter(
      (key) => Array.isArray(data[key]) && data[key].some((row) => row?.orderId),
    );
    const order = findOrder(data, buckets);
    expect(order, "the order is in the lab's queue").toBeTruthy();
    expect(testFlags(order)).toEqual({ [ids.hba1cName]: true, [ids.looseName]: false });
    expect(order.paid).toBe(false);
    const unified = data.unified.find((row) => row.orderId === ids.order);
    expect(unified.outsourcedTests).toEqual([ids.hba1cName]);
  });

  test("3. the Payments tab shows the label on the outsourced test only", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception", () =>
      page.getByRole("tablist", { name: "Reception" }),
    );
    await page.getByRole("tab", { name: /^Payments/ }).click();
    const outsourcedTest = page.locator(".toc-test").filter({ hasText: ids.hba1cName });
    const inhouseTest = page.locator(".toc-test").filter({ hasText: ids.looseName });
    await expect(outsourcedTest.first().getByText("Outsourced", { exact: true })).toBeVisible();
    await expect(inhouseTest.first()).toBeVisible();
    await expect(inhouseTest.first().getByText("Outsourced", { exact: true })).toHaveCount(0);
  });

  test("4. the lab station shows the label on the outsourced test only", async ({ page }) => {
    await loginAs(page, "lab");
    await page.goto("/giniflow/station/lab");
    const tests = page.locator(".pc-tests").filter({ hasText: ids.hba1cName }).first();
    await expect(tests).toBeVisible();
    await expect(tests.getByText("Outsourced", { exact: true })).toHaveCount(1);
    await expect(tests).toContainText(ids.looseName);
  });

  test("5. un-flagging the service removes the label from both queues", async () => {
    await items.updateItem(ids.hba1c, { is_outsourced: false }, admin, db);
    try {
      const reception = findOrder(await receptionQueue(), ["pending", "awaitingSample", "cleared"]);
      expect(testFlags(reception)).toEqual({ [ids.hba1cName]: false, [ids.looseName]: false });
      const lab = await labQueue();
      expect(lab.unified.find((row) => row.orderId === ids.order).outsourcedTests).toEqual([]);
    } finally {
      await query(`UPDATE service_items SET is_outsourced = TRUE WHERE id = $1`, [ids.hba1c]);
    }
  });
});
