import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const counter = await import("../../../server/services/billing/counterPatients.js");
const payments = await import("../../../server/services/billing/payments.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;

async function consultStarted(visit, minutesAgo) {
  await query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, occurred_at)
     VALUES ($1, 'with_doctor', 'doctor', NOW() - make_interval(mins => $2))`,
    [visit, minutesAgo],
  );
}

async function lineAt(billId, itemId, minutesAgo) {
  const bill = await bills.addLine(billId, { item_id: itemId }, desk, db);
  const line = bill.lines.find((l) => l.service_item_id === itemId);
  await query(
    `UPDATE bill_lines SET created_at = NOW() - make_interval(mins => $2) WHERE id = $1`,
    [line.id, minutesAgo],
  );
  return line.id;
}

let caseSeq = 0;
async function labCase(patient, testName, minutesAgo) {
  caseSeq += 1;
  await query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                            test_names, case_date, case_status, raw_list_json)
     VALUES ($1, $1, $1, $2, $3, $4, $5::date, 'Registered',
             jsonb_build_object('registered_at', to_char((NOW() - make_interval(mins => $6)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`,
    [`P4C48-${caseSeq}-${tag}`, 994800 + caseSeq, patient, [testName], ids.day, minutesAgo],
  );
}

async function asLabReportLine(billId, itemId, minutesAgo) {
  const lineId = await lineAt(billId, itemId, minutesAgo);
  await query(`UPDATE bill_lines SET source = 'lab_case' WHERE id = $1`, [lineId]);
  return lineId;
}

const markedOn = async (billId) =>
  (await bills.readBill(billId, db)).lines.filter((l) => l.after_consult).map((l) => l.id);

async function testOrder(visit, minutesAgo) {
  const { id } = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total, kind, created_at)
     VALUES ($1, 'today', 'pending', 250, 'lab', NOW() - make_interval(mins => $2)) RETURNING id`,
    [visit, minutesAgo],
  );
  await query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 250)`,
    [id, ids.hba1cName],
  );
  return id;
}

