import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");

const db = getPool();
const tag = newTag();
const LIST = "/api/billing/counter/patients";
const RECEPTION = "/giniflow/station/reception";
const nameOf = (label) => `P4 ${label} ${tag}`;
const visits = {};
let ids;
let billNo = 0;

const PLAN = {
  Seen: { status: "rx_pending", at: "08:00", events: ["doctor_done", "rx_pending"] },
  Tests: { status: "with_vitals", at: "08:10" },
  DraftDue: { status: "vitals_pending", at: "08:20" },
  Nothing: { status: "checked_in", at: "08:30" },
  WalkedOut: {
    status: "exited",
    at: "08:40",
    events: [["exited", { source: "counter_end_visit" }]],
  },
  SeenOnline: {
    status: "exited",
    at: "08:50",
    visitType: "Tele Consultation",
    events: [["exited", { source: "healthray" }]],
  },
  Booked: { status: "booked" },
  NoShowDue: { status: "no_show" },
  NoShowNothing: { status: "no_show" },
  Blocked: { status: "rx_pending", at: "08:05", events: ["doctor_done"], blocked: true },
};

async function place(label, plan) {
  const made = await extraVisit(ids, label, { visitType: plan.visitType || "New Patient" });
  await query(`UPDATE giniflow_visits SET current_status = $2 WHERE id = $1`, [
    made.visit,
    plan.status,
  ]);
  if (plan.at) {
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
       VALUES ($1, 'checked_in', 'reception', ($2 || ' ' || $3 || ':00+05:30')::timestamptz)`,
      [made.visit, ids.day, plan.at],
    );
  }
  for (const event of plan.events || []) {
    const [status, meta] = Array.isArray(event) ? event : [event, {}];
    await query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, meta)
       VALUES ($1, $2, 'doctor', $3)`,
      [made.visit, status, meta],
    );
  }
  if (plan.blocked) {
    await query(`UPDATE patients SET is_blocked = TRUE WHERE id = $1`, [made.patient]);
  }
  visits[label] = made;
}

async function finalDue(label, payable) {
  const { visit, patient } = visits[label];
  billNo += 1;
  await query(
    `INSERT INTO bills (patient_id, visit_id, status, bill_no, series, fy, finalised_at,
                        actual_amount, patient_payable, paid_amount)
     VALUES ($1, $2, 'final', $3, 'MAIN', $4, NOW(), $5, $5, 0)`,
    [patient, visit, `${ids.prefix}C14${billNo}`, ids.fy, payable],
  );
}

