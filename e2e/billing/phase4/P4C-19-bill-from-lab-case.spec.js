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
  payRule,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const aliases = await import("../../../server/services/billing/serviceItemAliases.js");

const db = getPool();
const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const admin = { actorId: USERS.admin.id, ip: "10.9.19.1", role: "admin" };
const visits = {};
const cat = {};
const items = {};
let ids;
let autoBefore;
let labBefore;
let caseSeq = 0;

const NAMES = {
  tsh: `P4 TSH ${tag}`,
  tshBracketed: `P4 Thyroid Stimulating Hormone (P4 TSH ${tag})`,
  t3Alias: `P4 Thyro Three ${tag}`,
  vit: `P4 Vit Dee ${tag}`,
  mystery: `P4 Mystery Lab ${tag}`,
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

async function testItem(key, code, name, price) {
  items[key] = (
    await one(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
       VALUES ($1, $2, $3, $4, 'test', $5) RETURNING id`,
      [`P4-${code}-${tag}`, name, ids.subgroup, price, cat[key]],
    )
  ).id;
}

async function labCase(
  visit,
  tests,
  { byAppointment = true, byPatient = true, uhid = null, status = "Registered" } = {},
) {
  caseSeq += 1;
  const caseNo = `P4C19-${tag}-${caseSeq}`;
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            appointment_id, test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, $2, $3, $4, $5, $6::date, $7, $8::jsonb)`,
    [
      caseNo,
      990000 + caseSeq,
      byPatient ? visit.patient : null,
      byAppointment ? visit.appointment : null,
      tests,
      ids.day,
      status,
      JSON.stringify({ case_status: status, patient: { healthray_uid: uhid } }),
    ],
  );
  return caseNo;
}

async function order(visitId, tests, money = {}) {
  const made = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind)
     VALUES ($1, 'today', $2, $3, $4, $5, 'lab') RETURNING id`,
    [
      visitId,
      money.status ?? "pending",
      tests.reduce((sum, t) => sum + t.price, 0),
      money.paid ?? 0,
      money.status === "paid" ? "paid" : "payment_pending",
    ],
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

async function autoLabCase(on) {
  const { auto_add_lab_case_tests: before } = await one(
    `SELECT auto_add_lab_case_tests FROM billing_settings`,
  );
  await query(`UPDATE billing_settings SET auto_add_lab_case_tests = $1`, [on]);
  return before;
}

const liveLines = (visitId) =>
  query(
    `SELECT l.service_item_id, l.source, l.lab_order_id, b.status
       FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 AND l.is_live
      ORDER BY l.line_no`,
    [visitId],
  ).then((r) => r.rows);

const itemIds = (lines) => lines.map((line) => line.service_item_id).sort((a, b) => a - b);
const sorted = (...values) => [...values].sort((a, b) => a - b);

async function call(method, url, options) {
  const api = await apiAs("reception");
  const response = await api[method](url, options);
  const body = await response.json();
  await api.dispose();
  return { status: response.status(), body };
}

async function openDraft(visitId) {
  const { status, body } = await call("post", `/api/billing/visits/${visitId}/bills`, {
    data: {},
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return body;
}

async function offered(billId) {
  const { status, body } = await call("get", "/api/billing/lab-case-tests", {
    params: { bill_id: billId },
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return body;
}

async function counterRow(label) {
  const { status, body } = await call("get", "/api/billing/counter/patients", {
    params: { q: tag },
  });
  expect(status).toBe(200);
  for (const group of ["toBill", "billed", "waiting"]) {
    const row = body[group].find((r) => r.name === `P4 ${label} ${tag}`);
    if (row) return { ...row, group };
  }
  return null;
}

const card = (page) => page.getByRole("region", { name: "From today's lab report" });
const billLines = (page) => page.getByRole("table", { name: "Bill lines" });
const addItems = (page) => page.getByRole("region", { name: "Add items" });

async function openCounter(page, visitId, billId) {
  const bill = billId ? `&bill=${billId}` : "";
  await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visitId}${bill}`, () =>
    page.getByRole("region", { name: "Bill actions" }),
  );
}

