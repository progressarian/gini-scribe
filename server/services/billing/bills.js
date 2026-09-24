import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { decryptAadhaarFull, encryptAadhaar } from "../../utils/aadhaarCrypt.js";
import { writeAudit } from "./audit.js";
import { nextNumber, seriesFor } from "./billNumber.js";
import { getSettings } from "./billingSettings.js";
import {
  announceUsed,
  liveLineFor,
  repeatApprovalFor,
  useRepeatApproval,
} from "./billingRequests.js";
import { normalizeGender, resolveCategoryFor } from "./categoryResolver.js";
import { checkCode } from "./discountRules.js";
import { assertBillLineBalances } from "./lineInvariant.js";
import { refuseStandingClaims, releaseTestOrders, settleTestOrders } from "./payments.js";
import { priceBill } from "./priceBill.js";
import { httpError, inTransaction } from "./transaction.js";
import { auditFields, hasField, INT_MAX, lockRow, readNumber, wholeNumber } from "./common.js";

const BILL_COLUMNS = `id, bill_no, series, fy, bill_type, patient_id, visit_id, appointment_id,
  bill_date::text AS bill_date, status, scheme_code, scheme_label, payer_name,
  scheme_ref_enc, referral_no_enc, referral_doc_id, patient_age, pay_later,
  actual_amount, discount_amount, tax_amount, patient_payable, claim_amount,
  adjustment_amount, round_off, paid_amount, claim_status, version,
  finalised_by, finalised_at, cancelled_by, cancelled_at, cancel_reason, created_at`;

const SPEC = { table: "bills", noun: "bill", columns: BILL_COLUMNS };

const LINE_COLUMNS = `id, bill_id, visit_id, line_no, service_item_id, source, lab_order_id,
  doctor_id, is_live, repeat_request_id, group_code, subgroup_code, item_code, bill_code,
  bill_name, quantity, base_rate, rate, listed_actual, actual_amount, listed_discount, discount,
  payable_discount, bill_discount, tax_code, sac_hsn, tax_rate_pct, taxable, cgst, sgst,
  payment_rule_id, payment_rule, patient_payable, claim_amount, adjustment_amount`;

export const LINE_SOURCES = ["visit", "lab_order", "added"];

export const TEXT_MAX = 1000;
export const NUMBER_TEXT_MAX = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rupees = (amount) => (amount / 100).toFixed(2);

const ZERO_TOTALS = {
  actual: 0,
  discount: 0,
  tax: 0,
  payable: 0,
  claim: 0,
  adjustment: 0,
  round_off: 0,
};

function cleanUuid(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text.toLowerCase();
}

function cleanItemId(value) {
  const id = readNumber(value, "Choose a valid item");
  if (id === undefined || !Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, "Choose a valid item");
  }
  return id;
}

function cleanReason(value, message) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw httpError(400, message);
  if (text.length > TEXT_MAX)
    throw httpError(400, `${message} — keep it under ${TEXT_MAX} letters`);
  return text;
}

function cleanCodeText(value) {
  const code = typeof value === "string" ? value.trim() : "";
  if (!code || /\s/.test(code)) throw httpError(400, "Enter a discount code");
  return code;
}

function cleanCategoryCode(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw httpError(400, "Category must be a category code");
  return value.trim().toLowerCase() || null;
}

function cleanNumberText(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw httpError(400, `${label} must be text`);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > NUMBER_TEXT_MAX) throw httpError(400, `${label} is too long`);
  return text;
}

function sealNumber(value, label) {
  const text = cleanNumberText(value, label);
  if (text === null) return null;
  const sealed = encryptAadhaar(text);
  if (sealed === text) {
    throw httpError(409, `${label}s can't be stored until the encryption key is set; ask an admin`);
  }
  return sealed;
}

const sameCode = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const maskTail = (stored) => {
  const full = decryptAadhaarFull(stored);
  if (!full) return null;
  const text = String(full).replace(/[^0-9A-Za-z]+/g, "");
  return text.length <= 4 ? text : `XXXX${text.slice(-4)}`;
};

export const billLabel = (bill) =>
  bill?.bill_no ? `bill ${bill.bill_no}` : "this visit's draft bill";

