import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { UNDRAWN_SAMPLE_STATUSES } from "../../../shared/labStages.js";
import { AS_PAID, REFUND_MODES } from "../../../shared/billingVocab.js";
import { writeAudit } from "./audit.js";
import { nextNumber, seriesFor } from "./billNumber.js";
import { indiaToday } from "./categoryResolver.js";
import { auditFields, lockRow, readNumber } from "./common.js";
import { ISSUED_GST_COLUMNS, issuedGstReady } from "./issuedGst.js";
import { moneyOn, refundLegs, refundPlan, releaseTestOrders } from "./payments.js";
import { httpError } from "./transaction.js";

const BILL_COLUMNS = `id, bill_no, series, fy, bill_type, original_bill_id, patient_id, visit_id,
  appointment_id, bill_date::text AS bill_date, status, scheme_code, scheme_label, payer_name,
  patient_age, actual_amount, discount_amount, tax_amount, patient_payable, claim_amount,
  adjustment_amount, round_off, paid_amount, claim_status, version, finalised_by, finalised_at,
  created_at`;

const SPEC = { table: "bills", noun: "bill", columns: BILL_COLUMNS };

const COPIED = [
  "service_item_id",
  "source",
  "lab_order_id",
  "doctor_id",
  "group_code",
  "subgroup_code",
  "item_code",
  "bill_code",
  "bill_name",
  "base_rate",
  "rate",
  "tax_code",
  "sac_hsn",
  "tax_rate_pct",
  "payment_rule_id",
  "payment_rule",
];

const PARTS = [
  "actual_amount",
  "discount",
  "listed_discount",
  "payable_discount",
  "bill_discount",
  "taxable",
  "cgst",
  "sgst",
  "patient_payable",
  "claim_amount",
  "adjustment_amount",
];

const CREDITED = ["quantity", ...PARTS];

const LINES_SQL = `
  SELECT l.id, l.line_no, l.is_live, l.quantity, ${[...COPIED, ...PARTS].map((key) => `l.${key}`).join(", ")},
         o.id AS order_id, o.sample_status,
         ${CREDITED.map((key) => `c.${key} AS credited_${key}`).join(", ")}
    FROM bill_lines l
    LEFT JOIN giniflow_lab_orders o ON o.id = l.lab_order_id
    LEFT JOIN LATERAL (
      SELECT ${CREDITED.map((key) => `COALESCE(SUM(x.${key}), 0) AS ${key}`).join(", ")}
        FROM bill_lines x WHERE x.credited_line_id = l.id
    ) c ON TRUE
   WHERE l.bill_id = $1
   ORDER BY l.line_no, l.id`;

const NOTE_LINE_COLUMNS = `id, line_no, credited_line_id, service_item_id, source, lab_order_id,
  item_code, bill_code, bill_name, quantity, rate, actual_amount, discount, taxable, cgst, sgst,
  tax_code, sac_hsn, tax_rate_pct, payment_rule, patient_payable, claim_amount, adjustment_amount`;

export const REFUND_LINES_MAX = 100;
const QUANTITY_MAX = 999999.99;
const ROUND_OFF = { min: -49, max: 50 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rupees = (amount) => (amount / 100).toFixed(2);
const hundredths = (quantity) => Math.round(Number(quantity) * 100);
const quantityText = (value) => String(value / 100);

const billLabel = (bill) => (bill?.bill_no ? `bill ${bill.bill_no}` : "this visit's draft bill");

function cleanUuid(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text.toLowerCase();
}

export function cleanRefundMode(value) {
  if (value === undefined || value === null || value === "") return AS_PAID;
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!REFUND_MODES.includes(mode)) {
    throw httpError(400, `Money can go back only as one of: ${REFUND_MODES.join(", ")}`);
  }
  return mode;
}

function cleanQuantity(value) {
  const message = "The quantity to refund must be a number";
  const quantity = readNumber(value, message);
  if (quantity === undefined) return null;
  if (quantity <= 0 || quantity > QUANTITY_MAX) {
    throw httpError(400, `The quantity to refund must be more than 0 and at most ${QUANTITY_MAX}`);
  }
  if (Number(quantity.toFixed(2)) !== quantity) {
    throw httpError(400, "The quantity to refund can have at most 2 decimals");
  }
  return quantity;
}

