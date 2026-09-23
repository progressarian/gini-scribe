import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  extraVisit,
  newTag,
  payRule,
  refused,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const settings = await import("../../../server/services/billing/billingSettings.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.9", role: USERS.admin.role };
let ids;
let payLaterWas = null;

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = ANY($1::int[])`,
    [[USERS.reception.id]],
  );

const allowPayLater = (on) => settings.updateSettings({ allow_pay_later: on }, admin, db);

const duesFor = async (filters = {}) =>
  (await payments.listDues(filters, db)).filter((row) => row.patient.name.endsWith(tag));

const dueBill = async (label, { payLater = true } = {}) => {
  const { visit, patient } = await extraVisit(ids, label);
  const draft = await bills.openDraft(visit, desk, db);
  await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
  const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
  const final = await bills.finaliseBill(
    draft.id,
    { version: ready.version, pay_later: payLater },
    desk,
    db,
  );
  return { bill: final, patient, visit };
};

test.describe.serial("P4-16 pay later and dues", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner pays", patient_pays: "full" });
    payLaterWas = (await settings.getSettings(db)).allow_pay_later;
    await closeOpenShifts();
    ids.shift = (await shifts.openShift({ opening_cash: 0 }, desk, db)).id;
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await closeOpenShifts();
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
    if (payLaterWas !== null) await allowPayLater(payLaterWas);
  });

  test("1. pay later is refused while the setting is off", async () => {
    await allowPayLater(false);
    const { visit } = await extraVisit(ids, "Off");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    expect(ready.totals.payable).toBe(50000);
    await refused(
      bills.finaliseBill(draft.id, { version: ready.version, pay_later: true }, desk, db),
      409,
      /Pay later isn't allowed/,
      "pay later with the setting off",
    );
    expect((await one(`SELECT status FROM bills WHERE id = $1`, [draft.id])).status).toBe("draft");
    expect(await duesFor()).toHaveLength(0);
    ids.offBill = draft.id;
    ids.offVersion = ready.version;
  });

  test("2. with the setting on, the bill is final with a balance and appears on the dues list", async () => {
    await allowPayLater(true);
    const bill = await bills.finaliseBill(
      ids.offBill,
      { version: ids.offVersion, pay_later: true },
      desk,
      db,
    );
    expect(bill.status).toBe("final");
    expect(bill.pay_later).toBe(true);
    expect(bill.totals.paid).toBe(0);
    const dues = await duesFor();
    expect(dues).toHaveLength(1);
    expect(dues[0]).toMatchObject({
      bill_id: ids.offBill,
      bill_no: bill.bill_no,
      payable: 50000,
      paid: 0,
      outstanding: 50000,
      pay_later: true,
      days: 0,
    });
    expect(dues[0].patient.file_no).toMatch(new RegExp(tag));
    ids.dueBill = ids.offBill;
    ids.dueVersion = bill.version;
    ids.duePatient = dues[0].patient.id;
  });

  test("3. a category can refuse pay later while the setting is on", async () => {
    await query(`UPDATE patient_schemes SET allow_pay_later = FALSE WHERE code = $1`, [
      ids.pensioner,
    ]);
    const { visit } = await extraVisit(ids, "Cat");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    await refused(
      bills.finaliseBill(draft.id, { version: ready.version, pay_later: true }, desk, db),
      409,
      /Pay later isn't allowed/,
      "a category that refuses pay later",
    );
    await query(`UPDATE patient_schemes SET allow_pay_later = NULL WHERE code = $1`, [
      ids.pensioner,
    ]);
    const bill = await bills.finaliseBill(
      draft.id,
      { version: ready.version, pay_later: true },
      desk,
      db,
    );
    expect(bill.status).toBe("final");
  });

  test("4. later payments on any day reduce the balance, and the bill leaves the list when paid", async () => {
    const part = await payments.takePayments(
      ids.dueBill,
      { version: ids.dueVersion, mode: "cash", amount: 200 },
      desk,
      db,
    );
    expect(part.totals.outstanding).toBe(30000);
    const still = await duesFor({ patientId: ids.duePatient });
    expect(still).toHaveLength(1);
    expect(still[0]).toMatchObject({ paid: 20000, outstanding: 30000 });
    const rest = await payments.takePayments(
      ids.dueBill,
      { version: part.version, mode: "upi", amount: 300, reference: `UPI-${tag}` },
      desk,
      db,
    );
    expect(rest.totals.outstanding).toBe(0);
    expect(await duesFor({ patientId: ids.duePatient })).toHaveLength(0);
    await refused(
      payments.takePayments(
        ids.dueBill,
        { version: rest.version, mode: "cash", amount: 1 },
        desk,
        db,
      ),
      409,
      /Nothing is left to collect/,
      "paying a due that is settled",
    );
  });

  test("5. the list is oldest first, and takes a patient and a date range", async () => {
    const older = await dueBill("Older");
    const newer = await dueBill("Newer");
    await query(`UPDATE bills SET bill_date = bill_date - 3 WHERE id = $1`, [older.bill.id]);
    await query(`UPDATE bills SET bill_date = bill_date - 1 WHERE id = $1`, [newer.bill.id]);
    const both = [older.bill.id, newer.bill.id];
    const onlyThese = (list) =>
      list.filter((row) => both.includes(row.bill_id)).map((row) => row.bill_id);
    const dues = await duesFor();
    expect(onlyThese(dues)).toEqual(both);
    expect(dues.map((row) => row.bill_date)).toEqual([...dues.map((row) => row.bill_date)].sort());
    expect(dues.find((row) => row.bill_id === older.bill.id).days).toBe(3);
    const { day } = await one(
      `SELECT ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 2)::text AS day`,
    );
    expect(onlyThese(await duesFor({ from: day }))).toEqual([newer.bill.id]);
    expect(onlyThese(await duesFor({ to: day }))).toEqual([older.bill.id]);
    const mine = await duesFor({ patientId: newer.patient });
    expect(mine.map((row) => row.bill_id)).toEqual([newer.bill.id]);
    await refused(
      payments.listDues({ from: day, to: "2020-01-01" }, db),
      400,
      /start date is after the end date/,
      "a backwards date range",
    );
  });

  test("6. a draft, a fully paid bill and a cancelled bill are never dues", async () => {
    const { visit } = await extraVisit(ids, "Paid");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    expect((await duesFor()).map((row) => row.bill_id)).not.toContain(draft.id);
    const paid = await payments.takePayments(
      draft.id,
      { version: ready.version, mode: "cash", amount: 500 },
      desk,
      db,
    );
    await bills.finaliseBill(draft.id, { version: paid.version }, desk, db);
    expect((await duesFor()).map((row) => row.bill_id)).not.toContain(draft.id);

    const gone = await dueBill("Gone");
    expect((await duesFor()).map((row) => row.bill_id)).toContain(gone.bill.id);
    await bills.cancelBill(gone.bill.id, { reason: "the patient left" }, desk, db);
    expect((await duesFor()).map((row) => row.bill_id)).not.toContain(gone.bill.id);
  });
});
