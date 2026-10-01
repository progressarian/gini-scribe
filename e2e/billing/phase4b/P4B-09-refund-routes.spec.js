import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { anonymousApi, apiAs } from "../../helpers/auth.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import {
  billRow,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  openDeskShift,
  prepareCategory,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const tag = newTag();
let ids;

async function call(role, method, url, data) {
  const api = role ? await apiAs(role) : await anonymousApi();
  const response = await api[method](url, data === undefined ? undefined : { data });
  const text = await response.text();
  await api.dispose();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status(), body };
}

const ask = (billId, extra = {}, role = "reception") =>
  call(role, "post", "/api/billing/requests/refund", {
    bill_id: billId,
    reason_code: "long_wait",
    ...extra,
  });

const preview = (billId, extra = {}, role = "reception") =>
  call(role, "post", "/api/billing/refunds/preview", { bill_id: billId, ...extra });

const approve = (id, data = {}, role = "reception_admin") =>
  call(role, "post", `/api/billing/master/requests/${id}/approve`, data);

const reject = (id, data = {}, role = "reception_admin") =>
  call(role, "post", `/api/billing/master/requests/${id}/reject`, data);

const payOut = (noteId, data, role = "reception") =>
  call(role, "post", `/api/billing/credit-notes/${noteId}/pay-out`, data);

const seriesNext = () =>
  one(
    `SELECT COALESCE(MAX(next_no), 0)::int AS n FROM bill_series WHERE series = 'CN' AND fy = $1`,
    [ids.fy],
  );