function shapeLine(row) {
  return {
    id: row.id,
    bill_id: row.bill_id,
    line_no: row.line_no,
    service_item_id: row.service_item_id,
    source: row.source,
    lab_order_id: row.lab_order_id,
    doctor_id: row.doctor_id,
    is_live: row.is_live,
    repeat_request_id: row.repeat_request_id,
    group_code: row.group_code,
    subgroup_code: row.subgroup_code,
    item_code: row.item_code,
    bill_code: row.bill_code,
    bill_name: row.bill_name,
    quantity: Number(row.quantity),
    allow_quantity: row.allow_quantity ?? false,
    max_quantity: row.max_quantity === null ? null : Number(row.max_quantity),
    rate: paise(row.rate),
    actual: paise(row.actual_amount),
    discount: paise(row.discount),
    taxable: paise(row.taxable),
    cgst: paise(row.cgst),
    sgst: paise(row.sgst),
    tax: paise(row.cgst) + paise(row.sgst),
    payment_rule_id: row.payment_rule_id,
    payment_rule: row.payment_rule,
    patient_payable: paise(row.patient_payable),
    claim: paise(row.claim_amount),
    adjustment: paise(row.adjustment_amount),
  };
}

function shapeBill(row, lines = [], extra = {}) {
  return {
    id: row.id,
    bill_no: row.bill_no,
    series: row.series,
    fy: row.fy,
    bill_type: row.bill_type,
    status: row.status,
    patient_id: row.patient_id,
    visit_id: row.visit_id,
    appointment_id: row.appointment_id,
    bill_date: row.bill_date,
    category: row.scheme_code,
    category_label: row.scheme_label,
    payer_name: row.payer_name,
    scheme_ref: maskTail(row.scheme_ref_enc),
    referral_no: maskTail(row.referral_no_enc),
    referral_doc_id: row.referral_doc_id,
    patient_age: row.patient_age,
    pay_later: row.pay_later,
    claim_status: row.claim_status,
    version: row.version,
    totals: {
      actual: paise(row.actual_amount),
      discount: paise(row.discount_amount),
      tax: paise(row.tax_amount),
      payable: paise(row.patient_payable),
      claim: paise(row.claim_amount),
      adjustment: paise(row.adjustment_amount),
      round_off: paise(row.round_off),
      paid: paise(row.paid_amount),
    },
    finalised_at: row.finalised_at,
    cancelled_at: row.cancelled_at,
    cancel_reason: row.cancel_reason,
    lines: lines.map(shapeLine),
    ...extra,
  };
}

async function visitFacts(client, visitId) {
  const { rows } = await client.query(
    `SELECT v.id, v.patient_id, v.visit_date::text AS visit_date, v.appointment_id,
            v.assigned_doctor_id, a.visit_type, a.doctor_id AS appointment_doctor_id
       FROM giniflow_visits v
       LEFT JOIN appointments a ON a.id = v.appointment_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) throw httpError(404, "That visit no longer exists");
  return rows[0];
}

async function resolutionFor(client, { patientId, appointmentId, date }) {
  const { rows: patients } = await client.query(
    `SELECT id, dob::text AS dob, age, sex, scheme_code, scheme_ref FROM patients WHERE id = $1`,
    [patientId],
  );
  const { rows: appointments } = appointmentId
    ? await client.query(
        `SELECT id, patient_id, patient_category, visit_type FROM appointments WHERE id = $1`,
        [appointmentId],
      )
    : { rows: [] };
  return resolveCategoryFor(
    { patient: patients[0] ?? null, appointment: appointments[0] ?? null, date },
    client,
  );
}

function chosenCategory(resolution) {
  if (!resolution.category || resolution.needs_sub_category) {
    return { code: null, label: null, payer: null };
  }
  return {
    code: resolution.category.code,
    label: resolution.category.display_label,
    payer: resolution.category.payer_name ?? resolution.parent?.payer_name ?? null,
  };
}

async function categoryRules(client, code) {
  if (!code) {
    return {
      code: null,
      display_label: null,
      requires_referral: false,
      requires_referral_doc: false,
      allow_pay_later: null,
      payer_name: null,
    };
  }
  const { rows } = await client.query(
    `SELECT s.code,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END
              AS display_label,
            s.requires_referral OR COALESCE(p.requires_referral, FALSE) AS requires_referral,
            s.requires_referral_doc OR COALESCE(p.requires_referral_doc, FALSE)
              AS requires_referral_doc,
            COALESCE(s.allow_pay_later, p.allow_pay_later) AS allow_pay_later,
            COALESCE(NULLIF(btrim(s.payer_name), ''), NULLIF(btrim(p.payer_name), '')) AS payer_name
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1`,
    [code],
  );
  if (!rows.length) throw httpError(404, "That category doesn't exist");
  return rows[0];
}

async function liveLines(client, billId, { all = false } = {}) {
  const { rows } = await client.query(
    `SELECT ${LINE_COLUMNS.split(/,\s*/)
      .map((column) => `l.${column}`)
      .join(", ")},
            COALESCE(i.allow_quantity, FALSE) AS allow_quantity, i.max_quantity
       FROM bill_lines l LEFT JOIN service_items i ON i.id = l.service_item_id
      WHERE l.bill_id = $1 AND (l.is_live OR $2)
      ORDER BY l.line_no, l.created_at, l.id`,
    [billId, all],
  );
  return rows;
}

async function billCodes(client, billId) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (lower(d.code)) d.code
       FROM bill_line_discounts d JOIN bill_lines l ON l.id = d.bill_line_id
      WHERE l.bill_id = $1 AND l.is_live AND d.code IS NOT NULL
      ORDER BY lower(d.code)`,
    [billId],
  );
  return rows.map((row) => row.code);
}

