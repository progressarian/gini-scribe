import { getPool, one, query } from "../../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import {
  desk,
  discountCode,
  extraVisit,
  payRule,
  setUp,
  tearDown,
} from "../phase4/p4-bills-fixture.mjs";

const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const requests = await import("../../../server/services/billing/billingRequests.js");

export const db = getPool();

export const mine = { actorId: USERS.reception_admin.id, ip: "10.9.5.1", role: "reception_admin" };
export const admin = { actorId: USERS.admin.id, ip: "10.9.5.9", role: USERS.admin.role };

const DAY_MS = 86400000;
const EPOCH = Date.parse("2012-01-01T00:00:00Z");

export const privateDay = (tag, offset = 0) =>
  new Date(EPOCH + ((parseInt(tag, 16) % 3000) + offset) * DAY_MS).toISOString().slice(0, 10);

export const paiseOf = (value) => Math.round(Number(value) * 100);

const closeMyShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = 0, counted_cash = 0, difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [mine.actorId],
  );

async function draft(ids, label, lines, category, doctorId) {
  const { visit } = await extraVisit(ids, label, doctorId ? { doctorId } : {});
  const opened = await bills.openDraft(visit, mine, db);
  for (const line of lines) {
    const added = await bills.addLine(opened.id, { item_id: line.item }, mine, db);
    if (line.quantity && line.quantity !== 1) {
      const saved = added.lines.find((l) => l.service_item_id === line.item);
      await bills.changeQuantity(opened.id, saved.id, { quantity: line.quantity }, mine, db);
    }
  }
  await bills.setCategory(opened.id, { category }, mine, db);
  for (const code of lines.codes ?? []) await bills.addCode(opened.id, { code }, mine, db);
  return { visit, bill: await bills.readBill(opened.id, db) };
}

async function billed(
  ids,
  label,
  lines,
  { category = ids.pensioner, pay, payLater = false, doctorId } = {},
) {
  const { visit, bill } = await draft(ids, label, lines, category, doctorId);
  let version = bill.version;
  const taking = pay ? pay(bill) : [];
  if (taking.length) {
    version = (await payments.takePayments(bill.id, { version, payments: taking }, mine, db))
      .version;
  }
  const final = await bills.finaliseBill(bill.id, { version, pay_later: payLater }, mine, db);
  return { visit, bill: final };
}

const full = (mode, reference) => (bill) => [
  { mode, amount: bill.totals.payable / 100, ...(reference ? { reference } : {}) },
];

const withCodes = (lines, codes) => Object.assign(lines, { codes });

export const SEED_WAIT_MS = 240000;

async function setUpWhenFree(tag) {
  const deadline = Date.now() + SEED_WAIT_MS;
  for (;;) {
    try {
      return await setUp(tag);
    } catch (error) {
      if (!/still holds the test consultation items/.test(error.message)) throw error;
      if (Date.now() > deadline) throw error;
    }
  }
}

export async function seedReports(tag) {
  const ids = await setUpWhenFree(tag);
  ids.privateDay = privateDay(tag);
  await query(`UPDATE patient_schemes SET allow_pay_later = TRUE WHERE code = $1`, [ids.pensioner]);
  await payRule(ids, ids.pensioner, { name: "pensioner pays", patient_pays: "full" });
  await payRule(ids, ids.paid, {
    name: "paid pays a part",
    patient_pays: "amount",
    patient_value: 300,
  });
  ids.code = `P5C${tag.toUpperCase()}`;
  ids.codeRule = await discountCode(ids, ids.code, {
    value: 10,
    max_uses_per_day: 5,
    max_uses_per_doctor_per_day: 3,
  });
  ids.autoRule = await discountCode(ids, null, {
    name: `P4 auto ${tag}`,
    method: "auto",
    kind: "percent",
    value: 4.5,
    service_item_ids: [ids.dressing],
  });
  await closeMyShifts();
  ids.shift = (await shifts.openShift({ opening_cash: 0 }, mine, db)).id;

  const cashA = await billed(
    ids,
    "RepA",
    [{ item: ids.consultDoctorNew }, { item: ids.dressing, quantity: 2 }],
    { pay: full("cash") },
  );
  const codeB = await billed(
    ids,
    "RepB",
    withCodes([{ item: ids.brace }, { item: ids.dressing }], [ids.code]),
    { pay: full("card", `CARD-${tag}-B`) },
  );
  const claimC = await billed(ids, "RepC", [{ item: ids.consultNew }], {
    category: ids.paid,
    doctorId: CONSULTANTS.rahul.id,
    pay: full("upi", `UPI-${tag}-C`),
  });
  const creditD = await billed(
    ids,
    "RepD",
    withCodes([{ item: ids.brace }, { item: ids.dressing }], [ids.code]),
    { pay: full("card", `CARD-${tag}-D`) },
  );
  const cancelE = await billed(ids, "RepE", [{ item: ids.dressing }], { payLater: true });
  const dueF = await billed(ids, "RepF", [{ item: ids.brace }, { item: ids.dressing }], {
    payLater: true,
  });
  await payments.takePayments(
    dueF.bill.id,
    { version: dueF.bill.version, payments: [{ mode: "cash", amount: 300 }] },
    mine,
    db,
  );

  const brace = creditD.bill.lines.find((line) => line.service_item_id === ids.brace);
  const refund = await requests.createRefundRequest(
    { bill_id: creditD.bill.id, lines: [{ line_id: brace.id }], reason: "Brace not needed" },
    desk,
    db,
  );
  const approved = await requests.approveRequest(refund.id, {}, admin, db);
  const note = approved.credit_note;
  await payments.payOut(
    note.id,
    {
      version: note.version,
      payments: [{ mode: "card", amount: note.refund.due / 100, reference: `REV-${tag}` }],
    },
    mine,
    db,
  );

  const cancelled = await bills.readBill(cancelE.bill.id, db);
  await bills.cancelBill(
    cancelled.id,
    { version: cancelled.version, reason: "Billed the wrong patient" },
    mine,
    db,
  );

  const asked = [];
  for (const name of ["Knee cap", "Foot scan"]) {
    asked.push(
      await requests.createNewItemRequest(
        {
          proposed_name: `P5 ${name} ${tag}`,
          reason: "Doctor asked for it",
          visit_id: cashA.visit,
        },
        mine,
        db,
      ),
    );
  }
  await requests.rejectRequest(asked[0].id, { note: "Use the existing item" }, admin, db);

  ids.bills = {
    cash: cashA.bill.id,
    code: codeB.bill.id,
    claim: claimC.bill.id,
    credited: creditD.bill.id,
    cancelled: cancelE.bill.id,
    due: dueF.bill.id,
  };
  ids.note = note.id;
  ids.requests = [...asked.map((r) => r.id), refund.id];
  ids.visits = [cashA, codeB, claimC, creditD, cancelE, dueF].map((b) => b.visit);
  ids.allBills = [...Object.values(ids.bills), ids.note];
  await backdate(ids, ids.privateDay);
  return ids;
}