export function cleanRefundLines(value) {
  if (!Array.isArray(value) || !value.length) {
    throw httpError(400, "Choose the lines to refund, or the whole bill");
  }
  if (value.length > REFUND_LINES_MAX) {
    throw httpError(400, `At most ${REFUND_LINES_MAX} lines can be refunded at once`);
  }
  const seen = new Set();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw httpError(400, "Each line to refund needs the line and the quantity");
    }
    const lineId = cleanUuid(entry.line_id, "line");
    if (seen.has(lineId)) {
      throw httpError(
        400,
        "A line can be asked for only once — put all of its quantity on one row",
        {
          line_id: lineId,
        },
      );
    }
    seen.add(lineId);
    return { line_id: lineId, quantity: cleanQuantity(entry.quantity) };
  });
}

function share(total, part, whole) {
  if (part === whole) return total;
  return Number((BigInt(total) * BigInt(part) * 2n + BigInt(whole)) / (BigInt(whole) * 2n));
}

const amountsOf = (row, prefix) =>
  Object.fromEntries(PARTS.map((key) => [key, paise(row[`${prefix}${key}`])]));

function lineOf(row) {
  return {
    row,
    id: row.id,
    line_no: row.line_no,
    name: row.bill_name,
    is_live: row.is_live,
    quantity: hundredths(row.quantity),
    credited_quantity: hundredths(row.credited_quantity),
    original: amountsOf(row, ""),
    credited: amountsOf(row, "credited_"),
    order: row.order_id
      ? { id: row.order_id, done: !UNDRAWN_SAMPLE_STATUSES.includes(row.sample_status) }
      : null,
  };
}

function assertCreditable(bill) {
  if (bill.bill_type !== "invoice") {
    throw httpError(409, "That is a credit note — only a bill can be refunded");
  }
  if (bill.status === "draft") {
    throw httpError(
      409,
      `${billLabel(bill)} is still a draft — remove the line instead of refunding it`,
    );
  }
  if (bill.status === "cancelled") {
    throw httpError(409, `${billLabel(bill)} was cancelled, so there is nothing to refund`);
  }
  return bill;
}

async function loadCredit(db, billId, { lock }) {
  const id = cleanUuid(billId, "bill");
  let bill;
  if (lock) {
    bill = await lockRow(db, SPEC, id);
  } else {
    const { rows } = await db.query(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1`, [id]);
    if (!rows.length) throw httpError(404, "That bill no longer exists");
    bill = rows[0];
  }
  assertCreditable(bill);
  const { rows } = await db.query(LINES_SQL, [bill.id]);
  const { rows: prior } = await db.query(
    `SELECT COALESCE(SUM(round_off), 0) AS round_off, COALESCE(SUM(claim_amount), 0) AS claim
       FROM bills WHERE original_bill_id = $1`,
    [bill.id],
  );
  return {
    bill,
    lines: rows.map(lineOf),
    priorRoundOff: paise(prior[0].round_off),
    priorClaim: paise(prior[0].claim),
  };
}

function creditPiece(line, quantity) {
  const whole = line.quantity;
  const after = line.credited_quantity + quantity;
  const o = line.original;
  const c = line.credited;
  const upTo = (key) => share(o[key], after, whole) - c[key];
  const offActual = (x) => x.discount - x.payable_discount - x.bill_discount;
  const listedOff = (x) => x.listed_discount - x.payable_discount;
  const piece = {
    payable_discount: upTo("payable_discount"),
    bill_discount: upTo("bill_discount"),
    cgst: upTo("cgst"),
    patient_payable: upTo("patient_payable"),
    claim_amount: upTo("claim_amount"),
    adjustment_amount: upTo("adjustment_amount"),
  };
  const off = share(offActual(o), after, whole) - offActual(c);
  const listed = share(listedOff(o), after, whole) - listedOff(c);
  piece.sgst = piece.cgst;
  piece.discount = off + piece.payable_discount + piece.bill_discount;
  piece.listed_discount = listed + piece.payable_discount;
  piece.taxable =
    piece.patient_payable +
    piece.claim_amount +
    piece.adjustment_amount +
    piece.payable_discount +
    piece.bill_discount -
    piece.cgst -
    piece.sgst;
  piece.actual_amount = off + piece.taxable;
  const fits =
    off >= 0 &&
    listed >= 0 &&
    PARTS.every((key) => piece[key] >= 0 && c[key] + piece[key] <= o[key]);
  if (!fits) {
    throw httpError(
      409,
      `${line.name} can't be credited ${quantityText(quantity)} at a time — credit what is left of it in one go`,
      { line_id: line.id },
    );
  }
  return { ...piece, listed_actual: share(paise(line.row.rate), quantity, 100) };
}