const LINE_VALUES = (line, lineNo) => ({
  line_no: lineNo,
  doctor_id: line.doctor_id,
  group_code: line.group_code,
  subgroup_code: line.subgroup_code,
  item_code: line.item_code,
  bill_code: line.bill_code,
  bill_name: line.bill_name,
  quantity: line.quantity,
  base_rate: rupees(line.base_price),
  rate: rupees(line.rate),
  listed_actual: rupees(line.listed_actual),
  actual_amount: rupees(line.actual),
  listed_discount: rupees(line.listed_discount),
  discount: rupees(line.discount),
  payable_discount: rupees(line.payable_discount),
  bill_discount: rupees(line.bill_discount),
  tax_code: line.tax_code,
  sac_hsn: line.sac_hsn,
  tax_rate_pct: line.tax_code === null ? null : line.tax_rate,
  taxable: rupees(line.taxable),
  cgst: rupees(line.cgst),
  sgst: rupees(line.sgst),
  payment_rule_id: line.payment_rule_id,
  payment_rule: line.payment_rule_text,
  patient_payable: rupees(line.patient_payable),
  claim_amount: rupees(line.claim),
  adjustment_amount: rupees(line.adjustment),
});

async function saveLine(client, id, lineNo, line, ctx) {
  const values = LINE_VALUES(line, lineNo);
  const keys = Object.keys(values);
  await client.query(
    `UPDATE bill_lines SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(", ")},
        updated_at = NOW(), updated_by = $${keys.length + 2}
      WHERE id = $1`,
    [id, ...keys.map((key) => values[key]), ctx?.actorId ?? null],
  );
  await client.query(`DELETE FROM bill_line_discounts WHERE bill_line_id = $1`, [id]);
  const steps = [
    ...line.discounts,
    ...line.bill_discounts.map((step) => ({ ...step, taken_from: "bill" })),
  ];
  for (const step of steps) {
    if (!step.amount) continue;
    await client.query(
      `INSERT INTO bill_line_discounts
         (bill_line_id, rule_id, code, method, taken_from, amount, applied_by, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)`,
      [
        id,
        step.rule_id,
        step.code ?? null,
        step.method,
        step.taken_from,
        rupees(step.amount),
        ctx?.actorId ?? null,
      ],
    );
  }
}

async function takenOn(client, billId) {
  const { rows } = await client.query(
    `SELECT GREATEST(b.paid_amount, COALESCE(SUM(p.amount), 0)) AS taken
       FROM bills b LEFT JOIN payments p ON p.bill_id = b.id
      WHERE b.id = $1 GROUP BY b.paid_amount`,
    [billId],
  );
  return paise(rows[0].taken);
}

async function saveTotals(client, bill, totals, ctx) {
  const taken = await takenOn(client, bill.id);
  if (totals.payable < taken) {
    throw httpError(
      409,
      `₹${rupees(taken)} has already been taken on ${billLabel(bill)}, which is more than the ₹${rupees(totals.payable)} it now comes to, and refunds are not available yet`,
    );
  }
  const { rows } = await client.query(
    `UPDATE bills
        SET actual_amount = $2, discount_amount = $3, tax_amount = $4, patient_payable = $5,
            claim_amount = $6, adjustment_amount = $7, round_off = $8,
            version = version + 1, updated_at = NOW(), updated_by = $9
      WHERE id = $1
      RETURNING ${BILL_COLUMNS}`,
    [
      bill.id,
      rupees(totals.actual),
      rupees(totals.discount),
      rupees(totals.tax),
      rupees(totals.payable),
      rupees(totals.claim),
      rupees(totals.adjustment),
      rupees(totals.round_off),
      ctx?.actorId ?? null,
    ],
  );
  return rows[0];
}

