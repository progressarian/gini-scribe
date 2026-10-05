import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";
import { openAddItems } from "../../helpers/addItems.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const testMatch = await import("../../../server/services/billing/testMatch.js");
const testCancel = await import("../../../server/services/giniflow/testCancel.js");
const serviceItems = await import("../../../server/services/billing/serviceItems.js");

const db = getPool();
const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const BULK = 22;
const visits = {};
const cat = {};
const items = {};
let ids;
let autoBefore;
let reportId;

const ORDERED = {
  hba1c: `P4 HBA1C ${tag}`,
  cbc: `P4 Complete Blood Count ${tag} (P4 CBC ${tag})`,
  renal: `P4 Renal Panel ${tag}`,
  ambiguous: `P4 Panel Zeta ${tag} (P4 Zeta ${tag})`,
  unknown: `P4 Mystery ${tag}`,
};

async function catalogue(key, name, price) {
  cat[key] = (
    await one(
      `INSERT INTO giniflow_test_catalog (test_name, price, category) VALUES ($1, $2, 'lab')
       RETURNING id`,
      [name, price],
    )
  ).id;
}

async function item(key, code, name, price, extra = {}) {
  items[key] = (
    await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        `P4-${code}-${tag}`,
        name,
        ids.subgroup,
        price,
        extra.kind ?? "test",
        extra.testCatalogId ?? null,
      ],
    )
  ).id;
}