function chooseLine(bill, byId, entry) {
  const line = byId.get(entry.line_id);
  if (!line) {
    throw httpError(409, `That line isn't on ${billLabel(bill)}`, { line_id: entry.line_id });
  }
  const left = line.quantity - line.credited_quantity;
  if (left <= 0) {
    throw httpError(409, `${line.name} has already been credited in full`, { line_id: line.id });
  }
  const quantity = entry.quantity === null ? left : hundredths(entry.quantity);
  if (quantity > left) {
    throw httpError(409, `Only ${quantityText(left)} of ${line.name} is left to credit`, {
      line_id: line.id,
      left: left / 100,
    });
  }
  if (bill.claim_status === "cleared" && line.original.claim_amount > 0) {
    throw httpError(
      409,
      `${line.name}'s claim of ₹${rupees(line.original.claim_amount)} has already been paid by ${bill.payer_name ?? "the payer"}, so it can't be credited here — that money went to the payer, not the patient`,
      { code: "claim_cleared", line_id: line.id },
    );
  }
  return { line, quantity, piece: creditPiece(line, quantity), frees: quantity === left };
}

function planCredit(loaded, wanted) {
  const { bill, lines } = loaded;
  const byId = new Map(lines.map((line) => [line.id, line]));
  const chosen = wanted
    .map((entry) => chooseLine(bill, byId, entry))
    .sort((a, b) => a.line.line_no - b.line.line_no);
  const sum = (key) => chosen.reduce((total, entry) => total + entry.piece[key], 0);
  const taken = new Map(chosen.map((entry) => [entry.line.id, entry.quantity]));
  const creditsEverything = lines.every(
    (line) => line.credited_quantity + (taken.get(line.id) ?? 0) === line.quantity,
  );
  const linePayable = sum("patient_payable");
  const roundOff = creditsEverything
    ? Math.min(
        ROUND_OFF.max,
        Math.max(ROUND_OFF.min, -linePayable, paise(bill.round_off) - loaded.priorRoundOff),
      )
    : 0;
  return {
    lines: chosen,
    credits_everything: creditsEverything,
    totals: {
      actual: sum("actual_amount"),
      discount: sum("discount"),
      tax: sum("cgst") + sum("sgst"),
      payable: linePayable + roundOff,
      claim: sum("claim_amount"),
      adjustment: sum("adjustment_amount"),
      round_off: roundOff,
    },
  };
}

function wantedFrom(input, lines) {
  if (input?.whole_bill === true) {
    const open = lines.filter((line) => line.credited_quantity < line.quantity);
    if (!open.length) {
      throw httpError(409, "Everything on this bill has already been credited");
    }
    return open.map((line) => ({ line_id: line.id, quantity: null }));
  }
  return cleanRefundLines(input?.lines);
}

const shapePlanLine = (entry) => ({
  line_id: entry.line.id,
  line_no: entry.line.line_no,
  bill_name: entry.line.name,
  quantity: entry.quantity / 100,
  left_after: (entry.line.quantity - entry.line.credited_quantity - entry.quantity) / 100,
  frees_line: entry.frees,
  test: entry.line.order
    ? { lab_order_id: entry.line.order.id, done: entry.line.order.done }
    : null,
  actual: entry.piece.actual_amount,
  discount: entry.piece.discount,
  tax: entry.piece.cgst + entry.piece.sgst,
  patient_payable: entry.piece.patient_payable,
  claim: entry.piece.claim_amount,
  adjustment: entry.piece.adjustment_amount,
});