test.describe.serial("P4C-48 tests ordered once the consultation started stand apart", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
  });

  test("1. only tests added after the consultation started are marked, with who and when", async () => {
    const { visit } = await extraVisit(ids, "Later", { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    const before = await lineAt(draft.id, ids.hba1c, 30);
    await consultStarted(visit, 20);
    const after = await lineAt(draft.id, ids.abi, 5);
    const bill = await bills.readBill(draft.id, db);
    const byId = new Map(bill.lines.map((l) => [l.id, l]));
    expect(byId.get(before).after_consult).toBeNull();
    expect(byId.get(after).after_consult).toMatchObject({ ordered_by_name: expect.any(String) });
    expect(byId.get(after).after_consult.ordered_at).toBeTruthy();
  });

  test("1b. a HealthRay lab test goes by when its case was registered, not when it reached the bill", async () => {
    const early = await extraVisit(ids, "CaseEarly", { healthray: false });
    await consultStarted(early.visit, 20);
    await labCase(early.patient, ids.hba1cName, 40);
    const earlyDraft = await bills.openDraft(early.visit, desk, db);
    await asLabReportLine(earlyDraft.id, ids.hba1c, 2);
    expect(await markedOn(earlyDraft.id)).toEqual([]);

    const late = await extraVisit(ids, "CaseLate", { healthray: false });
    await consultStarted(late.visit, 20);
    await labCase(late.patient, ids.abiName, 5);
    const lateDraft = await bills.openDraft(late.visit, desk, db);
    const lateLine = await asLabReportLine(lateDraft.id, ids.abi, 2);
    expect(await markedOn(lateDraft.id)).toEqual([lateLine]);

    const unknown = await extraVisit(ids, "CaseNone", { healthray: false });
    await consultStarted(unknown.visit, 20);
    const unknownDraft = await bills.openDraft(unknown.visit, desk, db);
    await asLabReportLine(unknownDraft.id, ids.hba1c, 2);
    expect(await markedOn(unknownDraft.id)).toEqual([]);
  });

  test("1c. the Billing Counter list does not flag lab tests registered before the consultation", async () => {
    const { visit, patient } = await extraVisit(ids, "ListCase", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [visit]);
    await consultStarted(visit, 20);
    await labCase(patient, ids.hba1cName, 40);
    const draft = await bills.openDraft(visit, desk, db);
    await asLabReportLine(draft.id, ids.hba1c, 2);
    const listed = await counter.counterPatients(ids.day, `P4 ListCase ${tag}`, new Date(), db);
    const row = ["toBill", "billed", "waiting"]
      .flatMap((g) => listed[g])
      .find((r) => r.visitId === visit);
    expect(row.hints.newTests).toBe(0);
  });

  test("2. a visit whose consultation has not started marks nothing", async () => {
    const { visit } = await extraVisit(ids, "NotYet", { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    await lineAt(draft.id, ids.hba1c, 1);
    const bill = await bills.readBill(draft.id, db);
    expect(bill.lines.filter((l) => l.after_consult)).toEqual([]);
  });

  test("3. the Payments tab flags a test order placed during the consultation", async () => {
    const { visit } = await extraVisit(ids, "PayLater", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [visit]);
    const early = await testOrder(visit, 40);
    await consultStarted(visit, 20);
    const late = await testOrder(visit, 5);
    const queue = await reception.getPaymentQueue(ids.day, db);
    const all = [...queue.pending, ...queue.cleared];
    expect(all.find((o) => o.orderId === early)?.afterConsult).toBe(false);
    expect(all.find((o) => o.orderId === late)?.afterConsult).toBe(true);
  });

  test("3a. the Billing Counter list flags the patient under Pending bill", async () => {
    const { visit } = await extraVisit(ids, "ListLater", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [visit]);
    await testOrder(visit, 40);
    await consultStarted(visit, 20);
    const flagged = async () => {
      const listed = await counter.counterPatients(ids.day, `P4 ListLater ${tag}`, new Date(), db);
      return listed.toBill.find((r) => r.visitId === visit)?.hints.newTests ?? null;
    };
    expect(await flagged()).toBe(0);
    await testOrder(visit, 5);
    expect(await flagged()).toBeGreaterThan(0);
  });

  test("3b. paid and finalised, the patient goes back to Billed today — one row the whole way", async () => {
    const { visit } = await extraVisit(ids, "RoundTrip", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [visit]);
    const placesOf = async () => {
      const listed = await counter.counterPatients(ids.day, `P4 RoundTrip ${tag}`, new Date(), db);
      return ["toBill", "billed", "waiting"].flatMap((group) =>
        listed[group]
          .filter((r) => r.visitId === visit)
          .map((r) => ({ group, newTests: r.hints.newTests })),
      );
    };
    const payAndFinalise = async (billId) => {
      const bill = await bills.readBill(billId, db);
      const paid = await payments.takePayments(
        billId,
        {
          version: bill.version,
          mode: "upi",
          amount: bill.totals.payable / 100,
          reference: `UPI${Date.now()}`,
        },
        desk,
        db,
      );
      return bills.finaliseBill(billId, { version: paid.version }, desk, db);
    };

    const arrival = await bills.openDraft(visit, desk, db);
    await lineAt(arrival.id, ids.hba1c, 30);
    expect((await payAndFinalise(arrival.id)).status).toBe("final");
    expect(await placesOf()).toEqual([{ group: "billed", newTests: 0 }]);

    await consultStarted(visit, 20);
    const later = await bills.openDraft(visit, desk, db);
    expect(later.id).not.toBe(arrival.id);
    await lineAt(later.id, ids.abi, 5);
    expect(await placesOf()).toEqual([{ group: "toBill", newTests: 1 }]);

    expect((await payAndFinalise(later.id)).status).toBe("final");
    expect(await placesOf()).toEqual([{ group: "billed", newTests: 0 }]);
  });

  test("4. the Bill tab shows them under their own heading", async ({ page }) => {
    const { visit } = await extraVisit(ids, "LaterUi", { healthray: false });
    const draft = await bills.openDraft(visit, desk, db);
    await lineAt(draft.id, ids.hba1c, 30);
    await consultStarted(visit, 20);
    await lineAt(draft.id, ids.abi, 5);
    await page.setViewportSize({ width: 1600, height: 900 });
    await loginAs(page, "reception");
    const heading = () =>
      page.getByRole("columnheader", { name: /New tests after the consultation/ });
    await gotoReady(page, `/giniflow/station/reception?tab=bill&visit=${visit}`, heading);
    await expect(heading()).toBeVisible();
    await expect(heading()).toContainText("1 test");
    const rows = await page.locator('table[aria-label="Bill lines"] tbody tr').allInnerTexts();
    const headingAt = rows.findIndex((t) => t.includes("New tests after the consultation"));
    expect(headingAt).toBeGreaterThan(-1);
    expect(rows.findIndex((t) => t.includes("HbA1c"))).toBeLessThan(headingAt);
    expect(rows.findIndex((t) => t.includes("ABI"))).toBeGreaterThan(headingAt);
  });
});
