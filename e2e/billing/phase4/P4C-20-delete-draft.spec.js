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
const requests = await import("../../../server/services/billing/billingRequests.js");
const { inTransaction } = await import("../../../server/services/billing/transaction.js");

const db = getPool();
const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const admin = { actorId: USERS.admin.id, ip: "10.9.20.1", role: "admin" };
const visits = {};
let ids;
let autoBefore;
let labBefore;
let caseSeq = 0;

async function labCase(visit, tests) {
  caseSeq += 1;
  const caseNo = `P4C20-${tag}-${caseSeq}`;
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            appointment_id, test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, $2, $3, $4, $5, $6::date, 'Registered', '{}'::jsonb)`,
    [caseNo, 980000 + caseSeq, visit.patient, visit.appointment, tests, ids.day],
  );
}

async function order(visitId, tests) {
  const made = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 0, 'payment_pending', 'lab') RETURNING id`,
    [visitId, tests.reduce((sum, t) => sum + t.price, 0)],
  );
  for (const t of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price, status)
       VALUES ($1, $2, $3, 'ordered')`,
      [made.id, t.name, t.price],
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

const visitLinesOf = (visitId) =>
  query(
    `SELECT l.service_item_id, l.source, l.lab_order_id, i.kind, b.status, b.id AS bill_id
       FROM bill_lines l JOIN bills b ON b.id = l.bill_id
       JOIN service_items i ON i.id = l.service_item_id
      WHERE l.visit_id = $1 AND l.is_live
      ORDER BY l.line_no`,
    [visitId],
  ).then((r) => r.rows);

async function call(role, method, url, options) {
  const api = await apiAs(role);
  const response = await api[method](url, options);
  const body = await response.json();
  await api.dispose();
  return { status: response.status(), body };
}

async function openDraft(visitId) {
  const { status, body } = await call("reception", "post", `/api/billing/visits/${visitId}/bills`, {
    data: {},
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return body;
}

const deleteDraft = (billId, data = {}, role = "reception") =>
  call(role, "post", `/api/billing/bills/${billId}/delete-draft`, { data });

const billExists = async (billId) =>
  (await query(`SELECT 1 FROM bills WHERE id = $1`, [billId])).rows.length > 0;

const auditOf = (entity, entityIds) =>
  query(
    `SELECT entity_id, action, before, after, actor_id FROM billing_audit
      WHERE entity = $1 AND entity_id = ANY($2::text[]) AND action = 'delete'
      ORDER BY at, id`,
    [entity, entityIds],
  ).then((r) => r.rows);

async function counterRow(label) {
  const { status, body } = await call("reception", "get", "/api/billing/counter/patients", {
    params: { q: tag },
  });
  expect(status).toBe(200);
  for (const group of ["toBill", "billed", "waiting"]) {
    const row = body[group].find((r) => r.name === `P4 ${label} ${tag}`);
    if (row) return { ...row, group };
  }
  return null;
}

const actions = (page) => page.getByRole("region", { name: "Bill actions" });
const billLines = (page) => page.getByRole("region", { name: "Bill lines" });
const dialog = (page) => page.getByRole("dialog");

async function openCounter(page, visitId) {
  await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visitId}`, () => actions(page));
}

