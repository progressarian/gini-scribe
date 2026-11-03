import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";
import {
  db,
  draftWith,
  dropShifts,
  openDeskShift,
  payOn,
  prepareCategory,
} from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const payments = await import("../../../server/services/billing/payments.js");
const deposits = await import("../../../server/services/billing/deposits.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const reports = await import("../../../server/services/billing/reports.js");
const { correctPaymentMode } =
  await import("../../../server/services/billing/paymentCorrection.js");

const tag = newTag();
let ids;

const rupees = (bill) => bill.totals.payable / 100;
const half = (bill) => Math.floor(rupees(bill) / 2);
const paymentRow = (id) => one(`SELECT mode, upi_app, reference FROM payments WHERE id = $1`, [id]);

async function billFor(label) {
  const { bill } = await draftWith(ids, label, [{ item: ids.brace }]);
  return bill;
}

test.describe.serial("P4C-57 NEFT / cheque and the UPI app at the counter", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(0);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. a UPI payment needs its app, and the app is kept on the payment", async () => {
    const bill = await billFor("UpiApp");
    await expect(
      payOn(bill.id, [{ mode: "upi", amount: half(bill), reference: `U-${tag}` }]),
    ).rejects.toMatchObject({ status: 400, message: /Choose the UPI app/ });
    await expect(
      payOn(bill.id, [{ mode: "upi", upi_app: "gpay", amount: half(bill), reference: `U-${tag}` }]),
    ).rejects.toMatchObject({ status: 400 });

    await payOn(bill.id, [
      { mode: "upi", upi_app: "bharatpe", amount: half(bill), reference: `U-${tag}` },
    ]);
    const [taken] = await payments.listPayments(bill.id, db);
    expect(taken).toMatchObject({ mode: "upi", upi_app: "bharatpe", reference: `U-${tag}` });
  });

  test("2. the app is ignored for a card payment", async () => {
    const bill = await billFor("CardNoApp");
    await payOn(bill.id, [
      { mode: "card", upi_app: "paytm", amount: half(bill), reference: `C-${tag}` },
    ]);
    const [taken] = await payments.listPayments(bill.id, db);
    expect(taken).toMatchObject({ mode: "card", upi_app: null });
  });

  test("3. NEFT / cheque needs its reference and counts in the shift, not the drawer", async () => {
    const bill = await billFor("Neft");
    const drawerBefore = (await shifts.currentShift(desk, db)).expected_cash;
    await expect(payOn(bill.id, [{ mode: "neft", amount: rupees(bill) }])).rejects.toMatchObject({
      status: 400,
      message: /reference/,
    });

    await payOn(bill.id, [{ mode: "neft", amount: rupees(bill), reference: `UTR-${tag}` }]);
    const [taken] = await payments.listPayments(bill.id, db);
    expect(taken).toMatchObject({ mode: "neft", upi_app: null, reference: `UTR-${tag}` });

    const shift = await shifts.currentShift(desk, db);
    expect(shift.collected.neft).toBe(rupees(bill));
    expect(shift.expected_cash).toBe(drawerBefore);
  });

  test("4. a deposit can be taken by NEFT, and a UPI deposit needs its app", async () => {
    const bill = await billFor("DepositModes");
    const receive = (body) => deposits.receiveDeposit(bill.patient_id, body, desk, db);
    await expect(
      receive({ mode: "upi", amount: 500, reference: `DU-${tag}` }),
    ).rejects.toMatchObject({ status: 400, message: /Choose the UPI app/ });

    const byUpi = await receive({
      mode: "upi",
      upi_app: "paytm",
      amount: 500,
      reference: `DU-${tag}`,
    });
    expect(await paymentRow(byUpi.payment_id)).toEqual({
      mode: "upi",
      upi_app: "paytm",
      reference: `DU-${tag}`,
    });
    const byNeft = await receive({ mode: "neft", amount: 700, reference: `CHQ-${tag}` });
    expect(await paymentRow(byNeft.payment_id)).toEqual({
      mode: "neft",
      upi_app: null,
      reference: `CHQ-${tag}`,
    });
    expect((await deposits.getDeposit(bill.patient_id, db)).balance).toBe(120000);
  });

  test("5. correcting to UPI asks for the app; correcting away from UPI clears it", async () => {
    const bill = await billFor("CorrectApp");
    await payOn(bill.id, [{ mode: "cash", amount: half(bill) }]);
    const [cash] = await payments.listPayments(bill.id, db);
    const correct = (body) =>
      correctPaymentMode(cash.id, { reason: "Entered as the wrong mode", ...body }, desk, db);

    await expect(correct({ mode: "upi", reference: `CU-${tag}` })).rejects.toMatchObject({
      status: 400,
      message: /Choose the UPI app/,
    });
    await correct({ mode: "upi", upi_app: "other", reference: `CU-${tag}` });
    expect(await paymentRow(cash.id)).toEqual({
      mode: "upi",
      upi_app: "other",
      reference: `CU-${tag}`,
    });

    await correct({ mode: "upi", upi_app: "paytm", reference: `CU-${tag}` });
    expect((await paymentRow(cash.id)).upi_app).toBe("paytm");

    await correct({ mode: "neft", reference: `CN-${tag}` });
    expect(await paymentRow(cash.id)).toEqual({
      mode: "neft",
      upi_app: null,
      reference: `CN-${tag}`,
    });
  });

  test("6. money paid by NEFT goes back by NEFT when refunded the way it was paid", async () => {
    const bill = await billFor("NeftBack");
    await payOn(bill.id, [{ mode: "neft", amount: rupees(bill), reference: `NB-${tag}` }]);
    const legs = await payments.refundShares(db, bill.id, 1000);
    expect(legs).toEqual([{ mode: "neft", amount: 1000 }]);
  });

  test("7. the database refuses an app on a payment that isn't UPI", async () => {
    const bill = await billFor("DbCheck");
    await payOn(bill.id, [{ mode: "card", amount: half(bill), reference: `DB-${tag}` }]);
    const [card] = await payments.listPayments(bill.id, db);
    await expect(
      db.query(`UPDATE payments SET upi_app = 'paytm' WHERE id = $1`, [card.id]),
    ).rejects.toMatchObject({ constraint: "payments_upi_app_check" });
  });

  test("8. the Collections report names NEFT / cheque", async () => {
    const today = (await one(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
    const report = await reports.runReport("collections", { from: today, to: today }, db);
    const modes = report.sections.find((part) => part.key === "modes");
    expect(modes.rows.map((row) => row.label)).toContain("NEFT / Cheque");
  });
});