export async function checkRefund(client, billId, input) {
  const loaded = await loadCredit(client, billId, { lock: false });
  const plan = planCredit(loaded, wantedFrom(input, loaded.lines));
  return {
    bill: loaded.bill,
    plan,
    refund_lines: plan.lines.map((entry) => ({
      line_id: entry.line.id,
      quantity: entry.quantity / 100,
    })),
  };
}

export async function previewCredit(billId, input, db = pool) {
  const mode = cleanRefundMode(input?.mode);
  const { bill, plan, refund_lines: refundLines } = await checkRefund(db, billId, input);
  const money = await moneyOn(db, bill.id);
  const owedAfter = Math.max(0, money.payable - money.credited - plan.totals.payable);
  const due = Math.min(plan.totals.payable, Math.max(0, money.held - owedAfter));
  return {
    bill_id: bill.id,
    bill_no: bill.bill_no,
    refund_lines: refundLines,
    lines: plan.lines.map(shapePlanLine),
    totals: plan.totals,
    tests_done: plan.lines.filter((entry) => entry.line.order?.done).map((e) => e.line.name),
    refund: {
      due,
      against_balance: plan.totals.payable - due,
      mode,
      legs: await refundLegs(db, bill.id, mode, due),
    },
  };
}

export async function creditableLines(billId, db = pool) {
  const { bill, lines } = await loadCredit(db, billId, { lock: false });
  return {
    bill_id: bill.id,
    bill_no: bill.bill_no,
    claim_status: bill.claim_status,
    lines: lines.map((line) => ({
      line_id: line.id,
      line_no: line.line_no,
      bill_name: line.name,
      service_item_id: line.row.service_item_id,
      quantity: line.quantity / 100,
      credited_quantity: line.credited_quantity / 100,
      left: (line.quantity - line.credited_quantity) / 100,
      patient_payable: line.original.patient_payable,
      claim: line.original.claim_amount,
      credited_payable: line.credited.patient_payable,
      credited_claim: line.credited.claim_amount,
      claim_cleared: bill.claim_status === "cleared" && line.original.claim_amount > 0,
      test: line.order ? { lab_order_id: line.order.id, done: line.order.done } : null,
    })),
  };
}

const LINE_INSERT = [
  "bill_id",
  "visit_id",
  "line_no",
  "is_live",
  "credited_line_id",
  "quantity",
  "listed_actual",
  ...COPIED,
  ...PARTS,
  "created_by",
  "updated_by",
];

async function insertNoteLine(client, note, index, entry, ctx) {
  const values = {
    bill_id: note.id,
    visit_id: note.visit_id,
    line_no: index + 1,
    is_live: false,
    credited_line_id: entry.line.id,
    quantity: quantityText(entry.quantity),
    listed_actual: rupees(entry.piece.listed_actual),
    ...Object.fromEntries(COPIED.map((key) => [key, entry.line.row[key]])),
    ...Object.fromEntries(PARTS.map((key) => [key, rupees(entry.piece[key])])),
    created_by: ctx?.actorId ?? null,
    updated_by: ctx?.actorId ?? null,
  };
  const { rows } = await client.query(
    `INSERT INTO bill_lines (${LINE_INSERT.join(", ")})
     VALUES (${LINE_INSERT.map((_, i) => `$${i + 1}`).join(", ")})
     RETURNING ${NOTE_LINE_COLUMNS}`,
    LINE_INSERT.map((key) => values[key]),
  );
  return rows[0];
}