test.describe.serial("P4C-20 delete a draft bill at the counter", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    labBefore = await autoLabCase(true);
    await payRule(ids, ids.pensioner, { name: "pensioner pays nothing", patient_pays: "nothing" });
    for (const label of [
      "C20All",
      "C20Plain",
      "C20Paid",
      "C20Final",
      "C20Request",
      "C20Earlier",
      "C20Ui",
      "C20UiPaid",
      "C20Phone",
    ]) {
      visits[label] = await extraVisit(ids, label, { visitType: "Follow Up" });
    }
    visits.C20All.order = await order(visits.C20All.visit, [{ name: ids.hba1cName, price: 250 }]);
    await labCase(visits.C20All, [ids.abiName]);
  });

  test.afterAll(async () => {
    try {
      if (labBefore !== undefined) await autoLabCase(labBefore);
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
      await query(`DELETE FROM lab_cases WHERE case_no LIKE $1`, [`P4C20-${tag}-%`]);
    } finally {
      await tearDown(ids);
    }
  });

  test("1. deleting a draft with a reason removes every line, audits each, and releases the order", async () => {
    await autoConsultation(true);
    let draft;
    try {
      draft = await openDraft(visits.C20All.visit);
    } finally {
      await autoConsultation(false);
    }
    draft = await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const before = await visitLinesOf(visits.C20All.visit);
    expect(before.map((l) => [l.kind, l.source]).sort()).toEqual(
      [
        ["consultation", "visit"],
        ["procedure", "added"],
        ["test", "lab_case"],
        ["test", "lab_order"],
      ].sort(),
    );
    const onBill = await inTransaction(
      (client) => visitLines.refuseOrderOnBill(client, visits.C20All.order).catch((e) => e),
      db,
    );
    expect(onBill?.status).toBe(409);

    const lineIds = draft.lines.map((l) => l.id);
    const { status, body } = await deleteDraft(draft.id, { reason: "  Wrong patient  " });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ deleted: true, bill_id: draft.id, visit_id: visits.C20All.visit });
    expect(body.removed).toHaveLength(4);
    expect(await billExists(draft.id)).toBe(false);
    expect(await visitLinesOf(visits.C20All.visit)).toEqual([]);

    const [billAudit] = await auditOf("bills", [draft.id]);
    expect(billAudit.after).toMatchObject({ deleted: true, reason: "Wrong patient", lines: 4 });
    expect(billAudit.before).toMatchObject({ status: "draft", visit_id: visits.C20All.visit });
    expect(billAudit.actor_id).toBe(USERS.reception.id);
    const lineAudit = await auditOf("bill_lines", lineIds);
    expect(lineAudit).toHaveLength(4);
    for (const row of lineAudit) {
      expect(row.after).toEqual({ removed: true, reason: "Wrong patient" });
      expect(row.before.bill_id).toBe(draft.id);
    }

    const free = await inTransaction(
      (client) => visitLines.refuseOrderOnBill(client, visits.C20All.order).catch((e) => e),
      db,
    );
    expect(free).toBeUndefined();
    const { payment_status: paymentStatus } = await one(
      `SELECT payment_status FROM giniflow_lab_orders WHERE id = $1`,
      [visits.C20All.order],
    );
    expect(paymentStatus).toBe("pending");
  });

  test("2. reopening gives a fresh empty draft; nothing automatic comes back, and the cards still offer them", async () => {
    await autoConsultation(true);
    let fresh;
    try {
      fresh = await openDraft(visits.C20All.visit);
      await openDraft(visits.C20All.visit);
      const checkIn = await visitLines.draftAtCheckIn(visits.C20All.visit, desk, db);
      expect(checkIn).toMatchObject({ ok: true, bill_id: fresh.id, consultation: null });
    } finally {
      await autoConsultation(false);
    }
    expect(fresh.status).toBe("draft");
    expect(fresh.lines).toEqual([]);
    expect(await visitLinesOf(visits.C20All.visit)).toEqual([]);

    const consult = await call("reception", "get", "/api/billing/consultation-suggestion", {
      params: { bill_id: fresh.id },
    });
    expect(consult.status).toBe(200);
    expect(consult.body.shown).toBe(true);
    expect(consult.body.suggested).not.toBeNull();

    const lab = await call("reception", "get", "/api/billing/lab-case-tests", {
      params: { bill_id: fresh.id },
    });
    expect(lab.status).toBe(200);
    expect(lab.body.tests).toMatchObject([{ item_id: ids.abi, removed: true }]);

    const added = await call("reception", "post", `/api/billing/bills/${fresh.id}/lab-case-lines`, {
      data: { item_ids: [ids.abi] },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const again = await bills.addLine(fresh.id, { item_id: ids.hba1c }, desk, db);
    expect(again.lines.map((l) => l.service_item_id).sort()).toEqual([ids.abi, ids.hba1c].sort());
  });

  test("3. deleting without a reason stores a null reason", async () => {
    const draft = await openDraft(visits.C20Plain.visit);
    const filled = await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    const { status } = await deleteDraft(draft.id);
    expect(status).toBe(200);
    const [billAudit] = await auditOf("bills", [draft.id]);
    expect(billAudit.after).toMatchObject({ deleted: true, reason: null, lines: 1 });
    const [lineAudit] = await auditOf("bill_lines", [filled.lines[0].id]);
    expect(lineAudit.after).toEqual({ removed: true, reason: null });
    const blank = await deleteDraft((await openDraft(visits.C20Plain.visit)).id, { reason: "   " });
    expect(blank.status).toBe(200);
  });

  test("4. a draft with money taken on it is refused and kept", async () => {
    const draft = await openDraft(visits.C20Paid.visit);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.paid }, desk, db);
    await payments.takePayments(
      draft.id,
      { version: ready.version, mode: "card", amount: 200, reference: `C20-${tag}` },
      desk,
      db,
    );
    const { status, body } = await deleteDraft(draft.id, { reason: "try" });
    expect(status).toBe(409);
    expect(body.error).toBe("Money was taken on this draft — finalise it or refund it first");
    expect(await billExists(draft.id)).toBe(true);
    expect(await visitLinesOf(visits.C20Paid.visit)).toHaveLength(1);
  });

  test("5. a final bill is refused", async () => {
    const draft = await openDraft(visits.C20Final.visit);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    const final = await bills.finaliseBill(draft.id, { version: ready.version }, desk, db);
    const { status, body } = await deleteDraft(final.id);
    expect(status).toBe(409);
    expect(body.error).toContain("already final");
    expect(await billExists(final.id)).toBe(true);
  });

  test("6. a pending desk request on the draft is refused; once answered the draft deletes and the request is kept", async () => {
    const draft = await openDraft(visits.C20Request.visit);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    const request = await requests.createNewItemRequest(
      {
        proposed_name: `P4 C20 new thing ${tag}`,
        reason: "Not in the list",
        visit_id: visits.C20Request.visit,
        bill_id: draft.id,
      },
      desk,
      db,
    );
    const refused = await deleteDraft(draft.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("waiting for an admin");
    expect(await billExists(draft.id)).toBe(true);

    await requests.rejectRequest(request.id, { note: "Use brace" }, admin, db);
    const { status } = await deleteDraft(draft.id);
    expect(status).toBe(200);
    const kept = await one(`SELECT status, bill_id, visit_id FROM billing_requests WHERE id = $1`, [
      request.id,
    ]);
    expect(kept).toEqual({
      status: "rejected",
      bill_id: null,
      visit_id: visits.C20Request.visit,
    });
  });

  test("7. a deleted draft is gone from previous bills, the counter list hints and dues", async () => {
    const first = await openDraft(visits.C20Earlier.visit);
    await bills.addLine(first.id, { item_id: ids.brace }, desk, db);
    const ready = await bills.setCategory(first.id, { category: ids.pensioner }, desk, db);
    const final = await bills.finaliseBill(first.id, { version: ready.version }, desk, db);
    const draft = await openDraft(visits.C20Earlier.visit);
    expect(draft.id).not.toBe(final.id);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    let row = await counterRow("C20Earlier");
    expect(row.group).toBe("toBill");

    expect((await deleteDraft(draft.id)).status).toBe(200);
    const listed = await call(
      "reception",
      "get",
      `/api/billing/visits/${visits.C20Earlier.visit}/bills`,
    );
    expect(listed.body.map((b) => b.id)).toEqual([final.id]);
    row = await counterRow("C20Earlier");
    expect(row.group).toBe("billed");
    expect(row.hints.due ?? 0).toBe(0);
    const dues = await call("reception", "get", "/api/billing/dues/today");
    expect(JSON.stringify(dues.body)).not.toContain(draft.id);
  });

  test("8. only the billing desk may delete, and the reason is checked", async () => {
    const draft = await openDraft(visits.C20Ui.visit);
    expect((await deleteDraft(draft.id, {}, "lab")).status).toBe(403);
    expect((await deleteDraft(draft.id, { reason: "x".repeat(1001) })).status).toBe(400);
    expect((await deleteDraft(draft.id, { price: 5 })).status).toBe(400);
    expect(
      (await call("reception", "post", "/api/billing/bills/not-a-bill/delete-draft", { data: {} }))
        .status,
    ).toBe(400);
    expect(await billExists(draft.id)).toBe(true);
  });

  test("9. the counter: Delete draft asks with an optional reason, then shows a fresh empty draft", async ({
    page,
  }) => {
    const draft = await openDraft(visits.C20Ui.visit);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    await loginAs(page, "reception");
    await openCounter(page, visits.C20Ui.visit);
    await expect(billLines(page)).toContainText(`Ankle brace ${tag}`);
    await page.getByLabel("Discount code", { exact: true }).fill("SAVEDCODE");
    const formKey = `billing.counter.form.${draft.id}`;
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), formKey))
      .toContain("SAVEDCODE");

    await actions(page).getByRole("button", { name: "Delete draft" }).click();
    await expect(dialog(page)).toContainText("Delete this draft bill?");
    const confirm = dialog(page).getByRole("button", { name: "Delete draft" });
    await expect(confirm).toBeEnabled();
    await dialog(page).getByRole("button", { name: "Keep it" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await billExists(draft.id)).toBe(true);

    await actions(page).getByRole("button", { name: "Delete draft" }).click();
    await dialog(page)
      .getByLabel("Why is this draft being deleted? (optional)")
      .fill("Opened on the wrong visit");
    await dialog(page).getByRole("button", { name: "Delete draft" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(billLines(page)).toContainText("Nothing on this bill yet.");
    await expect.poll(() => billExists(draft.id)).toBe(false);
    const [billAudit] = await auditOf("bills", [draft.id]);
    expect(billAudit.after.reason).toBe("Opened on the wrong visit");
    const fresh = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      visits.C20Ui.visit,
    ]);
    expect(fresh.id).not.toBe(draft.id);
    expect(await page.evaluate((key) => localStorage.getItem(key), formKey)).toBeNull();
    await expect(page).toHaveURL(new RegExp(`visit=${visits.C20Ui.visit}`));
    await expect(page).not.toHaveURL(new RegExp(draft.id));
  });

  test("10. the counter shows the refusal inside the dialog", async ({ page }) => {
    const draft = await openDraft(visits.C20UiPaid.visit);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.paid }, desk, db);
    await payments.takePayments(
      draft.id,
      { version: ready.version, mode: "card", amount: 100, reference: `C20U-${tag}` },
      desk,
      db,
    );
    await loginAs(page, "reception");
    await openCounter(page, visits.C20UiPaid.visit);
    await actions(page).getByRole("button", { name: "Delete draft" }).click();
    await dialog(page).getByRole("button", { name: "Delete draft" }).click();
    await expect(dialog(page)).toContainText(
      "Money was taken on this draft — finalise it or refund it first",
    );
    await dialog(page).getByRole("button", { name: "Keep it" }).click();
    expect(await billExists(draft.id)).toBe(true);
  });

  test("11. a final bill shows no Delete draft button", async ({ page }) => {
    const { id } = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'final'`, [
      visits.C20Final.visit,
    ]);
    await loginAs(page, "reception");
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visits.C20Final.visit}&bill=${id}`, () =>
      actions(page),
    );
    await expect(actions(page).getByRole("button", { name: "Cancel unpaid bill" })).toBeVisible();
    await expect(actions(page).getByRole("button", { name: "Delete draft" })).toHaveCount(0);
  });

  test("12. at phone width the button and dialog fit without sideways scrolling", async ({
    page,
  }) => {
    const draft = await openDraft(visits.C20Phone.visit);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    await loginAs(page, "reception");
    await page.setViewportSize({ width: 390, height: 844 });
    await openCounter(page, visits.C20Phone.visit);
    const button = actions(page).getByRole("button", { name: "Delete draft" });
    await expect(button).toBeVisible();
    const sideways = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await sideways()).toBeLessThanOrEqual(1);
    await button.click();
    const box = await dialog(page).locator("> div").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await dialog(page).getByRole("button", { name: "Delete draft" }).click();
    await expect(billLines(page)).toContainText("Nothing on this bill yet.");
    expect(await sideways()).toBeLessThanOrEqual(1);
  });
});