async function reprice(client, bill, codes, ctx) {
  const lines = await liveLines(client, bill.id);
  if (!lines.length) {
    return { priced: null, lines: [], bill: await saveTotals(client, bill, ZERO_TOTALS, ctx) };
  }
  const priced = await priceBill(
    {
      patientId: bill.patient_id,
      ...(bill.appointment_id ? { appointmentId: bill.appointment_id } : {}),
      category: bill.scheme_code,
      date: bill.bill_date,
      role: ctx?.role,
      codes,
      lines: lines.map((line) => ({
        item: line.service_item_id,
        quantity: Number(line.quantity),
        doctorId: line.doctor_id,
      })),
    },
    client,
  );
  priced.lines.forEach(assertBillLineBalances);
  const { rows: highest } = await client.query(
    `SELECT COALESCE(MAX(line_no), 0) AS top FROM bill_lines WHERE bill_id = $1`,
    [bill.id],
  );
  await client.query(`UPDATE bill_lines SET line_no = line_no + $2 WHERE bill_id = $1`, [
    bill.id,
    Number(highest[0].top),
  ]);
  for (const [index, line] of priced.lines.entries()) {
    await saveLine(client, lines[index].id, index + 1, line, ctx);
  }
  return { priced, lines, bill: await saveTotals(client, bill, priced.totals, ctx) };
}

async function billDiscounts(client, billId) {
  const { rows } = await client.query(
    `SELECT d.code, d.method, COALESCE(r.name, d.code) AS name, SUM(d.amount) AS amount
       FROM bill_line_discounts d
       JOIN bill_lines l ON l.id = d.bill_line_id
       LEFT JOIN discount_rules r ON r.id = d.rule_id
      WHERE l.bill_id = $1 AND l.is_live
      GROUP BY d.code, d.method, COALESCE(r.name, d.code)
      ORDER BY d.method, COALESCE(r.name, d.code)`,
    [billId],
  );
  return rows.map((row) => ({
    code: row.code,
    method: row.method,
    name: row.name,
    amount: paise(row.amount),
  }));
}

async function withLines(client, row, extra = {}) {
  return shapeBill(row, await liveLines(client, row.id, { all: row.status === "cancelled" }), {
    discounts: await billDiscounts(client, row.id),
    ...extra,
  });
}

function assertDraft(bill) {
  if (bill.status === "draft") return bill;
  throw httpError(
    409,
    bill.status === "final"
      ? `${billLabel(bill)} is already final, so it can't be changed`
      : `${billLabel(bill)} was cancelled, so it can't be changed`,
  );
}

async function lockBill(client, billId) {
  return lockRow(client, SPEC, cleanUuid(billId, "bill"));
}

export async function openDraftIn(client, visitId, ctx) {
  const visit = await visitFacts(client, visitId);
  const open = await client.query(
    `SELECT ${BILL_COLUMNS} FROM bills
      WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice' FOR UPDATE`,
    [visitId],
  );
  if (open.rows.length) return open.rows[0];
  const resolution = await resolutionFor(client, {
    patientId: visit.patient_id,
    appointmentId: visit.appointment_id,
    date: visit.visit_date,
  });
  const category = chosenCategory(resolution);
  await client.query("SAVEPOINT billing_draft");
  try {
    const { rows } = await client.query(
      `INSERT INTO bills (patient_id, visit_id, appointment_id, bill_date, scheme_code,
                          scheme_label, payer_name, patient_age, created_by, updated_by)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $9)
       RETURNING ${BILL_COLUMNS}`,
      [
        visit.patient_id,
        visit.id,
        visit.appointment_id,
        visit.visit_date,
        category.code,
        category.label,
        category.payer,
        resolution.age,
        ctx?.actorId ?? null,
      ],
    );
    await client.query("RELEASE SAVEPOINT billing_draft");
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: rows[0].id,
      action: "create",
      after: rows[0],
      ...auditFields(ctx),
    });
    return rows[0];
  } catch (error) {
    if (error.code !== "23505") throw error;
    await client.query("ROLLBACK TO SAVEPOINT billing_draft");
    const { rows } = await client.query(
      `SELECT ${BILL_COLUMNS} FROM bills
        WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice' FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw error;
    return rows[0];
  }
}

export async function repriceBillIn(client, billId, ctx) {
  const { rows } = await client.query(
    `SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1 FOR UPDATE`,
    [billId],
  );
  if (!rows.length) throw httpError(404, "That bill no longer exists");
  return reprice(client, rows[0], await billCodes(client, billId), ctx);
}

export async function openDraft(visitId, ctx, db = pool) {
  const id = cleanUuid(visitId, "visit");
  return inTransaction(async (client) => {
    const bill = await openDraftIn(client, id, ctx);
    const resolution = await resolutionFor(client, {
      patientId: bill.patient_id,
      appointmentId: bill.appointment_id,
      date: bill.bill_date,
    });
    return withLines(client, bill, {
      codes: await billCodes(client, bill.id),
      needs_category: !bill.scheme_code && resolution.needs_sub_category,
      suggestions: bill.scheme_code ? [] : resolution.suggestions,
    });
  }, db);
}

export async function readBill(billId, db = pool) {
  const id = cleanUuid(billId, "bill");
  const { rows } = await db.query(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1`, [id]);
  if (!rows.length) throw httpError(404, "That bill no longer exists");
  return shapeBill(rows[0], await liveLines(db, id, { all: rows[0].status === "cancelled" }), {
    codes: await billCodes(db, id),
    discounts: await billDiscounts(db, id),
  });
}

