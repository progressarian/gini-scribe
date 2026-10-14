import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { autoConsultation, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { openDeskDraft } = await import("../../../server/services/billing/deskOpen.js");

const db = getPool();
const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const desk = { actorId: null, ip: "10.9.49.1", role: "reception" };
const visits = {};
let ids;
let autoBefore;

async function order(visitId, testName, price) {
  const made = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 0, 'payment_pending', 'lab') RETURNING id`,
    [visitId, price],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price, status)
     VALUES ($1, $2, $3, 'ordered')`,
    [made.id, testName, price],
  );
}

const draftsOf = (visitId) =>
  query(
    `SELECT id, saved_at FROM bills WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice'`,
    [visitId],
  ).then((r) => r.rows);

const linesOf = (visitId) =>
  query(
    `SELECT l.id, l.source FROM bill_lines l WHERE l.visit_id = $1 AND l.is_live ORDER BY l.line_no`,
    [visitId],
  ).then((r) => r.rows);

const deletesOf = (billId) =>
  one(
    `SELECT COUNT(*)::int AS n FROM billing_audit
      WHERE action = 'delete' AND (entity_id = $1 OR before ->> 'bill_id' = $1)`,
    [billId],
  ).then((r) => r.n);

const actions = (page) => page.getByRole("region", { name: "Bill actions" });
const searchbox = (page) => page.getByRole("searchbox", { name: "Search today's patients" });

test.describe.serial("P4C-49 reopening a patient at the counter keeps their draft", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(true);
    for (const label of ["C49Api", "C49Leave", "C49Other", "C49Drop"]) {
      visits[label] = await extraVisit(ids, label, { visitType: "Follow Up" });
      await order(visits[label].visit, ids.hba1cName, 250);
    }
  });

  test.afterAll(async () => {
    try {
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
    } finally {
      await tearDown(ids);
    }
  });

  test("1. opening twice reuses the same unsaved draft and its lines, deleting nothing", async () => {
    const { visit } = visits.C49Api;
    const first = await openDeskDraft(visit, desk, db);
    const linesBefore = await linesOf(visit);
    expect(linesBefore.map((l) => l.source).sort()).toEqual(["lab_order", "visit"]);
    expect(first.saved).toBe(false);

    const second = await openDeskDraft(visit, desk, db);
    expect(second.id).toBe(first.id);
    expect(await linesOf(visit)).toEqual(linesBefore);
    expect(await draftsOf(visit)).toHaveLength(1);
    expect(await deletesOf(first.id)).toBe(0);
  });

  test("2. switching patients without editing leaves the unsaved draft in place, unsaved", async ({
    page,
  }) => {
    const { visit } = visits.C49Leave;
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visit}`, () => actions(page));
    await expect.poll(async () => (await draftsOf(visit)).length).toBe(1);
    const [draft] = await draftsOf(visit);

    await searchbox(page).fill(`C49Other ${tag}`);
    await page.getByRole("button", { name: `P4 C49Other ${tag}` }).click();
    await expect(page).toHaveURL(new RegExp(`visit=${visits.C49Other.visit}`));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(actions(page)).toBeVisible();

    const [kept] = await draftsOf(visit);
    expect(kept.id).toBe(draft.id);
    expect(kept.saved_at).toBeNull();
    expect(await deletesOf(draft.id)).toBe(0);
  });

  test("3. a dropped connection while opening is retried and the bill still opens", async ({
    page,
  }) => {
    const { visit } = visits.C49Drop;
    let dropped = 0;
    await page.route(`**/api/billing/visits/${visit}/bills`, (route) => {
      if (route.request().method() === "POST" && dropped === 0) {
        dropped += 1;
        return route.abort("internetdisconnected");
      }
      return route.continue();
    });
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visit}`, () => actions(page));
    expect(dropped).toBe(1);
    await expect.poll(async () => (await draftsOf(visit)).length).toBe(1);
    await expect(actions(page).getByRole("button", { name: "Delete draft" })).toBeVisible();
    await expect(page.getByText("This bill could not be opened")).toHaveCount(0);
  });
});
