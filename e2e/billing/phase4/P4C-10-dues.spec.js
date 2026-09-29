import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, payRule, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const settings = await import("../../../server/services/billing/billingSettings.js");
const reports = await import("../../../server/services/billing/reports.js");
const dues = await import("../../../server/services/billing/dues.js");
const { fromPaise } = await import("../../../src/components/billing/format.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.10", role: USERS.admin.role };
const REGISTER = "/api/billing/dues-register";
let ids;
let payLaterWas = null;
const made = {};

const daysBefore = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function visitOn(patient, day) {
  const appointment = (
    await one(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type,
                                 doctor_id)
       SELECT id, name, file_no, $2::date, 'New Patient', $3 FROM patients WHERE id = $1
       RETURNING id`,
      [patient, day, CONSULTANTS.banshali.id],
    )
  ).id;
  return (
    await one(
      `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, assigned_doctor_id)
       VALUES ($1, $2::date, $3, $4) RETURNING id`,
      [patient, day, appointment, CONSULTANTS.banshali.id],
    )
  ).id;
}

async function dueBill(visit, items, category, { paid = 0, ageDays = 0 } = {}) {
  const draft = await bills.openDraft(visit, desk, db);
  for (const item of items) await bills.addLine(draft.id, { item_id: item }, desk, db);
  const ready = await bills.setCategory(draft.id, { category }, desk, db);
  let final = await bills.finaliseBill(
    draft.id,
    { version: ready.version, pay_later: true },
    desk,
    db,
  );
  if (paid) {
    await payments.takePayments(
      final.id,
      { version: final.version, mode: "upi", amount: paid, reference: `UPI-${tag}-${final.id}` },
      desk,
      db,
    );
  }
  if (ageDays) {
    await query(`UPDATE bills SET bill_date = $2::date WHERE id = $1`, [
      final.id,
      daysBefore(ids.day, ageDays),
    ]);
  }
  final = await one(`SELECT id, bill_no, visit_id FROM bills WHERE id = $1`, [final.id]);
  return final;
}

const EXPECTED = {
  A: { outstanding: 50000, days: 0 },
  B: { outstanding: 60000, days: 5 },
  C: { outstanding: 130000, days: 20 },
  D: { outstanding: 80000, days: 100 },
  E: { outstanding: 10000, days: 45 },
};

const labelOf = (billId) => Object.keys(made).find((key) => made[key].id === billId);

async function register(role, params = {}) {
  const api = await apiAs(role);
  const response = await api.get(REGISTER, { params: { q: tag, ...params } });
  const body = response.ok() ? await response.json() : null;
  const status = response.status();
  await api.dispose();
  return { status, body };
}

async function labels(params = {}) {
  const { status, body } = await register("admin", { page_size: 200, ...params });
  expect(status, JSON.stringify(params)).toBe(200);
  return body.rows.map((row) => labelOf(row.bill_id));
}

test.describe.serial("P4C-10 dues", () => {
  test.beforeAll(async () => {
    test.setTimeout(120000);
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner pays", patient_pays: "full" });
    await payRule(ids, ids.paid, {
      name: "cghs paid",
      patient_pays: "amount",
      patient_value: 100,
      remainder: "claim",
    });
    payLaterWas = (await settings.getSettings(db)).allow_pay_later;
    await settings.updateSettings({ allow_pay_later: true }, admin, db);

    const today = await extraVisit(ids, "DuesReturn");
    ids.returnPatient = today.patient;
    ids.returnVisit = today.visit;
    await query(`UPDATE patients SET phone = $2 WHERE id = $1`, [
      today.patient,
      `6${String(parseInt(tag, 16)).padStart(9, "3").slice(-9)}`,
    ]);
    ids.phone = (await one(`SELECT phone FROM patients WHERE id = $1`, [today.patient])).phone;
    const earlierVisit = await visitOn(today.patient, daysBefore(ids.day, 5));
    made.B = await dueBill(earlierVisit, [ids.brace], ids.pensioner, { paid: 200, ageDays: 5 });
    made.A = await dueBill(today.visit, [ids.dressing], ids.pensioner);
    made.C = await dueBill(
      (await extraVisit(ids, "DuesOld")).visit,
      [ids.brace, ids.dressing],
      ids.pensioner,
      { ageDays: 20 },
    );
    made.D = await dueBill(
      (await extraVisit(ids, "DuesAncient")).visit,
      [ids.brace],
      ids.pensioner,
      {
        ageDays: 100,
      },
    );
    made.E = await dueBill((await extraVisit(ids, "DuesClaim")).visit, [ids.dressing], ids.paid, {
      ageDays: 45,
    });
    await query(`UPDATE bills SET pay_later = FALSE WHERE id = $1`, [made.E.id]);
    made.F = await dueBill(
      (await extraVisit(ids, "DuesSettled")).visit,
      [ids.dressing],
      ids.pensioner,
      {
        paid: 500,
      },
    );
  });

  test.afterAll(async () => {
    await tearDown(ids);
    if (payLaterWas !== null) {
      await settings.updateSettings({ allow_pay_later: payLaterWas }, admin, db);
    }
  });

  test("1. the page lists every due of the search with the listDues amounts; a paid bill and CGHS claims never show", async () => {
    const { body } = await register("admin", { page_size: 200 });
    expect(body.rows.map((row) => labelOf(row.bill_id)).sort()).toEqual(["A", "B", "C", "D", "E"]);
    for (const row of body.rows) {
      const want = EXPECTED[labelOf(row.bill_id)];
      expect(row.outstanding, row.bill_no).toBe(want.outstanding);
      expect(row.days, row.bill_no).toBe(want.days);
    }
    const claim = body.rows.find((row) => row.bill_id === made.E.id);
    expect(claim.payable).toBe(10000);
    const legacy = (await payments.listDues({}, db)).filter((row) => labelOf(row.bill_id));
    expect(Object.fromEntries(legacy.map((row) => [row.bill_id, row.outstanding]))).toEqual(
      Object.fromEntries(body.rows.map((row) => [row.bill_id, row.outstanding])),
    );
    expect(body.totals).toMatchObject({ bills: 5, outstanding: 330000 });
  });

  test("2. search finds a due by name, file no, phone and bill no", async () => {
    expect(await labels({ q: `DuesAncient ${tag}` })).toEqual(["D"]);
    expect(await labels({ q: `F4DuesOld-${tag}` })).toEqual(["C"]);
    expect((await labels({ q: ids.phone })).sort()).toEqual(["A", "B"]);
    expect(await labels({ q: made.E.bill_no })).toEqual(["E"]);
  });

  test("3. each filter narrows the list", async () => {
    const sorted = async (params) => (await labels(params)).sort();
    expect(await sorted({ age: "0-7" })).toEqual(["A", "B"]);
    expect(await sorted({ age: "8-30" })).toEqual(["C"]);
    expect(await sorted({ age: "31-90" })).toEqual(["E"]);
    expect(await sorted({ age: "90+" })).toEqual(["D"]);
    expect(await sorted({ from: daysBefore(ids.day, 25), to: daysBefore(ids.day, 1) })).toEqual([
      "B",
      "C",
    ]);
    expect(await sorted({ category: ids.parent })).toEqual(["A", "B", "C", "D", "E"]);
    expect(await sorted({ category: "zz_nobody" })).toEqual([]);
    expect(await sorted({ sub_category: ids.pensioner })).toEqual(["A", "B", "C", "D"]);
    expect(await sorted({ sub_category: ids.paid })).toEqual(["E"]);
    expect(await sorted({ min: "600" })).toEqual(["B", "C", "D"]);
    expect(await sorted({ max: "600" })).toEqual(["A", "B", "E"]);
    expect(await sorted({ min: "600", max: "600.00" })).toEqual(["B"]);
    expect(await sorted({ pay_later: "yes" })).toEqual(["A", "B", "C", "D"]);
    expect(await sorted({ pay_later: "no" })).toEqual(["E"]);
    expect((await register("admin", { age: "old" })).status).toBe(400);
    expect((await register("admin", { min: "900", max: "100" })).status).toBe(400);
  });

  test("4. sorting: oldest first, and largest due first", async () => {
    expect(await labels({ sort: "oldest" })).toEqual(["D", "E", "C", "B", "A"]);
    expect(await labels()).toEqual(["D", "E", "C", "B", "A"]);
    expect(await labels({ sort: "largest" })).toEqual(["C", "D", "B", "A", "E"]);
  });

  test("5. paging splits the filtered set and every page carries the whole set's total", async () => {
    const seen = [];
    let sum = 0;
    for (const page of [1, 2, 3]) {
      const { body } = await register("admin", { page_size: 2, page });
      expect(body.pages).toBe(3);
      expect(body.totals).toMatchObject({ bills: 5, outstanding: 330000 });
      seen.push(...body.rows.map((row) => labelOf(row.bill_id)));
      sum += body.rows.reduce((total, row) => total + row.outstanding, 0);
    }
    expect(seen).toEqual(["D", "E", "C", "B", "A"]);
    expect(sum).toBe(330000);
    const { body: largest } = await register("admin", { page_size: 2, page: 2, sort: "largest" });
    expect(largest.rows.map((row) => labelOf(row.bill_id))).toEqual(["B", "A"]);
    const { body: beyond } = await register("admin", { page_size: 2, page: 9 });
    expect(beyond.rows).toEqual([]);
    expect(beyond.totals.outstanding).toBe(330000);
  });

  test("6. the Dues report agrees with the page for the same filters", async () => {
    for (const filters of [
      { category: ids.parent },
      { sub_category: ids.pensioner },
      { sub_category: ids.paid },
      { category: ids.parent, from: daysBefore(ids.day, 25), to: daysBefore(ids.day, 1) },
      { category: ids.parent, to: daysBefore(ids.day, 30) },
    ]) {
      const report = await reports.runReport("dues", filters, db);
      const [section] = report.sections;
      const page = await dues.listDuesRegister({ ...filters, page_size: 1 }, db);
      expect(page.totals.outstanding, JSON.stringify(filters)).toBe(section.total.outstanding);
      expect(page.totals.bills, JSON.stringify(filters)).toBe(section.bills);
      expect(page.totals.paid, JSON.stringify(filters)).toBe(section.total.paid);
    }
  });

  test("7. the export holds the whole filtered set and its total", async () => {
    const api = await apiAs("reception_admin");
    const response = await api.get(`${REGISTER}/export`, { params: { q: tag, page_size: 1 } });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("spreadsheetml");
    expect(response.headers()["x-dues-count"]).toBe("5");
    expect(response.headers()["x-dues-amount"]).toBe("330000");
    await api.dispose();
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await dues.exportDues({ q: tag }, db)).buffer);
    const sheet = workbook.getWorksheet("Dues");
    const billNos = [];
    sheet.eachRow((row, n) => {
      if (n > 1) billNos.push(row.getCell(1).value);
    });
    expect(billNos).toEqual(
      [made.D, made.E, made.C, made.B, made.A].map((b) => b.bill_no).concat("Total"),
    );
    expect(sheet.getRow(sheet.rowCount).getCell(13).value).toBe(3300);
  });

  test("8. the counter's today list holds only today's dues, with their total", async () => {
    const today = await dues.duesToday(db);
    const mine = today.rows
      .filter((row) => labelOf(row.bill_id))
      .map((row) => labelOf(row.bill_id));
    expect(mine).toEqual(["A"]);
    expect(today.rows.every((row) => row.bill_date === ids.day)).toBe(true);
    expect(today.totals.outstanding).toBe(today.rows.reduce((t, row) => t + row.outstanding, 0));
    expect(today.totals.bills).toBe(today.rows.length);
    const api = await apiAs("reception");
    const response = await api.get("/api/billing/dues/today");
    expect(response.status()).toBe(200);
    expect((await response.json()).totals).toEqual(today.totals);
    await api.dispose();
  });

  test("9. the counter's Dues tab shows today only, with the total line", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/billing", () =>
      page.getByRole("tab", { name: "Dues" }),
    );
    await page.getByRole("tab", { name: "Dues" }).click();
    const panel = page.getByRole("tabpanel");
    const today = await dues.duesToday(db);
    const count = today.totals.bills;
    await expect(panel.getByTestId("dues-today-total")).toHaveText(
      `${count === 1 ? "1 bill" : `${count} bills`} · ${fromPaise(today.totals.outstanding)} due today`,
    );
    await expect(
      panel.getByRole("button", { name: `Take payment on bill ${made.A.bill_no}` }),
    ).toBeVisible();
    await expect(panel.getByText(made.B.bill_no)).toHaveCount(0);
    await expect(panel.getByText(made.D.bill_no)).toHaveCount(0);
  });

  test("10. a returning patient shows earlier dues above the bill, with Take payment", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await gotoReady(
      page,
      `/giniflow/station/billing?visit=${ids.returnVisit}&bill=${made.A.id}`,
      () => page.getByRole("region", { name: "Earlier dues" }),
    );
    const strip = page.getByRole("region", { name: "Earlier dues" });
    await expect(strip.getByRole("listitem")).toHaveCount(1);
    await expect(strip.getByRole("listitem")).toContainText(
      `Earlier dues: ${fromPaise(60000)} on bill ${made.B.bill_no} (5 days ago)`,
    );
    await expect(strip).not.toContainText(made.A.bill_no);
    await strip
      .getByRole("button", { name: `Take payment on earlier bill ${made.B.bill_no}` })
      .click();
    await expect(page).toHaveURL(new RegExp(`bill=${made.B.id}`));
    await expect(page.getByRole("region", { name: "Earlier dues" })).toContainText(made.A.bill_no);
  });

  test("11. the Dues page: filters, total, paging and Take payment to the counter", async ({
    page,
  }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/billing/dues", () => page.getByRole("heading", { name: "Dues" }));
    await page.getByLabel("Search", { exact: true }).fill(tag);
    const total = page.getByTestId("dues-total");
    await expect(total).toHaveText(`5 bills · ${fromPaise(330000)} due`);
    await page.getByLabel("Age", { exact: true }).selectOption("0-7");
    await expect(total).toHaveText(`2 bills · ${fromPaise(110000)} due`);
    await page.getByLabel("Age", { exact: true }).selectOption("");
    await page.getByLabel("Pay later", { exact: true }).selectOption("no");
    await expect(total).toHaveText(`1 bill · ${fromPaise(10000)} due`);
    await page.getByLabel("Pay later", { exact: true }).selectOption("");
    await page.getByLabel("Sort", { exact: true }).selectOption("largest");
    const rows = page.getByRole("table", { name: "Dues" }).locator("tbody tr");
    await expect(rows.first()).toContainText(made.C.bill_no);
    await expect(total).toHaveText(`5 bills · ${fromPaise(330000)} due`);
    const link = page.getByRole("link", { name: `Take payment on bill ${made.D.bill_no}` });
    await expect(link).toHaveAttribute(
      "href",
      `/giniflow/station/reception?tab=bill&visit=${made.D.visit_id}&bill=${made.D.id}`,
    );
    await link.click();
    await expect(page).toHaveURL(
      new RegExp(
        `/giniflow/station/reception\\?tab=bill&visit=${made.D.visit_id}&bill=${made.D.id}$`,
      ),
    );
    await expect(page.getByText(made.D.bill_no).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: `P4 DuesAncient ${tag}` })).toBeVisible();
  });

  test("12. the Dues page paginates on the server", async ({ page }) => {
    await loginAs(page, "admin");
    await page.route("**/api/billing/dues-register?*", (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("page_size", "2");
      route.continue({ url: url.toString() });
    });
    await gotoReady(page, "/billing/dues", () => page.getByRole("heading", { name: "Dues" }));
    await page.getByLabel("Search", { exact: true }).fill(tag);
    const pager = page.getByRole("navigation", { name: "Dues pages" });
    await expect(pager).toContainText("Page 1 of 3 · bills 1–2 of 5");
    await pager.getByRole("button", { name: "Next" }).click();
    await expect(pager).toContainText("Page 2 of 3 · bills 3–4 of 5");
    await expect(page.getByTestId("dues-total")).toHaveText(`5 bills · ${fromPaise(330000)} due`);
    await expect(page.getByRole("table", { name: "Dues" }).locator("tbody tr")).toHaveCount(2);
  });

  test("13. permissions: reception is refused the page and its API; reception_admin and admin are allowed", async ({
    page,
  }) => {
    expect((await register("reception")).status).toBe(403);
    expect((await register("reception_admin")).status).toBe(200);
    expect((await register("admin")).status).toBe(200);
    const api = await apiAs("reception");
    expect((await api.get(`${REGISTER}/export`)).status()).toBe(403);
    await api.dispose();
    await loginAs(page, "reception");
    await gotoReady(page, "/", () => page.locator(".tabs"));
    await expect(page.locator(".tabs").getByRole("link", { name: /Dues/ })).toHaveCount(0);
    await gotoReady(page, "/billing/dues", () => page.locator(".tabs"));
    await expect(page).not.toHaveURL(/\/billing\/dues/);
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/", () => page.locator(".tabs"));
    await expect(page.locator(".tabs").getByRole("link", { name: "💰 Dues" })).toBeVisible();
  });
});