test.describe.serial("P4B-09 refund schemas and routes", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    await dropShifts();
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. reception asks but can't approve; reception_admin and admin approve; strangers are refused", async () => {
    await openDeskShift(0);
    const { bill: first } = await finalBill(ids, "RouteRoles", [{ item: ids.brace }], {
      pay: inCash,
    });
    const { bill: second } = await finalBill(ids, "RouteRoles2", [{ item: ids.brace }], {
      pay: inCash,
    });
    expect([401, 403]).toContain((await ask(first.id, {}, null)).status);
    expect((await ask(first.id, { whole_bill: true }, "lab")).status).toBe(403);
    const asked = await ask(first.id, { whole_bill: true });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body).toMatchObject({ kind: "refund", status: "pending", bill_id: first.id });
    expect((await approve(asked.body.id, {}, "reception")).status).toBe(403);
    expect((await reject(asked.body.id, { note: "no" }, "reception")).status).toBe(403);
    const byAdmin = await approve(asked.body.id, {}, "reception_admin");
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
    expect(byAdmin.body.credit_note.bill_no).toMatch(/^C4/);

    const again = await ask(second.id, { whole_bill: true, note: "Waited 3 hours" });
    expect(again.status).toBe(201);
    const byOwner = await approve(again.body.id, {}, "admin");
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.status).toBe("approved");
  });

  test("2. the schema refuses both choices, neither, a price and a bad quantity", async () => {
    const { bill } = await finalBill(ids, "RouteSchema", [{ item: ids.dressing, quantity: 2 }], {
      pay: inCash,
    });
    const line = lineFor(bill, ids.dressing);
    ids.schemaBill = bill;
    const cases = [
      [{ whole_bill: true, lines: [{ line_id: line.id }] }, /not both/],
      [{}, /not both/],
      [{ whole_bill: true, amount: 100 }, /can't be sent from the billing desk/],
      [{ lines: [{ line_id: line.id, quantity: -1 }] }, /Quantity|more than 0|number/],
      [{ lines: [{ line_id: line.id, quantity: 0.123 }] }, /2 decimals|number/],
      [{ lines: [] }, /list is empty/],
      [{ whole_bill: true, requested_mode: "cheque" }, /must be one of/],
    ];
    for (const [extra, message] of cases) {
      const answer = await ask(bill.id, extra);
      expect(answer.status, JSON.stringify(extra)).toBe(400);
      expect(answer.body.error, JSON.stringify(extra)).toMatch(message);
    }
    expect(
      (await preview(bill.id, { whole_bill: true, lines: [{ line_id: line.id }] })).status,
    ).toBe(400);
    expect(
      (await call("reception", "get", `/api/billing/bills/not-a-bill/creditable`)).status,
    ).toBe(400);
  });

  test("3. the preview writes nothing and matches what the approved credit note pays back, part of a line", async () => {
    const bill = ids.schemaBill;
    const line = lineFor(bill, ids.dressing);
    const creditable = await call("reception", "get", `/api/billing/bills/${bill.id}/creditable`);
    expect(creditable.status).toBe(200);
    expect(creditable.body.lines).toMatchObject([{ line_id: line.id, quantity: 2, left: 2 }]);

    const before = await seriesNext();
    const looked = await preview(bill.id, { lines: [{ line_id: line.id, quantity: 1 }] });
    expect(looked.status, JSON.stringify(looked.body)).toBe(200);
    expect(looked.body.refund).toMatchObject({ mode: "as_paid", against_balance: 0 });
    expect(looked.body.refund.due).toBe(line.patient_payable / 2);
    expect(looked.body.refund.legs).toEqual([{ mode: "cash", amount: looked.body.refund.due }]);
    expect((await seriesNext()).n).toBe(before.n);
    expect(
      (await one(`SELECT count(*)::int AS n FROM bills WHERE original_bill_id = $1`, [bill.id])).n,
    ).toBe(0);

    const asked = await ask(bill.id, {
      lines: [{ line_id: line.id, quantity: 1 }],
      reason_code: "patient_declined",
    });
    expect(asked.status).toBe(201);
    const read = await call("reception", "get", `/api/billing/refund-requests/${asked.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.refund.preview.refund.due).toBe(looked.body.refund.due);
    const approved = await approve(asked.body.id, {});
    expect(approved.status).toBe(200);
    expect(approved.body.credit_note.refund.due).toBe(looked.body.refund.due);
    expect(approved.body.credit_note.totals.payable).toBe(looked.body.totals.payable);
    const left = await call("reception", "get", `/api/billing/bills/${bill.id}/creditable`);
    expect(left.body.lines[0]).toMatchObject({ left: 1, credited_quantity: 1 });
    ids.partNote = approved.body.credit_note;
  });

  test("4. an admin's other mode needs a reason; a rejection needs a note; both are listed on the bill", async () => {
    const { bill } = await finalBill(
      ids,
      "RouteMode",
      [{ item: ids.brace }, { item: ids.dressing }],
      {
        pay: inCash,
      },
    );
    const asked = await ask(bill.id, { lines: [{ line_id: lineFor(bill, ids.brace).id }] });
    const inbox = await call(
      "reception_admin",
      "get",
      "/api/billing/master/requests?kind=refund&status=pending",
    );
    const listed = inbox.body.find((r) => r.id === asked.body.id);
    expect(listed.refund.preview.lines[0].bill_name).toBe(`Ankle brace ${tag}`);
    expect(listed.refund.reason_label).toBe("Long waiting time");

    const noReason = await approve(asked.body.id, { approved_mode: "upi" });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toMatch(/another way/);
    const badMode = await approve(asked.body.id, { approved_mode: "cheque", mode_reason: "x" });
    expect(badMode.status).toBe(400);
    const approved = await approve(asked.body.id, {
      approved_mode: "upi",
      mode_reason: "Drawer is short",
    });
    expect(approved.status).toBe(200);
    expect(approved.body.refund).toMatchObject({
      approved_mode: "upi",
      mode_reason: "Drawer is short",
    });
    const note = approved.body.credit_note;
    const read = await call("reception", "get", `/api/billing/credit-notes/${note.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      id: note.id,
      bill_no: note.bill_no,
      original: { id: bill.id },
    });
    expect(read.body.refund.legs).toEqual([{ mode: "upi", amount: note.refund.due }]);
    expect((await call("reception", "get", `/api/billing/credit-notes/${bill.id}`)).status).toBe(
      409,
    );

    const second = await ask(bill.id, { lines: [{ line_id: lineFor(bill, ids.dressing).id }] });
    expect((await reject(second.body.id, {})).status).toBe(400);
    const rejected = await reject(second.body.id, { note: "The dressing was done" });
    expect(rejected.status).toBe(200);
    const refunds = await call("reception", "get", `/api/billing/bills/${bill.id}/refunds`);
    expect(refunds.status).toBe(200);
    expect(refunds.body.requests.map((r) => r.status)).toEqual(["rejected", "approved"]);
    expect(refunds.body.requests[0].decision_note).toBe("The dressing was done");
    expect(refunds.body.credit_notes.map((n) => n.id)).toEqual([note.id]);
    ids.upiNote = read.body;
  });

  test("5. pay-out: card needs its reference, cash needs an open shift, never more than is due", async () => {
    const note = ids.upiNote;
    const upi = (amount, reference) => ({
      version: note.version,
      payments: [{ mode: "upi", amount, ...(reference ? { reference } : {}) }],
    });
    const noRef = await payOut(note.id, upi(note.refund.due / 100));
    expect(noRef.status).toBe(400);
    expect(noRef.body.error).toMatch(/reference/);
    const cash = await payOut(note.id, {
      version: note.version,
      payments: [{ mode: "cash", amount: 1 }],
    });
    expect(cash.status).toBe(409);
    expect(cash.body.error).toMatch(/by UPI/);
    const tooMuch = await payOut(note.id, upi(note.refund.due / 100 + 1, `REV-${tag}`));
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatch(/is due back/);
    const paid = await payOut(note.id, upi(note.refund.due / 100, `REV-${tag}`));
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.totals).toMatchObject({ due: 0, refunded: note.refund.due });
    expect(paid.body.payments[0]).toMatchObject({ direction: "out", reference: `REV-${tag}` });
    const again = await payOut(note.id, upi(1, `REV2-${tag}`));
    expect(again.status).toBe(409);

    await dropShifts();
    const partNote = ids.partNote;
    const noShift = await payOut(partNote.id, {
      version: partNote.version,
      payments: [{ mode: "cash", amount: partNote.refund.due / 100 }],
    });
    expect(noShift.status).toBe(409);
    expect(noShift.body.error).toMatch(/Open your shift first/);
    const shift = await openDeskShift(5000);
    const outOfShift = await payOut(partNote.id, {
      version: partNote.version,
      payments: [{ mode: "cash", amount: partNote.refund.due / 100 }],
    });
    expect(outOfShift.status, JSON.stringify(outOfShift.body)).toBe(201);
    expect(outOfShift.body.payments[0]).toMatchObject({ mode: "cash", shift_id: shift.id });
    await dropShifts();
  });

  test("6. a pay-later bill's credit reduces the balance first, and never more is paid back than was paid", async () => {
    await openDeskShift(1000);
    const { bill } = await finalBill(
      ids,
      "RouteLater",
      [{ item: ids.brace }, { item: ids.dressing }],
      { pay: [{ mode: "cash", amount: 300 }], payLater: true },
    );
    expect((await billRow(bill.id)).paid_amount).toBe("300.00");
    const looked = await preview(bill.id, { whole_bill: true });
    expect(looked.status).toBe(200);
    expect(looked.body.totals.payable).toBe(130000);
    expect(looked.body.refund).toMatchObject({ due: 30000, against_balance: 100000 });
    const asked = await ask(bill.id, { whole_bill: true, reason_code: "billed_by_mistake" });
    const approved = await approve(asked.body.id);
    expect(approved.body.credit_note.refund.due).toBe(30000);
    const note = approved.body.credit_note;
    const over = await payOut(note.id, {
      version: note.version,
      payments: [{ mode: "cash", amount: 301 }],
    });
    expect(over.status).toBe(409);
    const paid = await payOut(note.id, {
      version: note.version,
      payments: [{ mode: "cash", amount: 300 }],
    });
    expect(paid.status).toBe(201);
    const bills = await call("reception", "get", `/api/billing/bills/${bill.id}`);
    expect(bills.body.credits).toMatchObject({ credited: 130000, refunded: 30000, balance: 0 });
    await dropShifts();
  });
});