export async function listVisitBills(visitId, db = pool) {
  const id = cleanUuid(visitId, "visit");
  const { rows } = await db.query(
    `SELECT ${BILL_COLUMNS} FROM bills WHERE visit_id = $1 ORDER BY created_at, id`,
    [id],
  );
  const bills = [];
  for (const row of rows) bills.push(shapeBill(row, await liveLines(db, row.id)));
  return bills;
}

async function itemFor(client, itemId) {
  const { rows } = await client.query(
    `SELECT id, name, kind, is_active, allow_quantity, max_quantity FROM service_items
      WHERE id = $1`,
    [itemId],
  );
  if (!rows.length) throw httpError(404, "That item doesn't exist");
  if (!rows[0].is_active) throw httpError(409, `${rows[0].name} is deactivated`);
  return rows[0];
}

async function approvalFor(client, bill, item, repeatRequestId, ctx) {
  await client.query(`SELECT id FROM bills WHERE visit_id = $1 FOR UPDATE`, [bill.visit_id]);
  const line = await liveLineFor(client, {
    visitId: bill.visit_id,
    serviceItemId: item.id,
  });
  if (!line) return null;
  const approval = repeatRequestId
    ? { id: repeatRequestId }
    : await repeatApprovalFor(client, { visitId: bill.visit_id, serviceItemId: item.id });
  if (!approval) {
    throw httpError(
      409,
      `Already billed on ${billLabel(line)} — ask an admin to approve billing ${item.name} again`,
      { bill_id: line.bill_id, bill_no: line.bill_no, service_item_id: item.id },
    );
  }
  await useRepeatApproval(
    approval.id,
    { visitId: bill.visit_id, serviceItemId: item.id },
    ctx,
    client,
  );
  return approval.id;
}

export async function addLineIn(client, bill, input, ctx) {
  assertDraft(bill);
  const itemId = cleanItemId(input?.item_id ?? input?.item);
  const quantity = wholeNumber(input?.quantity, "Quantity", { min: 1 }) ?? 1;
  const source = input?.source ?? "added";
  if (!LINE_SOURCES.includes(source)) throw httpError(400, "That line source isn't known");
  const labOrderId = input?.lab_order_id ? cleanUuid(input.lab_order_id, "test order") : null;
  if ((source === "lab_order") !== Boolean(labOrderId)) {
    throw httpError(400, "A test-order line must name its order, and no other line may");
  }
  const item = await itemFor(client, itemId);
  const repeatRequestId = await approvalFor(
    client,
    bill,
    item,
    input?.repeat_request_id ? cleanUuid(input.repeat_request_id, "approval") : null,
    ctx,
  );
  const { rows: seats } = await client.query(
    `SELECT COALESCE(MAX(line_no), 0) + 1 AS next FROM bill_lines WHERE bill_id = $1`,
    [bill.id],
  );
  const { rows } = await client.query(
    `INSERT INTO bill_lines (bill_id, visit_id, line_no, service_item_id, source, lab_order_id,
                             doctor_id, repeat_request_id, bill_name, quantity, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     RETURNING ${LINE_COLUMNS}`,
    [
      bill.id,
      bill.visit_id,
      seats[0].next,
      item.id,
      source,
      labOrderId,
      input?.doctor_id ?? null,
      repeatRequestId,
      item.name,
      quantity,
      ctx?.actorId ?? null,
    ],
  );
  const saved = await reprice(client, bill, await billCodes(client, bill.id), ctx);
  await writeAudit(client, {
    entity: "bill_lines",
    entityId: rows[0].id,
    action: "create",
    after: { ...rows[0], bill_no: bill.bill_no },
    ...auditFields(ctx),
  });
  return {
    bill: saved.bill,
    line_id: rows[0].id,
    priced: saved.priced,
    used_approval_id: repeatRequestId,
  };
}

export async function addLine(billId, input, ctx, db = pool) {
  let usedApprovalId = null;
  const bill = await inTransaction(async (client) => {
    const locked = await lockBill(client, billId);
    const saved = await addLineIn(client, locked, input, ctx);
    usedApprovalId = saved.used_approval_id;
    return withLines(client, saved.bill, { codes: await billCodes(client, locked.id) });
  }, db);
  await announceUsed(usedApprovalId, db);
  return bill;
}