export async function backdate(ids, day, billIds = ids.allBills) {
  const at = (time) => `(($1::date + time '${time}') AT TIME ZONE 'Asia/Kolkata')`;
  await query(`UPDATE bills SET bill_date = $1::date WHERE id = ANY($2::uuid[])`, [day, billIds]);
  await query(`UPDATE payments SET received_at = ${at("11:15")} WHERE bill_id = ANY($2::uuid[])`, [
    day,
    billIds,
  ]);
  await query(
    `UPDATE bills SET cancelled_at = ${at("12:30")}
      WHERE id = ANY($2::uuid[]) AND status = 'cancelled'`,
    [day, billIds],
  );
  await query(
    `UPDATE billing_requests SET requested_at = ${at("10:05")}
      WHERE id = ANY($2::uuid[]) OR bill_id = ANY($3::uuid[])`,
    [day, ids.requests ?? [], billIds],
  );
}

export async function unseed(ids) {
  if (!ids?.tag) return;
  try {
    if (ids.requests?.length) {
      await query(`DELETE FROM billing_requests WHERE id = ANY($1::uuid[])`, [ids.requests]);
    }
    await query(`DELETE FROM service_items WHERE name LIKE $1`, [`P5 % ${ids.tag}`]);
    const settled = await query(
      `SELECT DISTINCT settlement_id FROM claim_settlement_bills WHERE bill_id = ANY($1::uuid[])`,
      [ids.allBills ?? []],
    ).catch(() => ({ rows: [] }));
    const settlements = settled.rows.map((row) => row.settlement_id);
    if (settlements.length) {
      await query(
        `UPDATE bills SET claim_status = 'pending', claim_settlement_id = NULL
          WHERE claim_settlement_id = ANY($1::uuid[])`,
        [settlements],
      );
      await query(`DELETE FROM claim_settlement_bills WHERE settlement_id = ANY($1::uuid[])`, [
        settlements,
      ]);
      await query(`DELETE FROM claim_settlements WHERE id = ANY($1::uuid[])`, [settlements]);
    }
  } finally {
    await tearDown(ids);
    await closeMyShifts();
    await query(
      `DELETE FROM cash_shifts s WHERE s.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.shift_id = s.id)`,
      [mine.actorId],
    ).catch(() => {});
  }
}

export const linesOfMine = (ids) =>
  query(
    `SELECT b.id AS bill_id, b.bill_type, b.status, l.*
       FROM bills b JOIN bill_lines l ON l.bill_id = b.id
      WHERE b.id = ANY($1::uuid[])`,
    [ids.allBills],
  ).then((r) => r.rows);

export const billRowsOfMine = (ids) =>
  query(`SELECT * FROM bills WHERE id = ANY($1::uuid[])`, [ids.allBills]).then((r) => r.rows);

export const paymentsOfMine = (ids) =>
  query(`SELECT * FROM payments WHERE bill_id = ANY($1::uuid[])`, [ids.allBills]).then(
    (r) => r.rows,
  );

export const oneRow = one;
