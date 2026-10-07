import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { apiAs } from "../../helpers/auth.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import { admin, db, dropShifts, openDeskShift, prepareCategory } from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const deposits = await import("../../../server/services/billing/deposits.js");
const requests = await import("../../../server/services/billing/billingRequests.js");
const slips = await import("../../../server/services/billing/depositReceiptPdf.js");
const reports = await import("../../../server/services/billing/reports.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");

const tag = newTag();
let ids;
let ritesh;
let mother;

const receptionAdmin = {
  actorId: USERS.reception_admin.id,
  ip: "10.9.61.2",
  role: USERS.reception_admin.role,
};
const balanceOf = async (patientId) => (await deposits.getDeposit(patientId, db)).balance;
const consentFor = async (patientId) =>
  (
    await one(
      `INSERT INTO documents (patient_id, doc_type, title, file_name, storage_path, mime_type, source)
       VALUES ($1, 'deposit_consent', 'Deposit transfer consent', 'consent.jpg',
               'billing/deposit-consents/test.jpg', 'image/jpeg', 'billing_counter')
       RETURNING id`,
      [patientId],
    )
  ).id;

test.describe.serial("D03 deposits: move to a patient, to IPD, pay back with approval", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await openDeskShift(5000);
    ritesh = (await extraVisit(ids, "Ritesh", { healthray: false })).patient;
    mother = (await extraVisit(ids, "Mother", { healthray: false })).patient;
    await deposits.receiveDeposit(ritesh, { mode: "cash", amount: 2000 }, desk, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. a move to another patient needs the depositor's consent, a relationship and enough money", async () => {
    const consent = await consentFor(ritesh);
    const base = {
      to_patient_id: mother,
      amount: 500,
      relationship: "mother",
      reason: "Her visit",
    };
    await expect(
      deposits.transferToPatient(
        ritesh,
        { ...base, consent_document_id: null },
        receptionAdmin,
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const otherConsent = await consentFor(mother);
    await expect(
      deposits.transferToPatient(
        ritesh,
        { ...base, consent_document_id: otherConsent },
        receptionAdmin,
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      deposits.transferToPatient(
        ritesh,
        { ...base, to_patient_id: ritesh, consent_document_id: consent },
        receptionAdmin,
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      deposits.transferToPatient(
        ritesh,
        { ...base, amount: 5000, consent_document_id: consent },
        receptionAdmin,
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await balanceOf(ritesh)).toBe(200000);
  });

  test("2. the move writes a linked pair with one slip, and both balances change", async () => {
    const consent = await consentFor(ritesh);
    const moved = await deposits.transferToPatient(
      ritesh,
      {
        to_patient_id: mother,
        amount: 500,
        relationship: "mother",
        reason: "Her consultation",
        consent_document_id: consent,
      },
      receptionAdmin,
      db,
    );
    expect(moved.slip_no).toMatch(/^DEP-\d{6}$/);
    expect(moved.from.balance).toBe(150000);
    expect(moved.to.balance).toBe(50000);
    const pair = await query(
      `SELECT kind, amount, slip_no, counter_entry_id, other_patient_id FROM deposit_entries
        WHERE slip_no = $1 ORDER BY kind`,
      [moved.slip_no],
    );
    expect(pair.rows.map((row) => row.kind)).toEqual(["transfer_in", "transfer_out"]);
    expect(pair.rows[0].counter_entry_id).toBeTruthy();
    const html = slips.buildDepositSlipHtml(await slips.depositSlipView(moved.entry_id, db));
    expect(html).toContain("DEPOSIT TRANSFER SLIP");
    expect(html).toContain(moved.slip_no);
    expect(html).toContain("Depositor");
  });

  test("3. a billing desk cannot move a deposit through the API; reception admin can", async () => {
    const reception = await apiAs("reception");
    const response = await reception.post(`/api/billing/patients/${ritesh}/deposit/ipd`, {
      data: { amount: 100, ipd_number: "IP-1", reason: "Admitted" },
    });
    await reception.dispose();
    expect(response.status()).toBe(403);
  });

  test("4. a move to IPD needs the IP number and prints a slip for the IPD desk", async () => {
    await expect(
      deposits.transferToIpd(
        ritesh,
        { amount: 100, ipd_number: " ", reason: "Admitted" },
        receptionAdmin,
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const moved = await deposits.transferToIpd(
      ritesh,
      { amount: 300, ipd_number: `IP-${tag}`, reason: "Admitted under Dr Katyal" },
      receptionAdmin,
      db,
    );
    expect(moved.balance).toBe(120000);
    const html = slips.buildDepositSlipHtml(await slips.depositSlipView(moved.entry_id, db));
    expect(html).toContain("DEPOSIT TRANSFER TO IPD");
    expect(html).toContain(`IP-${tag}`);
  });

  test("5. a refund request holds the money; the same person cannot approve it", async () => {
    const asked = await deposits.requestRefund(
      ritesh,
      { amount: 1000, mode: "cash", reason: "Going back home" },
      receptionAdmin,
      db,
    );
    const account = await deposits.getDeposit(ritesh, db);
    expect(account).toMatchObject({ balance: 120000, held: 100000, available: 20000 });
    await expect(
      deposits.transferToIpd(
        ritesh,
        { amount: 500, ipd_number: "IP-2", reason: "x" },
        receptionAdmin,
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      deposits.requestRefund(
        ritesh,
        { amount: 100, mode: "cash", reason: "again" },
        receptionAdmin,
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      requests.approveRequest(asked.request_id, {}, receptionAdmin, db),
    ).rejects.toMatchObject({ status: 409 });
    const approved = await requests.approveRequest(asked.request_id, {}, admin, db);
    expect(approved.deposit_refund).toMatchObject({ amount: 100000, approved_mode: "cash" });
    expect((await deposits.getDeposit(ritesh, db)).held).toBe(100000);
  });

  test("6. paying it out takes the cash from the drawer, closes the request and prints a receipt", async () => {
    const open = (await deposits.getDeposit(ritesh, db)).open_refund;
    const before = (await shifts.currentShift(desk, db)).expected_cash;
    const paid = await deposits.payOutRefund(open.id, {}, desk, db);
    expect(paid).toMatchObject({ amount: 100000, mode: "cash", balance: 20000 });
    expect((await shifts.currentShift(desk, db)).expected_cash).toBe(before - 1000);
    const account = await deposits.getDeposit(ritesh, db);
    expect(account).toMatchObject({ held: 0, available: 20000, open_refund: null });
    await expect(deposits.payOutRefund(open.id, {}, desk, db)).rejects.toMatchObject({
      status: 409,
    });
    const html = slips.buildDepositSlipHtml(await slips.depositSlipView(paid.entry_id, db));
    expect(html).toContain("DEPOSIT REFUND RECEIPT");
  });

  test("7. a rejected refund releases the hold", async () => {
    const asked = await deposits.requestRefund(
      mother,
      { amount: 200, mode: "upi", reason: "Changed mind" },
      desk,
      db,
    );
    expect((await deposits.getDeposit(mother, db)).available).toBe(30000);
    await requests.rejectRequest(asked.request_id, { note: "Use it on her next visit" }, admin, db);
    expect((await deposits.getDeposit(mother, db)).available).toBe(50000);
  });

  test("8. the Refunds board lists deposit refunds alongside bill refunds", async () => {
    await deposits.requestRefund(mother, { amount: 100, mode: "cash", reason: "Board" }, desk, db);
    const { refundBoard } = await import("../../../server/services/billing/refundBoard.js");
    const board = await refundBoard({ q: `Mother ${tag}` }, db);
    const row = board.groups.waiting.find((entry) => entry.kind === "deposit_refund");
    expect(row).toMatchObject({ patient: { id: mother }, amounts: { credited: 10000 } });
  });

  test("9. the Deposits report reconciles and lists the IPD move", async () => {
    const today = (await one(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).d;
    const result = await reports.runReport("deposits", { from: today, to: today }, db);
    const held = result.sections.find((part) => part.key === "held").rows[0];
    const days = result.sections.find((part) => part.key === "days").total;
    expect(held.closing - held.opening).toBe(days.net);
    expect(days.moved_out).toBe(days.moved_in);
    const ipd = result.sections.find((part) => part.key === "ipd").rows;
    expect(ipd.find((row) => row.ipd_number === `IP-${tag}`)).toMatchObject({ amount: 30000 });
  });

  test("10. a chart merge refuses a patient with deposit history instead of failing half-way", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await expect(deposits.refuseMergeWithDeposit(client, ritesh, "Ritesh")).rejects.toThrow(
        /deposit history/,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