async function lineOf(client, bill, lineId) {
  const { rows } = await client.query(
    `SELECT ${LINE_COLUMNS} FROM bill_lines WHERE id = $1 AND bill_id = $2 AND is_live FOR UPDATE`,
    [cleanUuid(lineId, "line"), bill.id],
  );
  if (!rows.length) throw httpError(404, "That line is no longer on this bill");
  return rows[0];
}

export async function changeQuantity(billId, lineId, input, ctx, db = pool) {
  const quantity = wholeNumber(input?.quantity, "Quantity", { min: 1 });
  if (quantity === undefined) throw httpError(400, "Quantity must be a whole number, 1 or more");
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    const before = await lineOf(client, bill, lineId);
    const item = await itemFor(client, before.service_item_id);
    if (quantity !== 1 && !item.allow_quantity) {
      throw httpError(400, `${item.name} is billed one at a time; its quantity must be 1`);
    }
    if (item.max_quantity !== null && quantity > item.max_quantity) {
      throw httpError(400, `${item.name} can be billed at most ${item.max_quantity} on one line`);
    }
    await client.query(
      `UPDATE bill_lines SET quantity = $2, listed_actual = ROUND($2 * rate, 2),
          updated_at = NOW(), updated_by = $3
        WHERE id = $1`,
      [before.id, quantity, ctx?.actorId ?? null],
    );
    const saved = await reprice(client, bill, await billCodes(client, bill.id), ctx);
    await writeAudit(client, {
      entity: "bill_lines",
      entityId: before.id,
      action: "update",
      before,
      after: { ...before, quantity },
      ...auditFields(ctx),
    });
    return withLines(client, saved.bill, { codes: await billCodes(client, bill.id) });
  }, db);
}

export async function removeLine(billId, lineId, input, ctx, db = pool) {
  const reason = cleanReason(input?.reason, "Say why this line is being removed");
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    const before = await lineOf(client, bill, lineId);
    await client.query(`DELETE FROM bill_line_discounts WHERE bill_line_id = $1`, [before.id]);
    await client.query(`DELETE FROM bill_lines WHERE id = $1`, [before.id]);
    const saved = await reprice(client, bill, await billCodes(client, bill.id), ctx);
    await writeAudit(client, {
      entity: "bill_lines",
      entityId: before.id,
      action: "delete",
      before,
      after: { removed: true, reason },
      ...auditFields(ctx),
    });
    return withLines(client, saved.bill, { codes: await billCodes(client, bill.id) });
  }, db);
}

function refusedCode(priced, code) {
  const refused = priced.refused_codes.find((entry) => sameCode(entry.code, code));
  return httpError(409, refused?.message ?? `The code ${code} can't be used on this bill`, {
    reason: refused?.reason ?? "no_effect",
  });
}

export async function addCode(billId, input, ctx, db = pool) {
  const code = cleanCodeText(input?.code ?? input);
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    const codes = await billCodes(client, bill.id);
    if (codes.some((entered) => sameCode(entered, code))) {
      throw httpError(409, `The code ${code} is already on this bill`);
    }
    const saved = await reprice(client, bill, [...codes, code], ctx);
    if (!saved.priced) throw httpError(409, "Add an item before entering a discount code");
    const applied = saved.priced.applied_codes.find((entry) => sameCode(entry.code, code));
    if (!applied) throw refusedCode(saved.priced, code);
    if (!applied.amount) {
      throw httpError(
        409,
        `The code ${code} takes nothing off this bill as it stands, so it can't be kept — add the items it pays for first`,
        { reason: "no_effect" },
      );
    }
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: bill.id,
      action: "update",
      before: { codes },
      after: { codes: [...codes, code] },
      ...auditFields(ctx),
    });
    return withLines(client, saved.bill, { codes: await billCodes(client, bill.id) });
  }, db);
}

export async function removeCode(billId, input, ctx, db = pool) {
  const code = cleanCodeText(input?.code ?? input);
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    const codes = await billCodes(client, bill.id);
    if (!codes.some((entered) => sameCode(entered, code))) {
      throw httpError(404, `The code ${code} isn't on this bill`);
    }
    const kept = codes.filter((entered) => !sameCode(entered, code));
    const saved = await reprice(client, bill, kept, ctx);
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: bill.id,
      action: "update",
      before: { codes },
      after: { codes: kept },
      ...auditFields(ctx),
    });
    return withLines(client, saved.bill, { codes: await billCodes(client, bill.id) });
  }, db);
}

