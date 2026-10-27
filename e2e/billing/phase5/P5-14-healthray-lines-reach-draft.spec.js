import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  HEALTHRAY_CONSULTATION,
  desk,
  extraVisit,
  failure,
  healthrayBill,
  newTag,
  setUp,
  tearDown,
} from "../phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const { healthrayLinesInBackground } =
  await import("../../../server/services/billing/healthrayBillLines.js");
const { hasNewItems } = await import("../../../server/services/giniflow/machineSync.js");

const db = getPool();
const tag = newTag();
let ids;

const labLine = () => ({ desc: ids.hba1cName, amount: 250, category: "lab", invoice: "OPD/T-2" });
const machineLine = () => ({
  desc: ids.abiName,
  amount: 400,
  category: "machine",
  invoice: "OPD/T-2",
});

const liveLines = (visit) =>
  query(
    `SELECT l.service_item_id, l.source, b.status, b.paid_amount::float AS paid
       FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 AND l.is_live AND b.status <> 'cancelled'
      ORDER BY l.line_no`,
    [visit],
  ).then((r) => r.rows);

const lineAudits = (visit) =>
  query(
    `SELECT a.actor_id FROM billing_audit a
      WHERE a.entity = 'bill_lines' AND a.action = 'create'
        AND a.entity_id IN (SELECT id::text FROM bill_lines WHERE visit_id = $1)
      ORDER BY a.at`,
    [visit],
  ).then((r) => r.rows);

async function laterInvoice(label, extra = [labLine(), machineLine()]) {
  const made = await extraVisit(ids, label);
  await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
    made.visit,
  ]);
  await healthrayBill(ids, made.patient, [HEALTHRAY_CONSULTATION, ...extra]);
  return made;
}

test.describe
  .serial("P5-14 HealthRay bill items reach the draft without opening the Bill tab", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a lab and a machine item billed after check-in land on the draft", async () => {
    const { visit } = await laterInvoice("Later");
    const result = await healthrayLinesInBackground(visit, db);
    expect(result.added.sort()).toEqual([ids.abiName, ids.hba1cName].sort());
    const lines = await liveLines(visit);
    expect(lines.map((l) => l.service_item_id).sort()).toEqual([ids.abi, ids.hba1c].sort());
    expect(lines.every((l) => l.source === "added")).toBe(true);
  });

  test("2. reading the same bill again adds nothing and writes no audit", async () => {
    const { visit } = await laterInvoice("Again");
    await healthrayLinesInBackground(visit, db);
    const before = (await lineAudits(visit)).length;
    expect((await healthrayLinesInBackground(visit, db)).added).toEqual([]);
    expect((await lineAudits(visit)).length).toBe(before);
    expect((await liveLines(visit)).length).toBe(2);
  });

  test("3. a line the desk removed is not put back", async () => {
    const { visit } = await laterInvoice("Removed", [labLine()]);
    await healthrayLinesInBackground(visit, db);
    const draft = await one(
      `SELECT l.bill_id, l.id FROM bill_lines l WHERE l.visit_id = $1 AND l.is_live`,
      [visit],
    );
    await bills.removeLine(draft.bill_id, draft.id, { reason: "Not today" }, desk, db);
    expect((await healthrayLinesInBackground(visit, db)).added).toEqual([]);
    expect(await liveLines(visit)).toEqual([]);
  });

  test("4. a draft open at the counter gets the lines and the stale save is refused", async () => {
    const { visit } = await laterInvoice("Open", []);
    const open = await bills.openDraft(visit, desk, db);
    await healthrayBill(
      ids,
      (await one(`SELECT patient_id FROM giniflow_visits WHERE id = $1`, [visit])).patient_id,
      [HEALTHRAY_CONSULTATION, labLine()],
    );
    expect((await healthrayLinesInBackground(visit, db)).added).toEqual([ids.hba1cName]);
    const stale = await failure(bills.finaliseBill(open.id, { version: open.version }, desk, db));
    expect(stale?.status).toBe(409);
  });

  test("5. the lines are recorded as the last staff member on the bill, or the system", async () => {
    const worked = await laterInvoice("Worked", []);
    await bills.openDraft(worked.visit, desk, db);
    const patient = (
      await one(`SELECT patient_id FROM giniflow_visits WHERE id = $1`, [worked.visit])
    ).patient_id;
    await healthrayBill(ids, patient, [HEALTHRAY_CONSULTATION, labLine()]);
    await healthrayLinesInBackground(worked.visit, db);
    expect((await lineAudits(worked.visit)).map((a) => a.actor_id)).toContain(USERS.reception.id);

    const fresh = await laterInvoice("Fresh", [labLine()]);
    await healthrayLinesInBackground(fresh.visit, db);
    expect((await lineAudits(fresh.visit)).map((a) => a.actor_id)).toEqual([null]);
  });

  test("6. an item with no Scribe service is left for the counter", async () => {
    const { visit } = await laterInvoice("Unmatched", [
      { desc: `Nothing like this ${tag}`, amount: 900, category: "procedure" },
    ]);
    expect((await healthrayLinesInBackground(visit, db)).added).toEqual([]);
    expect(await liveLines(visit)).toEqual([]);
  });

  test("7. nothing is settled or finalised", async () => {
    const { visit } = await laterInvoice("Draft");
    await healthrayLinesInBackground(visit, db);
    const lines = await liveLines(visit);
    expect(lines.every((l) => l.status === "draft" && l.paid === 0)).toBe(true);
  });

  test("8. only items the stored bill did not have count as new", () => {
    const before = { items: [HEALTHRAY_CONSULTATION, { ...labLine(), itemId: 1 }] };
    expect(hasNewItems(before, before)).toBe(false);
    expect(hasNewItems(before, { items: [...before.items, { ...machineLine(), itemId: 2 }] })).toBe(
      true,
    );
    expect(
      hasNewItems(before, { items: [...before.items, { ...HEALTHRAY_CONSULTATION, itemId: 3 }] }),
    ).toBe(false);
    expect(hasNewItems(null, before)).toBe(true);
  });
});