async function testOrder(label, tests) {
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 'payment_pending', 'lab') RETURNING id`,
    [visits[label].visit, tests.reduce((sum, t) => sum + t.price, 0)],
  );
  for (const t of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [order.id, t.name, t.price],
    );
  }
  return order.id;
}

async function list(q = tag) {
  const api = await apiAs("reception");
  const response = await api.get(LIST, { params: { q } });
  expect(response.status()).toBe(200);
  const body = await response.json();
  await api.dispose();
  return body;
}

const names = (rows) => rows.map((row) => row.name);
const everyone = (body) => [...body.toBill, ...body.billed, ...body.waiting];
const rowOf = (body, label) => everyone(body).find((row) => row.name === nameOf(label));

const patientList = (page) => page.getByRole("complementary", { name: "Today's patients" });
const rowButton = (page, label) => patientList(page).getByRole("button", { name: nameOf(label) });
const waitingToggle = (page) =>
  patientList(page).getByRole("button", { name: /^Nothing to bill yet/ });
const searchbox = (page) => page.getByRole("searchbox", { name: "Search today's patients" });
const billTab = (page) => gotoReady(page, `${RECEPTION}?tab=bill`, () => searchbox(page));

test.describe.serial("P4C-14 the Bill tab lists who needs a bill first", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    for (const [label, plan] of Object.entries(PLAN)) await place(label, plan);
    await testOrder("Tests", [
      { name: ids.hba1cName, price: 250 },
      { name: ids.looseName, price: 300 },
    ]);
    const draft = await bills.openDraft(visits.DraftDue.visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    await finalDue("NoShowDue", 300);
    await finalDue("Blocked", 300);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a consultation done with no consultation line is to bill, with the hint", async () => {
    const body = await list();
    expect(names(body.toBill)).toContain(nameOf("Seen"));
    expect(rowOf(body, "Seen").group).toBe("toBill");
    expect(rowOf(body, "Seen").hints).toEqual({
      consultation: true,
      tests: 0,
      notPriced: 0,
      due: 0,
    });
    expect(rowOf(body, "SeenOnline").hints.consultation).toBe(true);
    expect(rowOf(body, "SeenOnline").group).toBe("billed");
  });

  test("2. leaving through the counter is not a consultation, and lists as exited", async () => {
    const body = await list();
    expect(rowOf(body, "WalkedOut").hints.consultation).toBe(false);
    expect(rowOf(body, "WalkedOut").group).toBe("billed");
  });

  test("3. tests ordered and unpaid are to bill, counting the ones with no item", async () => {
    const body = await list();
    expect(rowOf(body, "Tests").group).toBe("toBill");
    expect(rowOf(body, "Tests").hints).toMatchObject({ tests: 2, notPriced: 1 });
  });

  test("4. a draft with a balance is to bill with its amount", async () => {
    const body = await list();
    expect(rowOf(body, "DraftDue").group).toBe("toBill");
    expect(rowOf(body, "DraftDue").hints).toMatchObject({ due: 50000, consultation: false });
  });

  test("5. checked in with nothing, and not arrived, are in nothing to bill yet", async () => {
    const body = await list();
    expect(names(body.waiting)).toEqual(
      expect.arrayContaining(["Nothing", "Booked", "Patient"].map(nameOf)),
    );
    const waiting = names(body.waiting);
    expect(waiting.indexOf(nameOf("Nothing"))).toBeLessThan(waiting.indexOf(nameOf("Booked")));
  });

  test("6. a no-show with money due is to bill; one with nothing is hidden", async () => {
    const body = await list();
    expect(rowOf(body, "NoShowDue").group).toBe("toBill");
    expect(rowOf(body, "NoShowDue").hints.due).toBe(30000);
    expect(rowOf(body, "NoShowNothing")).toBeUndefined();
  });

  test("7. a blocked patient never shows, even seen and owing", async () => {
    for (const q of [tag, ""]) {
      const body = await list(q);
      expect(names(everyone(body))).not.toContain(nameOf("Blocked"));
    }
  });

  test("8. to bill runs by arrival; the old lists are still served", async () => {
    const body = await list();
    const toBill = names(body.toBill);
    expect(toBill.slice(0, 3)).toEqual(["Seen", "Tests", "DraftDue"].map(nameOf));
    expect(toBill[3]).toBe(nameOf("NoShowDue"));
    expect(body.onFloor.map((row) => row.name)).toContain(nameOf("Seen"));
    expect(Array.isArray(body.left) && Array.isArray(body.notArrived)).toBe(true);
  });

  test("9. the rows show their hints, and the nothing-to-bill section starts collapsed", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await billTab(page);
    await expect(rowButton(page, "Seen")).toContainText("Consultation done — not billed");
    await expect(rowButton(page, "Tests")).toContainText("2 tests ordered");
    await expect(rowButton(page, "Tests")).toContainText("1 not priced");
    await expect(rowButton(page, "DraftDue")).toContainText("₹500 due");
    await expect(rowButton(page, "NoShowDue")).toContainText("₹300 due");
    await expect(waitingToggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(rowButton(page, "Nothing")).toBeHidden();
    await waitingToggle(page).click();
    await expect(rowButton(page, "Nothing")).toBeVisible();
    await expect(rowButton(page, "Booked")).toBeVisible();
  });

  test("9b. To bill and Billed today / Exited start open and collapse on click", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await billTab(page);
    const toBillToggle = patientList(page).getByRole("button", { name: /^To bill/ });
    const billedToggle = patientList(page).getByRole("button", {
      name: /^Billed today \/ Exited/,
    });
    await expect(toBillToggle).toHaveAttribute("aria-expanded", "true");
    await expect(billedToggle).toHaveAttribute("aria-expanded", "true");
    await expect(rowButton(page, "Seen")).toBeVisible();
    await expect(rowButton(page, "WalkedOut")).toBeVisible();
    await toBillToggle.click();
    await expect(toBillToggle).toHaveAttribute("aria-expanded", "false");
    await expect(rowButton(page, "Seen")).toBeHidden();
    await billedToggle.click();
    await expect(rowButton(page, "WalkedOut")).toBeHidden();
    await searchbox(page).fill(`F4Seen-${tag}`);
    await expect(toBillToggle).toHaveAttribute("aria-expanded", "true");
    await expect(rowButton(page, "Seen")).toBeVisible();
  });

  test("10. a search opens the collapsed section on a match inside it", async ({ page }) => {
    await loginAs(page, "reception");
    await billTab(page);
    await expect(waitingToggle(page)).toHaveAttribute("aria-expanded", "false");
    await searchbox(page).fill(`F4Nothing-${tag}`);
    await expect(rowButton(page, "Nothing")).toBeVisible();
    await expect(waitingToggle(page)).toHaveAttribute("aria-expanded", "true");
    await searchbox(page).fill(`F4Seen-${tag}`);
    await expect(rowButton(page, "Seen")).toBeVisible();
    await expect(waitingToggle(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("10b. Close clears the chosen patient and keeps the list", async ({ page }) => {
    await loginAs(page, "reception");
    await billTab(page);
    await rowButton(page, "DraftDue").click();
    const close = page.getByRole("button", { name: `Close ${nameOf("DraftDue")}` });
    await expect(close).toBeVisible();
    await expect(page).toHaveURL(/visit=/);
    await close.click();
    await expect(page.getByText("No patient chosen")).toBeVisible();
    await expect(page).not.toHaveURL(/visit=/);
    await expect(page).toHaveURL(/tab=bill/);
    await expect(rowButton(page, "DraftDue")).not.toHaveAttribute("aria-current", "true");
  });

  test("11. the Arrivals badge still reads the bill state", async ({ page }) => {
    await page.route("**/api/giniflow/stations/reception/arrivals**", async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      const body = await list();
      const mine = body.onFloor.find((row) => row.name === nameOf("DraftDue"));
      await route.fulfill({
        response,
        json: {
          ...json,
          onFloor: [{ ...mine, alreadyOnFloorAs: null }],
          expected: [],
          notComing: [],
        },
      });
    });
    await loginAs(page, "reception");
    await gotoReady(page, RECEPTION, () => page.getByRole("tab", { name: /^Arrivals/ }));
    const row = page.locator(".ar-row").filter({ hasText: nameOf("DraftDue") });
    await expect(row).toBeVisible();
    await expect(row.locator(".bc-badge")).toHaveText("Draft");
  });

  test("12. adding the consultation and paying moves the patient to billed today", async () => {
    const draft = await bills.openDraft(visits.Seen.visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.consultNew }, desk, db);
    let body = await list();
    expect(rowOf(body, "Seen").group).toBe("toBill");
    expect(rowOf(body, "Seen").hints).toMatchObject({ consultation: true, due: 150000 });
    const ready = await bills.setCategory(draft.id, { category: ids.paid }, desk, db);
    const paid = await payments.takePayments(
      draft.id,
      { version: ready.version, mode: "card", amount: 1500, reference: `C14-${tag}` },
      desk,
      db,
    );
    body = await list();
    expect(rowOf(body, "Seen").group).toBe("toBill");
    await bills.finaliseBill(draft.id, { version: paid.version }, desk, db);
    body = await list();
    expect(rowOf(body, "Seen").group).toBe("billed");
    expect(rowOf(body, "Seen").hints).toEqual({
      consultation: false,
      tests: 0,
      notPriced: 0,
      due: 0,
    });
    expect(names(body.billed)).toContain(nameOf("Seen"));
  });
});