async function checkReferralDoc(client, bill, documentId) {
  const id = wholeNumber(documentId, "Referral scan", { min: 1 });
  if (id === undefined) return null;
  const { rows } = await client.query(`SELECT id, patient_id FROM documents WHERE id = $1`, [id]);
  if (!rows.length) throw httpError(404, "That referral scan doesn't exist");
  if (rows[0].patient_id !== bill.patient_id) {
    throw httpError(409, "That referral scan belongs to another patient");
  }
  return id;
}

const SUB_CATEGORIES = `
  (SELECT json_agg(json_build_object(
            'category', json_build_object(
              'code', c.code,
              'label', c.label,
              'display_label', s.label || ' › ' || c.label,
              'parent_code', c.parent_code,
              'payer_name', c.payer_name),
            'rule', NULL,
            'reason', 'choose_sub_category')
          ORDER BY c.sort_order, c.label, c.code)
     FROM patient_schemes c WHERE c.parent_code = s.code AND c.is_active)`;

async function assertBillable(client, code) {
  if (!code) return;
  const { rows } = await client.query(
    `SELECT s.is_active AND COALESCE(p.is_active, TRUE) AS billable,
            CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END
              AS display_label,
            ${SUB_CATEGORIES} AS sub_categories
       FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1`,
    [code],
  );
  if (!rows.length) throw httpError(404, "That category doesn't exist");
  const { billable, display_label: label, sub_categories: subs } = rows[0];
  if (!billable) throw httpError(409, `${label} is retired`);
  if (subs) {
    throw httpError(
      409,
      `${label} has sub-categories, so the bill can't be made under it: choose one of ${subs
        .map((entry) => entry.category.display_label)
        .join(", ")}`,
      { needs_sub_category: true, suggestions: subs },
    );
  }
}

export async function setCategory(billId, input, ctx, db = pool) {
  return inTransaction(async (client) => {
    const before = assertDraft(await lockBill(client, billId));
    const values = {};
    if (hasField(input, "category")) {
      values.scheme_code = cleanCategoryCode(input.category);
      await assertBillable(client, values.scheme_code);
    }
    if (hasField(input, "scheme_ref")) {
      values.scheme_ref_enc = sealNumber(input.scheme_ref, "Card number");
    }
    if (hasField(input, "referral_no")) {
      values.referral_no_enc = sealNumber(input.referral_no, "Referral number");
    }
    if (hasField(input, "referral_doc_id")) {
      values.referral_doc_id = await checkReferralDoc(client, before, input.referral_doc_id);
    }
    if (!Object.keys(values).length) throw httpError(400, "Nothing to change on this bill");
    const keys = Object.keys(values);
    const { rows } = await client.query(
      `UPDATE bills SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(", ")},
          updated_at = NOW(), updated_by = $${keys.length + 2}
        WHERE id = $1 RETURNING ${BILL_COLUMNS}`,
      [before.id, ...keys.map((key) => values[key]), ctx?.actorId ?? null],
    );
    const saved = await reprice(client, rows[0], await billCodes(client, before.id), ctx);
    const category = await categoryRules(client, saved.bill.scheme_code);
    const { rows: named } = await client.query(
      `UPDATE bills SET scheme_label = $2, payer_name = $3, updated_at = NOW()
        WHERE id = $1 RETURNING ${BILL_COLUMNS}`,
      [before.id, category.display_label, category.payer_name],
    );
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: before.id,
      action: "update",
      before,
      after: named[0],
      ...auditFields(ctx),
    });
    return withLines(client, named[0], { codes: await billCodes(client, before.id) });
  }, db);
}

async function assertCategoryChosen(client, bill) {
  const resolution = await resolutionFor(client, {
    patientId: bill.patient_id,
    appointmentId: bill.appointment_id,
    date: bill.bill_date,
  });
  if (!resolution.needs_sub_category) return;
  if (bill.scheme_code && bill.scheme_code !== resolution.category?.code) return;
  const choices = resolution.suggestions.map((s) => s.category.display_label).join(", ");
  throw httpError(
    409,
    `${resolution.category.display_label} has sub-categories, so choose one before this bill can be made final: ${choices}`,
    { needs_sub_category: true, suggestions: resolution.suggestions },
  );
}

async function recheckCodes(client, bill, codes, ctx) {
  if (!codes.length) return;
  await client.query(
    `SELECT id FROM discount_rules WHERE lower(code) = ANY($1::text[]) ORDER BY id FOR UPDATE`,
    [codes.map((code) => code.toLowerCase())],
  );
  const { rows } = await client.query(`SELECT sex FROM patients WHERE id = $1`, [bill.patient_id]);
  const context = {
    category: bill.scheme_code,
    patient: {
      id: bill.patient_id,
      age: bill.patient_age,
      gender: normalizeGender(rows[0]?.sex),
    },
    date: bill.bill_date,
    role: ctx?.role,
    codesOnBill: 0,
  };
  for (const code of codes) {
    const result = await checkCode(code, null, context, client);
    if (!result.ok) throw httpError(409, result.message, { reason: result.reason, code });
  }
}