async function insertNote(client, bill, plan, number, day, ctx) {
  const snapshot = (await issuedGstReady(client)) ? ISSUED_GST_COLUMNS : [];
  const { rows } = await client.query(
    `INSERT INTO bills (bill_type, original_bill_id, patient_id, visit_id, appointment_id,
                        bill_date, status, scheme_code, scheme_label, payer_name, patient_age,
                        actual_amount, discount_amount, tax_amount, patient_payable, claim_amount,
                        adjustment_amount, round_off, bill_no, series, fy, finalised_by,
                        finalised_at, created_by, updated_by${snapshot.map((c) => `, ${c}`).join("")})
     SELECT 'credit_note', $1, $2, $3, $4, $5::date, 'final', $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, NOW(), $20, $20${snapshot.map((c) => `, o.${c}`).join("")}
       FROM bills o WHERE o.id = $1
     RETURNING ${BILL_COLUMNS}`,
    [
      bill.id,
      bill.patient_id,
      bill.visit_id,
      bill.appointment_id,
      day,
      bill.scheme_code,
      bill.scheme_label,
      bill.payer_name,
      bill.patient_age,
      rupees(plan.totals.actual),
      rupees(plan.totals.discount),
      rupees(plan.totals.tax),
      rupees(plan.totals.payable),
      rupees(plan.totals.claim),
      rupees(plan.totals.adjustment),
      rupees(plan.totals.round_off),
      number.number,
      number.series,
      number.fy,
      ctx?.actorId ?? null,
    ],
  );
  return rows[0];
}

async function ordersToRelease(client, bill, plan) {
  const candidates = [
    ...new Set(
      plan.lines
        .filter((entry) => entry.frees && entry.line.order && !entry.line.order.done)
        .map((entry) => entry.line.order.id),
    ),
  ];
  if (!candidates.length) return [];
  const { rows } = await client.query(
    `SELECT DISTINCT lab_order_id FROM bill_lines
      WHERE bill_id = $1 AND is_live AND lab_order_id = ANY($2::uuid[])`,
    [bill.id, candidates],
  );
  const stillBilled = new Set(rows.map((row) => row.lab_order_id));
  return candidates.filter((id) => !stillBilled.has(id));
}

function refuseDoneTests(plan, adminReason) {
  if (adminReason) return;
  const done = plan.lines.find((entry) => entry.line.order?.done);
  if (!done) return;
  throw httpError(
    409,
    `${done.line.name} has already been done, so it can be refunded only with the admin's reason — write it in the note`,
    { code: "test_done", line_id: done.line.id },
  );
}

export async function creditNoteIn(client, input, ctx) {
  if (typeof client?.release !== "function") {
    throw new Error("creditNoteIn needs the approving transaction's client, not the pool");
  }
  const adminReason = typeof input?.adminReason === "string" ? input.adminReason.trim() : "";
  const loaded = await loadCredit(client, input?.billId, { lock: true });
  const plan = planCredit(loaded, cleanRefundLines(input?.lines));
  refuseDoneTests(plan, adminReason);
  const bill = loaded.bill;
  const day = indiaToday();
  const number = await nextNumber(client, seriesFor("credit_note"), day, ctx);
  const note = await insertNote(client, bill, plan, number, day, ctx);
  const noteLines = [];
  for (const [index, entry] of plan.lines.entries()) {
    noteLines.push(await insertNoteLine(client, note, index, entry, ctx));
  }
  const freed = plan.lines.filter((entry) => entry.frees).map((entry) => entry.line.id);
  if (freed.length) {
    await client.query(
      `UPDATE bill_lines SET is_live = FALSE, updated_at = NOW(), updated_by = $2
        WHERE id = ANY($1::uuid[]) AND is_live`,
      [freed, ctx?.actorId ?? null],
    );
  }
  const claimGone =
    bill.claim_status === "pending" &&
    loaded.priorClaim + plan.totals.claim >= paise(bill.claim_amount);
  const { rows: updated } = await client.query(
    `UPDATE bills
        SET claim_status = CASE WHEN $2 THEN 'none' ELSE claim_status END,
            version = version + 1, updated_at = NOW(), updated_by = $3
      WHERE id = $1
      RETURNING ${BILL_COLUMNS}`,
    [bill.id, claimGone, ctx?.actorId ?? null],
  );
  const released = await releaseTestOrders(
    client,
    updated[0],
    ctx,
    await ordersToRelease(client, bill, plan),
  );
  await writeAudit(client, {
    entity: SPEC.table,
    entityId: note.id,
    action: "create",
    after: {
      ...note,
      lines: noteLines,
      request_id: input?.requestId ?? null,
      admin_reason: adminReason || null,
    },
    ...auditFields(ctx),
  });
  await writeAudit(client, {
    entity: SPEC.table,
    entityId: bill.id,
    action: "update",
    before: bill,
    after: {
      ...updated[0],
      credit_note_id: note.id,
      credit_note_no: note.bill_no,
      freed_lines: freed,
      released_orders: released.map((order) => order.lab_order_id),
    },
    ...auditFields(ctx),
  });
  return {
    credit_note_id: note.id,
    credit_note_no: note.bill_no,
    totals: plan.totals,
    freed_lines: freed,
    released,
  };
}