async function order(visitId, tests, money = {}) {
  const total = tests.reduce((sum, t) => sum + t.price, 0);
  const made = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind)
     VALUES ($1, 'today', $2, $3, $4, $5, 'lab') RETURNING id`,
    [
      visitId,
      money.status ?? "pending",
      total,
      money.paid ?? 0,
      money.status === "paid" ? "paid" : "payment_pending",
    ],
  );
  for (const t of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [made.id, t.name, t.price],
    );
  }
  return made.id;
}

const liveLines = (visitId) =>
  query(
    `SELECT l.service_item_id, l.bill_name, l.source, l.lab_order_id, i.kind
       FROM bill_lines l JOIN service_items i ON i.id = l.service_item_id
      WHERE l.visit_id = $1 AND l.is_live
      ORDER BY l.line_no`,
    [visitId],
  ).then((r) => r.rows);

async function openAtDesk(visitId) {
  const api = await apiAs("reception");
  const response = await api.post(`/api/billing/visits/${visitId}/bills`, { data: {} });
  const body = await response.json();
  await api.dispose();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

async function notPriced(visitId) {
  const api = await apiAs("reception");
  const response = await api.get(`/api/billing/visits/${visitId}/not-priced`);
  const body = await response.json();
  await api.dispose();
  expect(response.status()).toBe(200);
  return body;
}

const itemIds = (lines) => lines.map((line) => line.service_item_id).sort((a, b) => a - b);
const sorted = (...values) => [...values].sort((a, b) => a - b);

const addItems = (page) => page.getByRole("region", { name: "Add items" });
const results = (page) => addItems(page).getByRole("list", { name: "Item search results" });
const searchInput = (page) => addItems(page).getByRole("searchbox", { name: "Search items" });
const HINT = "Type at least 2 letters of a service name or code";

test.describe.serial("P4C-15 priced tests are prefilled; Add items searches only", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    await catalogue("cbc", `P4 CBC ${tag}`, 350);
    await catalogue("rft", `P4 RFT ${tag}`, 450);
    await catalogue("zeta", `P4 Zeta ${tag}`, 100);
    await catalogue("zetaPanel", `P4 Zeta Panel ${tag}`, 120);
    await item("cbc", "CBC", `CBC ${tag}`, 350, { testCatalogId: cat.cbc });
    await item("rft", "RFT", `RFT ${tag}`, 450, { testCatalogId: cat.rft });
    await item("zeta", "ZT", `Zeta ${tag}`, 100, { testCatalogId: cat.zeta });
    await item("zetaPanel", "ZP", `Zeta Panel ${tag}`, 120, { testCatalogId: cat.zetaPanel });
    for (let n = 1; n <= BULK; n += 1) {
      const nn = String(n).padStart(2, "0");
      await item(`bulk${nn}`, `BK${nn}`, `Bulk${tag} ${nn}`, 10, { kind: "procedure" });
    }
    reportId = (
      await one(`INSERT INTO lab_report_catalog (name, aliases) VALUES ($1, $2) RETURNING id`, [
        `P4 Renal Report ${tag}`,
        [`P4 Renal Panel ${tag}`, `P4 RFT ${tag}`],
      ])
    ).id;
    for (const label of ["C15Prefill", "C15Paid", "C15Cancel"]) {
      visits[label] = await extraVisit(ids, label);
      await query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role) VALUES ($1, $2, 'doctor')`,
        [visits[label].visit, "doctor_done"],
      );
    }
    visits.C15Prefill.order = await order(visits.C15Prefill.visit, [
      { name: ORDERED.hba1c, price: 250 },
      { name: ORDERED.cbc, price: 350 },
      { name: ORDERED.renal, price: 450 },
      { name: ORDERED.ambiguous, price: 110 },
      { name: ORDERED.unknown, price: 90 },
    ]);
    visits.C15Paid.paidOrder = await order(
      visits.C15Paid.visit,
      [{ name: ORDERED.hba1c, price: 250 }],
      { status: "paid", paid: 250 },
    );
    visits.C15Paid.openOrder = await order(visits.C15Paid.visit, [
      { name: ORDERED.cbc, price: 350 },
    ]);
    visits.C15Cancel.order = await order(visits.C15Cancel.visit, [
      { name: ORDERED.hba1c, price: 250 },
      { name: ORDERED.cbc, price: 350 },
    ]);
  });

  test.afterAll(async () => {
    try {
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
      const visitIds = Object.values(visits).map((v) => v.visit);
      await query(`DELETE FROM giniflow_test_cancellations WHERE visit_id = ANY($1::uuid[])`, [
        visitIds,
      ]).catch(() => {});
      await tearDown(ids);
    } finally {
      if (reportId) await query(`DELETE FROM lab_report_catalog WHERE id = $1`, [reportId]);
    }
  });

  test("1. real ordered names find their catalogue tests by normalised name", async () => {
    const found = await testMatch.catalogTestsFor(db, ["HBA1C", "Complete Blood Count (CBC)"]);
    const real = await query(
      `SELECT test_name, id FROM giniflow_test_catalog WHERE test_name IN ('HbA1c', 'CBC')`,
    );
    const idOf = Object.fromEntries(real.rows.map((row) => [row.test_name, row.id]));
    test.skip(!idOf.HbA1c || !idOf.CBC, "the test catalogue has no HbA1c or CBC row");
    expect(found.get("HBA1C")).toBe(idOf.HbA1c);
    expect(found.get("Complete Blood Count (CBC)")).toBe(idOf.CBC);
  });

  test("2. the matcher: case, brackets and report aliases match; ambiguous and unknown don't", async () => {
    const found = await testMatch.catalogTestsFor(db, Object.values(ORDERED));
    expect(found.get(ORDERED.hba1c)).toBe(ids.hba1cTest);
    expect(found.get(ORDERED.cbc)).toBe(cat.cbc);
    expect(found.get(ORDERED.renal)).toBe(cat.rft);
    expect(found.get(ORDERED.ambiguous)).toBeNull();
    expect(found.get(ORDERED.unknown)).toBeNull();
  });

  test("3. opening the bill prefills every ordered test that has a price", async () => {
    const opened = await openAtDesk(visits.C15Prefill.visit);
    expect(opened.status).toBe("draft");
    const lines = await liveLines(visits.C15Prefill.visit);
    expect(itemIds(lines)).toEqual(sorted(ids.hba1c, items.cbc, items.rft));
    for (const line of lines) {
      expect(line.source).toBe("lab_order");
      expect(line.lab_order_id).toBe(visits.C15Prefill.order);
    }
    expect(itemIds(opened.lines)).toEqual(sorted(ids.hba1c, items.cbc, items.rft));
  });

  test("4. an ambiguous or unknown name stays unpriced, and reception collects only those", async () => {
    expect((await notPriced(visits.C15Prefill.visit)).sort()).toEqual(
      [ORDERED.ambiguous, ORDERED.unknown].sort(),
    );
    const draft = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      visits.C15Prefill.visit,
    ]);
    const { uncovered } = await one(`SELECT ${payments.UNCOVERED_SQL("$1", "$2")} AS uncovered`, [
      draft.id,
      visits.C15Prefill.order,
    ]);
    expect(Number(uncovered)).toBe(200);
    const api = await apiAs("reception");
    const response = await api.get("/api/billing/counter/patients", { params: { q: tag } });
    const body = await response.json();
    await api.dispose();
    const row = [...body.toBill, ...body.billed, ...body.waiting].find(
      (r) => r.name === `P4 C15Prefill ${tag}`,
    );
    expect(row.hints).toMatchObject({ notPriced: 2 });
  });

  test("5. reopening adds nothing twice, and the consultation is still not added", async () => {
    await openAtDesk(visits.C15Prefill.visit);
    await openAtDesk(visits.C15Prefill.visit);
    const lines = await liveLines(visits.C15Prefill.visit);
    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => line.kind === "consultation")).toEqual([]);
  });

  test("6. a test the desk removed is not put back on the next open", async () => {
    const draft = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      visits.C15Prefill.visit,
    ]);
    const line = await one(
      `SELECT id FROM bill_lines WHERE bill_id = $1 AND service_item_id = $2 AND is_live`,
      [draft.id, items.rft],
    );
    await bills.removeLine(draft.id, line.id, { reason: "Patient declined" }, desk, db);
    await openAtDesk(visits.C15Prefill.visit);
    expect(itemIds(await liveLines(visits.C15Prefill.visit))).toEqual(sorted(ids.hba1c, items.cbc));
  });

  test("7. a test already paid on the Payments tab is not prefilled", async () => {
    await openAtDesk(visits.C15Paid.visit);
    const lines = await liveLines(visits.C15Paid.visit);
    expect(itemIds(lines)).toEqual([items.cbc]);
    expect(lines[0].lab_order_id).toBe(visits.C15Paid.openOrder);
  });

  test("8. a test cancelled on the floor is not prefilled", async () => {
    const cbcTest = await one(
      `SELECT id FROM giniflow_lab_order_tests WHERE lab_order_id = $1 AND test_name = $2`,
      [visits.C15Cancel.order, ORDERED.cbc],
    );
    await testCancel.cancelTest(
      {
        target: { orderId: visits.C15Cancel.order, testId: cbcTest.id },
        reason: "patient_declined",
        source: "station",
        actorId: USERS.reception.id,
        actorRole: "reception",
      },
      db,
    );
    await openAtDesk(visits.C15Cancel.visit);
    expect(itemIds(await liveLines(visits.C15Cancel.visit))).toEqual([ids.hba1c]);
  });

  test("9. the counter shows the prefilled tests and only the unpriced ones below", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visits.C15Prefill.visit}`, () =>
      addItems(page),
    );
    const lines = page.getByRole("region", { name: "Bill lines" });
    await expect(lines).toContainText(`HbA1c ${tag}`);
    await expect(lines).toContainText(`CBC ${tag}`);
    const unpriced = page.getByRole("region", { name: "Ordered tests with no price" });
    await expect(unpriced).toContainText(ORDERED.unknown);
    await expect(unpriced).toContainText(ORDERED.ambiguous);
    await expect(unpriced).not.toContainText(ORDERED.hba1c);
  });

  test("10. Add items stays closed and silent until opened, then searches from two letters", async ({
    page,
  }) => {
    const searches = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/billing/items/search")) searches.push(request.url());
    });
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${ids.visit}`, () => addItems(page));
    await expect(searchInput(page)).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(searches).toEqual([]);
    await openAddItems(page);
    await expect(addItems(page)).not.toContainText(HINT);
    await searchInput(page).fill("B");
    await page.waitForTimeout(600);
    await expect(addItems(page)).toContainText(HINT);
    await expect(results(page)).toHaveCount(0);
    expect(searches.map((url) => new URL(url).searchParams.get("q"))).not.toContain("B");

    await openAddItems(page);
    await searchInput(page).fill(`Bulk${tag}`);
    await expect(results(page).getByRole("listitem")).toHaveCount(20);
    await expect(addItems(page)).toContainText("Showing first 20 — keep typing to narrow");
    await expect(addItems(page)).not.toContainText(HINT);
    const asked = new URL(searches.at(-1));
    expect(asked.searchParams.get("q")).toBe(`Bulk${tag}`);
    expect(asked.searchParams.get("limit")).toBe("20");
    const box = await results(page).evaluate((el) => {
      const style = getComputedStyle(el);
      return { maxHeight: style.maxHeight, overflowY: style.overflowY };
    });
    expect(box).toEqual({ maxHeight: "320px", overflowY: "auto" });

    await openAddItems(page);
    await searchInput(page).fill(`Bulk${tag} 07`);
    await expect(results(page).getByRole("listitem")).toHaveCount(1);
    await expect(addItems(page)).not.toContainText("Showing first 20");

    await openAddItems(page);
    await searchInput(page).fill(`Nothing-${tag}`);
    await expect(addItems(page).getByRole("button", { name: "Request new item" })).toBeVisible();
    await expect(results(page).getByText(`Nothing-${tag}`)).toHaveCount(0);

    await openAddItems(page);
    await searchInput(page).fill("");
    await expect(addItems(page)).not.toContainText(HINT);
    await expect(searchInput(page)).toBeVisible();
  });

  test("11. the search endpoint caps its answer and says there is more", async () => {
    const api = await apiAs("reception");
    const response = await api.get("/api/billing/items/search", {
      params: { q: `Bulk${tag}`, limit: 20 },
    });
    const body = await response.json();
    await api.dispose();
    expect(response.status()).toBe(200);
    expect(body.items).toHaveLength(20);
    expect(body.more).toBe(true);
  });

  test("11. a comma searches several items at once, in the order they were typed", async ({
    page,
  }) => {
    const found = await serviceItems.searchDeskItems({ q: `rft ${tag}, cbc ${tag}` }, db);
    expect(found.items.map((item) => item.name)).toEqual([`RFT ${tag}`, `CBC ${tag}`]);

    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${ids.visit}`, () => addItems(page));
    await openAddItems(page);
    await searchInput(page).fill(`cbc ${tag}, rft ${tag}`);
    const names = results(page).locator(".bc-result__name");
    await expect(names).toHaveText([`CBC ${tag}`, `RFT ${tag}`]);
  });

  test("12. Add Service/Test opens Add items and puts the cursor in the search", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${ids.visit}`, () => addItems(page));
    await expect(searchInput(page)).toHaveCount(0);
    await page
      .getByRole("region", { name: "Bill lines" })
      .getByRole("button", { name: "Add Service/Test" })
      .click();
    await expect(searchInput(page)).toBeFocused();
    await addItems(page).getByRole("button", { name: "Add items" }).click();
    await expect(searchInput(page)).toHaveCount(0);
  });

  test("13. a search with no match offers the most used items underneath", async ({ page }) => {
    const { visit } = await extraVisit(ids, "C15Used", { visitType: "Follow Up" });
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: items.rft }, desk, db);
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${ids.visit}`, () => addItems(page));
    await openAddItems(page);
    await searchInput(page).fill(`Nowhere-${tag}`);
    await expect(addItems(page).getByRole("button", { name: "Request new item" })).toBeVisible();
    await expect(addItems(page)).toContainText("Most used in the last 90 days");
    await expect(results(page).getByText(`RFT ${tag}`)).toBeVisible();
  });

  test("14. an item with no price takes this patient's price right in the search row", async ({
    page,
  }) => {
    await item("unpriced", "UNPRICED", `Unpriced scan ${tag}`, 0, { kind: "procedure" });
    const { visit } = await extraVisit(ids, "C15Price", { visitType: "Follow Up" });
    const draft = await bills.openDraft(visit, desk, db);
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visit}`, () => addItems(page));
    await openAddItems(page);
    await searchInput(page).fill(`Unpriced scan ${tag}`);
    const row = results(page)
      .getByRole("listitem")
      .filter({ hasText: `Unpriced scan ${tag}` });
    await expect(row).not.toContainText("No price");
    await row.getByLabel(`Unpriced scan ${tag}: price for this patient`).fill("75");
    await row.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("table", { name: "Bill lines" })).toContainText(
      `Unpriced scan ${tag}`,
    );
    const after = await bills.readBill(draft.id, db);
    const line = after.lines.find((entry) => entry.service_item_id === items.unpriced);
    expect(line).toMatchObject({ patient_payable: 7500, agreed_rate: 7500 });
  });
});
