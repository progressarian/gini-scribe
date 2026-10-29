import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  db,
  draftWith,
  dropShifts,
  openDeskShift,
  payOn,
  prepareCategory,
} from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const deposits = await import("../../../server/services/billing/deposits.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const reports = await import("../../../server/services/billing/reports.js");
const receiptPdf = await import("../../../server/services/billing/depositReceiptPdf.js");

const tag = newTag();
const otherDesk = { actorId: admin.actorId, ip: "10.9.4.2", role: "reception" };
let ids;

const receive = (patientId, body) => deposits.receiveDeposit(patientId, body, desk, db);
const voidIt = (entryId, ctx = desk, reason = "Entered by mistake, no money received") =>
  deposits.voidDeposit(entryId, { reason }, ctx, db);
const drawer = async () => (await shifts.currentShift(desk, db)).expected_cash;
const account = (patientId, ctx = desk) => deposits.getDeposit(patientId, db, ctx);

async function patient(label) {
  const { bill } = await draftWith(ids, label, [{ item: ids.brace }]);
  return bill;
}

test.describe.serial("D06 void a wrongly taken deposit receipt", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(1000);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. an unused UPI deposit is voided: balance, shift and receipt all reflect it", async () => {
    const bill = await patient("VoidUpi");
    const shiftBefore = (await shifts.currentShift(desk, db)).deposits;
    const taken = await receive(bill.patient_id, {
      mode: "upi",
      amount: 1125,
      reference: `UPI-${tag}`,
    });
    const received = (await account(bill.patient_id)).entries[0];
    expect(received).toMatchObject({ kind: "received", can_void: true });

    const done = await voidIt(received.id);
    expect(done).toMatchObject({ amount: 112500, balance: 0, receipt_no: taken.receipt_no });

    const after = await account(bill.patient_id);
    expect(after.balance).toBe(0);
    expect(after.entries[0]).toMatchObject({
      kind: "voided",
      amount: -112500,
      receipt_no: taken.receipt_no,
      note: "Entered by mistake, no money received",
    });
    expect(after.entries[1]).toMatchObject({ kind: "received", can_void: false });
    expect(after.entries[1].voided_at).toBeTruthy();

    const shiftAfter = (await shifts.currentShift(desk, db)).deposits;
    expect(shiftAfter).toMatchObject({
      count: shiftBefore.count,
      received: shiftBefore.received,
    });

    const view = await receiptPdf.depositReceiptView(taken.payment_id, db);
    expect(view.payment.voided_at).toBeTruthy();
    expect(receiptPdf.buildDepositReceiptHtml(view)).toContain("VOID");

    const audit = await one(
      `SELECT COUNT(*)::int AS n FROM billing_audit
        WHERE entity = 'payments' AND entity_id = $1 AND action = 'update'`,
      [taken.payment_id],
    );
    expect(audit.n).toBe(1);
  });

  test("2. a voided cash deposit leaves the drawer's expected cash", async () => {
    const bill = await patient("VoidCash");
    const before = await drawer();
    await receive(bill.patient_id, { mode: "cash", amount: 500 });
    expect(await drawer()).toBe(before + 500);
    const received = (await account(bill.patient_id)).entries[0];
    await voidIt(received.id);
    expect(await drawer()).toBe(before);
  });

  test("3. the Collections and Deposits reports leave a voided receipt out", async () => {
    const today = (await one(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
    const upiDeposits = async () => {
      const result = await reports.runReport("collections", { from: today, to: today }, db);
      const modes = result.sections.find((part) => part.key === "modes");
      return modes.rows.find((row) => row.label === "UPI — deposit taken")?.received ?? 0;
    };
    const bill = await patient("VoidReport");
    const before = await upiDeposits();
    await receive(bill.patient_id, { mode: "upi", amount: 300, reference: `UPI-R-${tag}` });
    expect(await upiDeposits()).toBe(before + 30000);
    const received = (await account(bill.patient_id)).entries[0];
    await voidIt(received.id);
    expect(await upiDeposits()).toBe(before);

    const moves = await reports.runReport("deposits", { from: today, to: today }, db);
    const held = moves.sections.find((part) => part.key === "held").rows[0];
    const days = moves.sections.find((part) => part.key === "days").total;
    expect(days.voided).toBeGreaterThanOrEqual(30000);
    expect(held.closing - held.opening).toBe(days.net);
  });

  test("4. part of the deposit already used on a bill: refused, nothing changes", async () => {
    const bill = await patient("VoidUsed");
    await receive(bill.patient_id, { mode: "upi", amount: 1000, reference: `UPI-U-${tag}` });
    const received = (await account(bill.patient_id)).entries[0];
    await payOn(bill.id, [{ mode: "deposit", amount: 100 }]);
    await expect(voidIt(received.id)).rejects.toMatchObject({ status: 409 });
    const after = await account(bill.patient_id);
    expect(after.balance).toBe(90000);
    expect(after.entries.some((e) => e.kind === "voided")).toBe(false);
  });

  test("5. money held for a pay back can't be voided", async () => {
    const bill = await patient("VoidHeld");
    await receive(bill.patient_id, { mode: "cash", amount: 400 });
    const received = (await account(bill.patient_id)).entries[0];
    await deposits.requestRefund(
      bill.patient_id,
      { amount: 400, mode: "cash", reason: "Patient wants it back" },
      desk,
      db,
    );
    await expect(voidIt(received.id)).rejects.toMatchObject({ status: 409 });
  });

  test("6. a receipt is voided only once", async () => {
    const bill = await patient("VoidTwice");
    await receive(bill.patient_id, { mode: "cash", amount: 200 });
    const received = (await account(bill.patient_id)).entries[0];
    await voidIt(received.id);
    await expect(voidIt(received.id)).rejects.toMatchObject({ status: 409 });
    const voided = (await account(bill.patient_id)).entries[0];
    await expect(voidIt(voided.id)).rejects.toMatchObject({ status: 409 });
  });

  test("7. a short reason is refused", async () => {
    const bill = await patient("VoidReason");
    await receive(bill.patient_id, { mode: "cash", amount: 200 });
    const received = (await account(bill.patient_id)).entries[0];
    await expect(voidIt(received.id, desk, "oops")).rejects.toMatchObject({ status: 400 });
  });

  test("8. reception can't void another desk's receipt", async () => {
    const bill = await patient("VoidOther");
    await receive(bill.patient_id, { mode: "cash", amount: 200 });
    const received = (await account(bill.patient_id, otherDesk)).entries[0];
    expect(received.can_void).toBe(false);
    await expect(voidIt(received.id, otherDesk)).rejects.toMatchObject({ status: 403 });
  });

  test("9. after the shift closes, reception can't void it but an admin can, and the closed drawer is recounted", async () => {
    const bill = await patient("VoidClosed");
    await receive(bill.patient_id, { mode: "cash", amount: 600 });
    const received = (await account(bill.patient_id)).entries[0];
    const open = await shifts.currentShift(desk, db);
    const closed = await shifts.closeShift(open.id, { counted_cash: open.expected_cash }, desk, db);
    expect(Number(closed.difference)).toBe(0);

    expect((await account(bill.patient_id)).entries[0].can_void).toBe(false);
    await expect(voidIt(received.id)).rejects.toMatchObject({ status: 403 });

    expect((await account(bill.patient_id, admin)).entries[0].can_void).toBe(true);
    await voidIt(received.id, admin);
    const recounted = await shifts.getShift(open.id, db);
    expect(Number(recounted.expected_cash)).toBe(Number(closed.expected_cash) - 600);
    expect(Number(recounted.difference)).toBe(600);
    await openDeskShift(1000);
  });
});