const shapeNoteLine = (row) => ({
  id: row.id,
  line_no: row.line_no,
  credited_line_id: row.credited_line_id,
  service_item_id: row.service_item_id,
  source: row.source,
  lab_order_id: row.lab_order_id,
  item_code: row.item_code,
  bill_code: row.bill_code,
  bill_name: row.bill_name,
  quantity: Number(row.quantity),
  rate: paise(row.rate),
  actual: paise(row.actual_amount),
  discount: paise(row.discount),
  taxable: paise(row.taxable),
  cgst: paise(row.cgst),
  sgst: paise(row.sgst),
  tax: paise(row.cgst) + paise(row.sgst),
  tax_code: row.tax_code,
  sac_hsn: row.sac_hsn,
  tax_rate_pct: row.tax_rate_pct === null ? null : Number(row.tax_rate_pct),
  payment_rule: row.payment_rule,
  patient_payable: paise(row.patient_payable),
  claim: paise(row.claim_amount),
  adjustment: paise(row.adjustment_amount),
});

async function shapeCreditNote(db, row) {
  const { rows: lines } = await db.query(
    `SELECT ${NOTE_LINE_COLUMNS} FROM bill_lines WHERE bill_id = $1 ORDER BY line_no, id`,
    [row.id],
  );
  const { rows: originals } = await db.query(
    `SELECT id, bill_no, bill_date::text AS bill_date FROM bills WHERE id = $1`,
    [row.original_bill_id],
  );
  const { rows: requests } = await db.query(
    `SELECT id, reason, requested_mode, approved_mode, mode_reason, decision_note
       FROM billing_requests WHERE credit_note_id = $1`,
    [row.id],
  );
  const plan = await refundPlan(row.id, db);
  const request = requests[0] ?? null;
  return {
    id: row.id,
    bill_no: row.bill_no,
    bill_type: row.bill_type,
    status: row.status,
    bill_date: row.bill_date,
    series: row.series,
    fy: row.fy,
    patient_id: row.patient_id,
    visit_id: row.visit_id,
    category: row.scheme_code,
    category_label: row.scheme_label,
    payer_name: row.payer_name,
    version: row.version,
    original: originals[0] ?? null,
    totals: {
      actual: paise(row.actual_amount),
      discount: paise(row.discount_amount),
      tax: paise(row.tax_amount),
      payable: paise(row.patient_payable),
      claim: paise(row.claim_amount),
      adjustment: paise(row.adjustment_amount),
      round_off: paise(row.round_off),
      refunded: paise(row.paid_amount),
    },
    refund: {
      request_id: request?.id ?? null,
      reason: request?.reason ?? null,
      requested_mode: request?.requested_mode ?? null,
      approved_mode: request?.approved_mode ?? null,
      mode_reason: request?.mode_reason ?? null,
      admin_note: request?.decision_note ?? null,
      due: plan.due,
      legs: plan.legs,
    },
    lines: lines.map(shapeNoteLine),
    finalised_at: row.finalised_at,
    created_at: row.created_at,
  };
}

export async function readCreditNote(creditNoteId, db = pool) {
  const id = cleanUuid(creditNoteId, "credit note");
  const { rows } = await db.query(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1`, [id]);
  if (!rows.length) throw httpError(404, "That credit note no longer exists");
  if (rows[0].bill_type !== "credit_note")
    throw httpError(409, "That is a bill, not a credit note");
  return shapeCreditNote(db, rows[0]);
}

export async function listCreditNotes(billId, db = pool) {
  const id = cleanUuid(billId, "bill");
  const { rows } = await db.query(
    `SELECT ${BILL_COLUMNS} FROM bills WHERE original_bill_id = $1 ORDER BY created_at, id`,
    [id],
  );
  const notes = [];
  for (const row of rows) notes.push(await shapeCreditNote(db, row));
  return notes;
}