export async function finaliseBill(billId, input, ctx, db = pool) {
  const version = wholeNumber(input?.version, "Version", { min: 0 });
  if (version === undefined) throw httpError(400, "Send the bill's version so nothing is lost");
  const payLater = input?.pay_later === true;
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    if (bill.version !== version) {
      throw httpError(409, "This bill changed while you were working on it — open it again", {
        version: bill.version,
      });
    }
    const lines = await liveLines(client, bill.id);
    if (!lines.length) throw httpError(409, "This bill has no items on it yet");
    await assertCategoryChosen(client, bill);
    const codes = await billCodes(client, bill.id);
    await recheckCodes(client, bill, codes, ctx);
    const saved = await reprice(client, bill, codes, ctx);
    saved.priced.lines.forEach(assertBillLineBalances);
    await refuseStandingClaims(client, saved.bill);
    const category = await categoryRules(client, saved.bill.scheme_code);
    if (category.requires_referral && !saved.bill.referral_no_enc) {
      throw httpError(409, `${category.display_label} needs the referral number on the bill`);
    }
    if (category.requires_referral_doc && !saved.bill.referral_doc_id) {
      throw httpError(409, `${category.display_label} needs the referral letter attached`);
    }
    const payable = saved.priced.totals.payable;
    const paid = await takenOn(client, bill.id);
    const settings = await getSettings(client);
    const allowed = category.allow_pay_later ?? settings.allow_pay_later;
    const later = payable > paid && payLater;
    if (payable !== paid && !(payable === 0) && !later) {
      throw httpError(
        409,
        `₹${rupees(payable - paid)} is still to be collected on this bill; take the payment or choose pay later`,
      );
    }
    if (later && !allowed) {
      throw httpError(
        409,
        "Pay later isn't allowed, so this bill must be paid before it is made final",
      );
    }
    const number = await nextNumber(client, seriesFor("bill"), saved.bill.bill_date, ctx);
    const claimStatus = saved.priced.totals.claim > 0 ? "pending" : "none";
    const { rows } = await client.query(
      `UPDATE bills
          SET status = 'final', bill_no = $2, series = $3, fy = $4, claim_status = $5,
              pay_later = $6, finalised_by = $7, finalised_at = NOW(),
              version = version + 1, updated_at = NOW(), updated_by = $7
        WHERE id = $1
        RETURNING ${BILL_COLUMNS}`,
      [bill.id, number.number, number.series, number.fy, claimStatus, later, ctx?.actorId ?? null],
    );
    await settleTestOrders(client, rows[0], ctx);
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: bill.id,
      action: "update",
      before: bill,
      after: rows[0],
      ...auditFields(ctx),
    });
    return withLines(client, rows[0], { codes: await billCodes(client, bill.id) });
  }, db);
}

export async function cancelBill(billId, input, ctx, db = pool) {
  const reason = cleanReason(input?.reason, "Say why this bill is being cancelled");
  return inTransaction(async (client) => {
    const bill = await lockBill(client, billId);
    if (bill.status === "draft") {
      throw httpError(409, "That bill is still a draft, so remove its lines instead");
    }
    if (bill.status === "cancelled") throw httpError(409, "That bill is already cancelled");
    if (bill.claim_status === "cleared") throw httpError(409, "Already paid by CGHS");
    const paid = await takenOn(client, bill.id);
    if (paid > 0) throw httpError(409, "Refunds are not available yet");
    await client.query(
      `UPDATE bill_lines SET is_live = FALSE, updated_at = NOW(), updated_by = $2
        WHERE bill_id = $1 AND is_live`,
      [bill.id, ctx?.actorId ?? null],
    );
    const { rows } = await client.query(
      `UPDATE bills
          SET status = 'cancelled', claim_status = 'none', cancel_reason = $2,
              cancelled_by = $3, cancelled_at = NOW(), version = version + 1,
              updated_at = NOW(), updated_by = $3
        WHERE id = $1
        RETURNING ${BILL_COLUMNS}`,
      [bill.id, reason, ctx?.actorId ?? null],
    );
    await releaseTestOrders(client, bill, ctx);
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: bill.id,
      action: "cancel",
      before: bill,
      after: rows[0],
      ...auditFields(ctx),
    });
    return withLines(client, rows[0]);
  }, db);
}