test.describe.serial("P4C-19 bill tests from today's HealthRay lab case", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    labBefore = await autoLabCase(true);
    await catalogue("tsh", NAMES.tsh, 400);
    await catalogue("t3", `P4 Tri Iodo ${tag}`, 350);
    await catalogue("vit", NAMES.vit, 300);
    await testItem("tsh", "TSH", `TSH ${tag}`, 400);
    await testItem("t3", "T3", `T3 ${tag}`, 350);
    await testItem("vit", "VIT", `Vit D ${tag}`, 300);
    await aliases.addAlias(items.t3, { name: NAMES.t3Alias }, admin, db);
    await payRule(ids, ids.pensioner, { name: "pensioner pays nothing", patient_pays: "nothing" });
    for (const label of [
      "C19Auto",
      "C19Order",
      "C19Adopt",
      "C19Paid",
      "C19Removed",
      "C19Late",
      "C19Off",
      "C19Cancel",
      "C19Uhid",
      "C19Final",
    ]) {
      visits[label] = await extraVisit(ids, label, { visitType: "Follow Up" });
    }
    await labCase(visits.C19Auto, [NAMES.tshBracketed, NAMES.t3Alias, NAMES.mystery]);
    await labCase(visits.C19Auto, [NAMES.tsh], { byAppointment: false });
    visits.C19Order.order = await order(visits.C19Order.visit, [
      { name: ids.hba1cName, price: 250 },
    ]);
    await labCase(visits.C19Order, [ids.hba1cName.toUpperCase()]);
    await labCase(visits.C19Adopt, [NAMES.tsh]);
    await order(visits.C19Paid.visit, [{ name: ids.hba1cName, price: 250 }], {
      status: "paid",
      paid: 250,
    });
    await order(visits.C19Paid.visit, [{ name: NAMES.tsh, price: 400, status: "cancelled" }]);
    await labCase(visits.C19Paid, [ids.hba1cName, NAMES.tsh]);
    await labCase(visits.C19Removed, [NAMES.tsh]);
    await labCase(visits.C19Off, [NAMES.tsh, NAMES.t3Alias, NAMES.mystery]);
    await labCase(visits.C19Cancel, [NAMES.tsh], { status: "Cancelled" });
    await labCase(visits.C19Uhid, [NAMES.tsh], {
      byAppointment: false,
      byPatient: false,
      uhid: `F4C19Uhid-${tag}`,
    });
    await labCase(visits.C19Final, [NAMES.tsh]);
  });

  test.afterAll(async () => {
    try {
      if (labBefore !== undefined) await autoLabCase(labBefore);
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
      await query(`DELETE FROM lab_cases WHERE case_no LIKE $1`, [`P4C19-${tag}-%`]);
    } finally {
      await tearDown(ids);
    }
  });

  test("1. opening the bill adds the lab case's priced tests, by bracket code and by alias", async () => {
    const draft = await openDraft(visits.C19Auto.visit);
    const lines = await liveLines(visits.C19Auto.visit);
    expect(itemIds(lines)).toEqual(sorted(items.tsh, items.t3));
    for (const line of lines) {
      expect(line.source).toBe("lab_case");
      expect(line.lab_order_id).toBeNull();
    }
    expect(itemIds(draft.lines)).toEqual(sorted(items.tsh, items.t3));
    const card = await offered(draft.id);
    expect(card.tests).toEqual([]);
    expect(card.not_priced).toEqual([NAMES.mystery]);
  });

  test("2. reopening adds nothing twice, and a Scribe order of the same test keeps its own line", async () => {
    await openDraft(visits.C19Auto.visit);
    await openDraft(visits.C19Auto.visit);
    expect(await liveLines(visits.C19Auto.visit)).toHaveLength(2);

    const draft = await openDraft(visits.C19Order.visit);
    await openDraft(visits.C19Order.visit);
    const lines = await liveLines(visits.C19Order.visit);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      service_item_id: ids.hba1c,
      source: "lab_order",
      lab_order_id: visits.C19Order.order,
    });
    expect((await offered(draft.id)).shown).toBe(false);
  });

  test("3. a Scribe order raised after the lab-case line takes that line over, so reception collects nothing", async () => {
    const draft = await openDraft(visits.C19Adopt.visit);
    expect((await liveLines(visits.C19Adopt.visit))[0].source).toBe("lab_case");
    const orderId = await order(visits.C19Adopt.visit, [{ name: NAMES.tsh, price: 400 }]);
    await visitLines.linesForOrder(
      visits.C19Adopt.visit,
      { labOrderId: orderId, testNames: [NAMES.tsh] },
      desk,
      db,
    );
    const lines = await liveLines(visits.C19Adopt.visit);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      service_item_id: items.tsh,
      source: "lab_order",
      lab_order_id: orderId,
    });
    const { uncovered } = await one(`SELECT ${payments.UNCOVERED_SQL("$1", "$2")} AS uncovered`, [
      draft.id,
      orderId,
    ]);
    expect(Number(uncovered)).toBe(0);
  });

  test("4. tests settled at reception or cancelled on the Scribe order are not added or offered", async () => {
    const draft = await openDraft(visits.C19Paid.visit);
    expect(await liveLines(visits.C19Paid.visit)).toEqual([]);
    expect((await offered(draft.id)).shown).toBe(false);
  });

  test("5. a cancelled lab case adds and offers nothing", async () => {
    const draft = await openDraft(visits.C19Cancel.visit);
    expect(await liveLines(visits.C19Cancel.visit)).toEqual([]);
    expect((await offered(draft.id)).shown).toBe(false);
  });

  test("6. a case not yet linked to the patient is found by the UHID on the visit's day", async () => {
    await openDraft(visits.C19Uhid.visit);
    expect(itemIds(await liveLines(visits.C19Uhid.visit))).toEqual([items.tsh]);
  });

  test("7. a test the desk removed is not put back, but the card offers it", async ({ page }) => {
    const draft = await openDraft(visits.C19Removed.visit);
    const line = draft.lines.find((entry) => entry.service_item_id === items.tsh);
    await bills.removeLine(draft.id, line.id, {}, desk, db);
    await openDraft(visits.C19Removed.visit);
    expect(await liveLines(visits.C19Removed.visit)).toEqual([]);
    const body = await offered(draft.id);
    expect(body.tests).toMatchObject([
      { test_name: NAMES.tsh, item_id: items.tsh, item_name: `TSH ${tag}`, removed: true },
    ]);

    await loginAs(page, "reception");
    await openCounter(page, visits.C19Removed.visit);
    await expect(card(page)).toContainText(NAMES.tsh);
    await expect(card(page)).toContainText(`TSH ${tag}`);
    await card(page)
      .getByRole("button", { name: `Add TSH ${tag}`, exact: true })
      .click();
    await expect(billLines(page)).toContainText(`TSH ${tag}`);
    await expect(billLines(page).getByText("from lab report")).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    expect(await liveLines(visits.C19Removed.visit)).toMatchObject([
      { service_item_id: items.tsh, source: "lab_case" },
    ]);
  });

  test("8. a case that arrives after the bill opened is offered with its price, and Add all adds it", async ({
    page,
  }) => {
    const draft = await openDraft(visits.C19Late.visit);
    expect(await liveLines(visits.C19Late.visit)).toEqual([]);
    expect((await offered(draft.id)).shown).toBe(false);
    await labCase(visits.C19Late, [NAMES.tsh, NAMES.vit]);
    const body = await offered(draft.id);
    expect(body.shown).toBe(true);
    const byItem = Object.fromEntries(body.tests.map((t) => [t.item_id, t]));
    expect(byItem[items.tsh]).toMatchObject({ test_name: NAMES.tsh, price: 40000 });
    expect(byItem[items.vit]).toMatchObject({ test_name: NAMES.vit, price: 30000 });

    await loginAs(page, "reception");
    await gotoReady(
      page,
      `${RECEPTION}?tab=bill&visit=${visits.C19Late.visit}&bill=${draft.id}`,
      () => card(page),
    );
    await card(page).getByRole("button", { name: "Add all (2)" }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(billLines(page)).toContainText(`Vit D ${tag}`);
    await expect(billLines(page).getByText("from lab report")).toHaveCount(2);
    expect(itemIds(await liveLines(visits.C19Late.visit))).toEqual(sorted(items.tsh, items.vit));
  });

  test("9. with the setting off nothing is automatic, everything is offered, and Add adds one", async () => {
    let draft;
    try {
      await autoLabCase(false);
      draft = await openDraft(visits.C19Off.visit);
      expect(await liveLines(visits.C19Off.visit)).toEqual([]);
      const body = await offered(draft.id);
      expect(body.tests.map((t) => t.item_id).sort((a, b) => a - b)).toEqual(
        sorted(items.tsh, items.t3),
      );
      expect(body.not_priced).toEqual([NAMES.mystery]);
      const refused = await call("post", `/api/billing/bills/${draft.id}/lab-case-lines`, {
        data: { item_ids: [ids.dressing] },
      });
      expect(refused.status).toBe(409);
      const deskAdd = await call("post", `/api/billing/bills/${draft.id}/lines`, {
        data: { item_id: items.t3, source: "lab_case" },
      });
      expect(deskAdd.status).toBe(400);
      const added = await call("post", `/api/billing/bills/${draft.id}/lab-case-lines`, {
        data: { item_ids: [items.t3] },
      });
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      expect(added.body.lines.map((l) => [l.service_item_id, l.source])).toEqual([
        [items.t3, "lab_case"],
      ]);
      await openDraft(visits.C19Off.visit);
      expect(itemIds(await liveLines(visits.C19Off.visit))).toEqual([items.t3]);
    } finally {
      await autoLabCase(true);
    }
  });

  test("10. an unpriced lab name is listed as no price, on the card and in Settings → Services", async ({
    page,
  }) => {
    const names = (await aliases.orderedNamesNotPriced(db)).map((row) => row.test_name);
    expect(names).toContain(NAMES.mystery);
    expect(names).not.toContain(NAMES.tsh);
    await loginAs(page, "reception");
    await openCounter(page, visits.C19Auto.visit);
    await expect(card(page)).toContainText(NAMES.mystery);
    await expect(card(page)).toContainText("no price — link it in Settings → Services");
    await expect(card(page).getByRole("button")).toHaveCount(0);
    await expect(billLines(page).getByText("from lab report")).toHaveCount(2);
  });

  test("11. the Bill tab counts unbilled lab-case tests, then files the patient as billed after the final bill", async ({
    page,
  }) => {
    let row = await counterRow("C19Final");
    expect(row.group).toBe("toBill");
    expect(row.hints.tests).toBe(1);

    const draft = await openDraft(visits.C19Final.visit);
    expect(itemIds(draft.lines)).toEqual([items.tsh]);
    const set = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    const final = await bills.finaliseBill(draft.id, { version: set.version }, desk, db);
    expect(final.status).toBe("final");
    expect((await offered(final.id)).shown).toBe(false);
    row = await counterRow("C19Final");
    expect(row.group).toBe("billed");
    expect(row.hints.tests).toBe(0);

    await loginAs(page, "reception");
    await openCounter(page, visits.C19Final.visit, final.id);
    await expect(billLines(page)).toContainText(`TSH ${tag}`);
    await expect(card(page)).toHaveCount(0);

    await labCase(visits.C19Final, [NAMES.vit]);
    row = await counterRow("C19Final");
    expect(row.group).toBe("toBill");
    expect(row.hints.tests).toBe(1);
    const next = await openDraft(visits.C19Final.visit);
    expect(next.id).not.toBe(final.id);
    expect(itemIds(next.lines)).toEqual([items.vit]);
  });

  test("12. at phone width the card fits without sideways scrolling", async ({ page }) => {
    await autoLabCase(false);
    try {
      await labCase(visits.C19Off, [NAMES.vit]);
      await loginAs(page, "reception");
      await page.setViewportSize({ width: 390, height: 844 });
      await openCounter(page, visits.C19Off.visit);
      await expect(card(page).getByRole("button", { name: "Add all (2)" })).toBeVisible();
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways).toBeLessThanOrEqual(1);
      const box = await card(page).boundingBox();
      for (const button of await card(page).getByRole("button").all()) {
        const within = await button.boundingBox();
        expect(within.x + within.width).toBeLessThanOrEqual(box.x + box.width + 1);
      }
      await expect(addItems(page)).toBeVisible();
    } finally {
      await autoLabCase(true);
    }
  });
  test("13. the Billing settings checkbox switches the automatic add, beside the consultation one", async ({
    page,
  }) => {
    const setting = async () =>
      (await one(`SELECT auto_add_lab_case_tests FROM billing_settings`)).auto_add_lab_case_tests;
    try {
      await loginAs(page, "admin");
      await gotoReady(page, "/settings/billing", () =>
        page.getByRole("form", { name: "Bills", exact: true }),
      );
      const form = page.getByRole("form", { name: "Bills", exact: true });
      await expect(
        form.getByRole("checkbox", {
          name: "Add the doctor's consultation to the bill automatically",
        }),
      ).toBeVisible();
      const box = form.getByRole("checkbox", {
        name: "Add tests from today's lab report to the bill automatically",
      });
      await expect(box).toBeChecked();
      await box.uncheck();
      await form.getByRole("button", { name: "Save" }).click();
      await expect.poll(setting).toBe(false);
      await page.reload();
      await expect(box).not.toBeChecked();
      await box.check();
      await form.getByRole("button", { name: "Save" }).click();
      await expect.poll(setting).toBe(true);
      const api = await apiAs("reception");
      const response = await api.patch("/api/billing/settings", {
        data: { auto_add_lab_case_tests: false },
      });
      expect(response.status()).toBe(403);
      await api.dispose();
      expect(await setting()).toBe(true);
    } finally {
      await autoLabCase(true);
    }
  });
});
