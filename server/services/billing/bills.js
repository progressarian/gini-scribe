import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions.js";
import { decryptAadhaarFull, encryptAadhaar } from "../../utils/aadhaarCrypt.js";
import { writeAudit } from "./audit.js";
import { nextNumber, seriesFor } from "./billNumber.js";
import { addsConsultation, getSettings } from "./billingSettings.js";
import {
  announceUsed,
  liveLineFor,
  repeatApprovalFor,
  useRepeatApproval,
} from "./billingRequests.js";
import { normalizeGender, resolveCategoryFor } from "./categoryResolver.js";
import { checkCode } from "./discountRules.js";
import { issuedGstReady } from "./issuedGst.js";
import { assertBillLineBalances } from "./lineInvariant.js";
import {
  moneyOn,
  orderShares,
  orderStatesOn,
  refuseReceptionMoney,
  releaseTestOrders,
  settleTestOrders,
} from "./payments.js";
import { priceBill } from "./priceBill.js";
import { visitConsultationType } from "./serviceItems.js";
import { refuseRemoved, removedDoctor } from "./removedDoctors.js";
import { httpError, inTransaction } from "./transaction.js";
import {
  auditFields,
  hasField,
  INT_MAX,
  lockRow,
  MONEY_MAX,
  readNumber,
  wholeNumber,
} from "./common.js";
import { markDraftSaved } from "./draftSaves.js";
import { billCredits } from "./creditNotes.js";
import { lockVisitOrders, orderToLink, SETTLED_AT_RECEPTION } from "./orderLinks.js";
import { PAID_AT_RECEPTION, receptionHolds, refuseReceptionTest } from "./receptionOrders.js";
import { BILL_DISCOUNT_NAME, cleanManualDiscount, manualOf } from "./manualDiscounts.js";

const BILL_COLUMNS = `id, bill_no, series, fy, bill_type, original_bill_id, patient_id, visit_id,
  appointment_id,
  bill_date::text AS bill_date, status, scheme_code, scheme_label, payer_name,
  scheme_ref_enc, referral_no_enc, referral_doc_id, patient_age, pay_later,
  actual_amount, discount_amount, tax_amount, patient_payable, claim_amount,
  adjustment_amount, round_off, paid_amount, claim_status, version,
  finalised_by, finalised_at, cancelled_by, cancelled_at, cancel_reason, created_at, saved_at,
  manual_discount_kind, manual_discount_value, manual_discount_reason,
  manual_discount_by, manual_discount_at`;

const SPEC = { table: "bills", noun: "bill", columns: BILL_COLUMNS };

const LINE_COLUMNS = `id, bill_id, visit_id, line_no, service_item_id, source, lab_order_id,
  doctor_id, is_live, repeat_request_id, credited_line_id, group_code, subgroup_code, item_code, bill_code,
  bill_name, quantity, base_rate, rate, listed_actual, actual_amount, listed_discount, discount,
  payable_discount, bill_discount, tax_code, sac_hsn, tax_rate_pct, taxable, cgst, sgst,
  payment_rule_id, payment_rule, patient_payable, claim_amount, adjustment_amount,
  agreed_rate, agreed_by, agreed_at, created_by, manual_discount_kind, manual_discount_value, manual_discount_reason,
  manual_discount_by, manual_discount_at`;

export const LINE_SOURCES = ["visit", "lab_order", "added", "lab_case", "ordered"];

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

function optionalReason(value, message) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? cleanReason(text, message) : null;
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

export const maskTail = (stored) => {
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
    credited_line_id: row.credited_line_id,
    group_code: row.group_code,
    group_name: row.group_name ?? null,
    item_kind: row.item_kind ?? null,
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
    order_state: row.order_state ?? null,
    removed_doctor: row.removed_doctor ?? null,
    price_per_patient: row.price_per_patient ?? false,
    agreed_rate:
      row.agreed_rate === null || row.agreed_rate === undefined ? null : paise(row.agreed_rate),
    agreed_by: row.agreed_by ?? null,
    agreed_by_name: row.agreed_by_name ?? null,
    agreed_at: row.agreed_at ?? null,
    added_by: row.created_by ?? null,
    added_by_name: row.created_by_name ?? null,
    manual_discount: shapeManual(row, row.manual_discount_by_name),
  };
}

function shapeManual(row, byName = null) {
  if (!row.manual_discount_kind) return null;
  return {
    kind: row.manual_discount_kind,
    value: Number(row.manual_discount_value),
    reason: row.manual_discount_reason ?? null,
    by: row.manual_discount_by ?? null,
    by_name: byName,
    at: row.manual_discount_at ?? null,
  };
}

function shapeBill(row, lines = [], extra = {}) {
  return {
    id: row.id,
    bill_no: row.bill_no,
    series: row.series,
    fy: row.fy,
    bill_type: row.bill_type,
    original_bill_id: row.original_bill_id,
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
    saved: row.saved_at != null,
    saved_at: row.saved_at,
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
    manual_discount: shapeManual(row),
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
            COALESCE(i.allow_quantity, FALSE) AS allow_quantity, i.max_quantity,
            COALESCE(i.price_per_patient, FALSE) AS price_per_patient,
            CASE WHEN i.kind = 'consultation' AND rd.is_active IS FALSE
                 THEN json_build_object('id', rd.id, 'name', rd.name) END AS removed_doctor,
            setter.name AS agreed_by_name, adder.name AS created_by_name,
            discounter.name AS manual_discount_by_name,
            sg.name AS group_name, i.kind AS item_kind
       FROM bill_lines l LEFT JOIN service_items i ON i.id = l.service_item_id
       LEFT JOIN service_subgroups ssg ON ssg.id = i.subgroup_id
       LEFT JOIN service_groups sg ON sg.id = ssg.group_id
       LEFT JOIN doctors rd ON rd.id = COALESCE(i.doctor_id, l.doctor_id)
       LEFT JOIN doctors setter ON setter.id = l.agreed_by
       LEFT JOIN doctors adder ON adder.id = l.created_by
       LEFT JOIN doctors discounter ON discounter.id = l.manual_discount_by
      WHERE l.bill_id = $1 AND (l.is_live OR $2)
      ORDER BY l.line_no, l.created_at, l.id`,
    [billId, all],
  );
  return rows;
}

async function shownLines(client, billId, options) {
  const lines = await liveLines(client, billId, options);
  const states = await orderStatesOn(client, billId);
  return lines.map((line) => ({ ...line, order_state: states.get(line.id) ?? null }));
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

async function saveLines(client, saved, ctx, billManualBy = null) {
  if (!saved.length) return;
  const actor = ctx?.actorId ?? null;
  const appliedBy = (step, manualBy) =>
    step.method !== "manual"
      ? actor
      : ((step.name === BILL_DISCOUNT_NAME ? billManualBy : manualBy) ?? actor);
  const keys = Object.keys(LINE_VALUES(saved[0].line, 1));
  const records = saved.map(({ id, lineNo, line }) => ({ id, ...LINE_VALUES(line, lineNo) }));
  await client.query(
    `UPDATE bill_lines l SET ${keys.map((key) => `${key} = r.${key}`).join(", ")},
        updated_at = NOW(), updated_by = $2
       FROM jsonb_populate_recordset(NULL::bill_lines, $1::jsonb) r
      WHERE l.id = r.id`,
    [JSON.stringify(records), actor],
  );
  await client.query(`DELETE FROM bill_line_discounts WHERE bill_line_id = ANY($1::uuid[])`, [
    saved.map(({ id }) => id),
  ]);
  const steps = saved.flatMap(({ id, line, manualBy }) =>
    [...line.discounts, ...line.bill_discounts.map((step) => ({ ...step, taken_from: "bill" }))]
      .filter((step) => step.amount)
      .map((step) => ({
        bill_line_id: id,
        rule_id: step.rule_id,
        code: step.code ?? null,
        method: step.method,
        taken_from: step.taken_from,
        amount: rupees(step.amount),
        applied_by: appliedBy(step, manualBy),
      })),
  );
  if (!steps.length) return;
  await client.query(
    `INSERT INTO bill_line_discounts
       (bill_line_id, rule_id, code, method, taken_from, amount, applied_by, created_by, updated_by)
     SELECT r.bill_line_id, r.rule_id, r.code, r.method, r.taken_from, r.amount, r.applied_by, $2, $2
       FROM jsonb_populate_recordset(NULL::bill_line_discounts, $1::jsonb) WITH ORDINALITY r
      ORDER BY r.ordinality`,
    [JSON.stringify(steps), actor],
  );
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

const pricingInput = (bill, lines, codes, ctx) => ({
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
    kept: true,
    agreedRate: line.agreed_rate,
    manualDiscount: manualOf(line),
  })),
  manualDiscount: manualOf(bill),
});

async function reprice(client, bill, codes, ctx) {
  const lines = await liveLines(client, bill.id);
  if (!lines.length) {
    return { priced: null, lines: [], bill: await saveTotals(client, bill, ZERO_TOTALS, ctx) };
  }
  const priced = await priceBill(pricingInput(bill, lines, codes, ctx), client);
  priced.lines.forEach(assertBillLineBalances);
  const { rows: highest } = await client.query(
    `SELECT COALESCE(MAX(line_no), 0) AS top FROM bill_lines WHERE bill_id = $1`,
    [bill.id],
  );
  await client.query(`UPDATE bill_lines SET line_no = line_no + $2 WHERE bill_id = $1`, [
    bill.id,
    Number(highest[0].top),
  ]);
  await saveLines(
    client,
    priced.lines.map((line, index) => ({
      id: lines[index].id,
      lineNo: index + 1,
      line,
      manualBy: lines[index].manual_discount_by ?? null,
    })),
    ctx,
    bill.manual_discount_by ?? null,
  );
  return { priced, lines, bill: await saveTotals(client, bill, priced.totals, ctx) };
}

async function billDiscounts(client, billId) {
  const { rows } = await client.query(
    `SELECT d.code, d.method, COALESCE(r.name, d.code, 'Manual discount') AS name, SUM(d.amount) AS amount
       FROM bill_line_discounts d
       JOIN bill_lines l ON l.id = d.bill_line_id
       LEFT JOIN discount_rules r ON r.id = d.rule_id
      WHERE l.bill_id = $1 AND l.is_live
      GROUP BY d.code, d.method, COALESCE(r.name, d.code, 'Manual discount')
      ORDER BY d.method, COALESCE(r.name, d.code, 'Manual discount')`,
    [billId],
  );
  return rows.map((row) => ({
    code: row.code,
    method: row.method,
    name: row.name,
    amount: paise(row.amount),
  }));
}

const showsEveryLine = (row) => row.status !== "draft";

async function billManualOf(client, row) {
  if (!row.manual_discount_kind) return null;
  const { rows } = await client.query(`SELECT name FROM doctors WHERE id = $1`, [
    row.manual_discount_by,
  ]);
  return shapeManual(row, rows[0]?.name ?? null);
}

async function withLines(client, row, extra = {}) {
  return shapeBill(row, await shownLines(client, row.id, { all: showsEveryLine(row) }), {
    discounts: await billDiscounts(client, row.id),
    manual_discount: await billManualOf(client, row),
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

async function lockVisitBills(client, visitId) {
  await client.query(`SELECT id FROM bills WHERE visit_id = $1 ORDER BY id FOR UPDATE`, [visitId]);
}

export async function holdConsultation(client, visitId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `billing-consultation:${visitId}`,
  ]);
}

export async function openDraftIn(client, visitId, ctx) {
  const visit = await visitFacts(client, visitId);
  await lockVisitBills(client, visitId);
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
                          scheme_label, payer_name, patient_age, created_by, updated_by, saved_at)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $9,
               CASE WHEN $10::boolean THEN NULL ELSE NOW() END)
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
        Boolean(ctx?.unsavedDraft),
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

async function removedDoctorOfVisit(client, visitId) {
  const visit = await visitFacts(client, visitId);
  return removedDoctor(visit.appointment_doctor_id ?? visit.assigned_doctor_id, client);
}

async function keepFirstSnapshot(client, bill) {
  if (!bill.saved_at) return;
  const { rows } = await client.query(`SELECT saved_snapshot FROM bills WHERE id = $1`, [bill.id]);
  if (!rows[0].saved_snapshot) await markDraftSaved(client, bill.id);
}

export async function openDraft(visitId, ctx, db = pool) {
  const id = cleanUuid(visitId, "visit");
  return inTransaction(async (client) => {
    const bill = await openDraftIn(client, id, ctx);
    await keepFirstSnapshot(client, bill);
    const resolution = await resolutionFor(client, {
      patientId: bill.patient_id,
      appointmentId: bill.appointment_id,
      date: bill.bill_date,
    });
    return withLines(client, bill, {
      codes: await billCodes(client, bill.id),
      needs_category: !bill.scheme_code && resolution.needs_sub_category,
      suggestions: bill.scheme_code ? [] : resolution.suggestions,
      removed_doctor: (await addsConsultation(client))
        ? await removedDoctorOfVisit(client, id)
        : null,
    });
  }, db);
}

async function claimClearedOn(db, rows) {
  const ids = rows.filter((row) => row.claim_status === "cleared").map((row) => row.id);
  if (!ids.length) return new Map();
  const { rows: found } = await db.query(
    `SELECT b.id, s.received_on::text AS received_on
       FROM bills b JOIN claim_settlements s ON s.id = b.claim_settlement_id
      WHERE b.id = ANY($1::uuid[]) AND s.voided_at IS NULL`,
    [ids],
  );
  return new Map(found.map((row) => [row.id, row.received_on]));
}

export async function readBill(billId, db = pool) {
  const id = cleanUuid(billId, "bill");
  const { rows } = await db.query(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1`, [id]);
  if (!rows.length) throw httpError(404, "That bill no longer exists");
  const clearedOn = await claimClearedOn(db, rows);
  return shapeBill(rows[0], await shownLines(db, id, { all: showsEveryLine(rows[0]) }), {
    codes: await billCodes(db, id),
    discounts: await billDiscounts(db, id),
    claim_cleared_on: clearedOn.get(rows[0].id) ?? null,
    credits: await billCredits(db, rows[0]),
  });
}

export async function listVisitBills(visitId, db = pool) {
  const id = cleanUuid(visitId, "visit");
  const { rows } = await db.query(
    `SELECT ${BILL_COLUMNS} FROM bills WHERE visit_id = $1 ORDER BY created_at, id`,
    [id],
  );
  const clearedOn = await claimClearedOn(db, rows);
  const bills = [];
  for (const row of rows) {
    bills.push(
      shapeBill(row, await shownLines(db, row.id, { all: showsEveryLine(row) }), {
        claim_cleared_on: clearedOn.get(row.id) ?? null,
        credits: await billCredits(db, row),
      }),
    );
  }
  return bills;
}

async function itemFor(client, itemId) {
  const { rows } = await client.query(
    `SELECT id, name, kind, visit_type, is_active, allow_quantity, max_quantity, price_per_patient,
            test_catalog_id, base_price
       FROM service_items WHERE id = $1`,
    [itemId],
  );
  if (!rows.length) throw httpError(404, "That item doesn't exist");
  if (!rows[0].is_active) throw httpError(409, `${rows[0].name} is deactivated`);
  return rows[0];
}

async function approvalFor(client, bill, item, repeatRequestId, ctx) {
  await client.query(`SELECT id FROM bills WHERE visit_id = $1 ORDER BY id FOR UPDATE`, [
    bill.visit_id,
  ]);
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

const VISIT_LABELS = { New: "New Patient", "Follow Up": "Follow Up" };

async function refuseOtherConsultation(client, bill, item) {
  if (item.kind !== "consultation" || !item.visit_type) return;
  const wanted = await visitConsultationType(bill.visit_id, client);
  if (!wanted || wanted === item.visit_type) return;
  throw httpError(409, `This is a ${VISIT_LABELS[wanted]} visit — add the ${wanted} consultation`);
}

async function refuseRemovedConsultant(client, bill, itemId, doctorId) {
  const { rows } = await client.query(
    `SELECT d.id, d.name, i.name AS item
       FROM service_items i
       LEFT JOIN appointments a ON a.id = $3
       JOIN doctors d ON d.id = COALESCE(i.doctor_id, $2::int, a.doctor_id)
      WHERE i.id = $1 AND i.kind = 'consultation' AND d.is_active IS FALSE`,
    [itemId, doctorId, bill.appointment_id ?? null],
  );
  if (rows.length) throw refuseRemoved(rows[0], `${rows[0].item} can't be billed`);
}

function refuseRemovedLines(lines) {
  const line = lines.find((entry) => entry.removed_doctor);
  if (!line) return;
  throw refuseRemoved(
    line.removed_doctor,
    `${line.bill_name} can't be billed; remove it from this bill first`,
  );
}

function cleanAgreedRate(value) {
  if (value === undefined || value === null || value === "") return null;
  const rate = readNumber(value, "The patient's price must be an amount");
  if (rate === undefined || rate < 0) {
    throw httpError(400, "The patient's price must be an amount of ₹0 or more");
  }
  if (rate > MONEY_MAX) {
    throw httpError(400, `The patient's price is too large (at most ₹${MONEY_MAX})`);
  }
  if (Number(rate.toFixed(2)) !== rate) {
    throw httpError(400, "The patient's price can have at most 2 decimals (paise)");
  }
  return rate;
}

function refuseMissingPrice(saved, lineId) {
  const index = saved.lines.findIndex((line) => line.id === lineId);
  const priced = saved.priced?.lines?.[index];
  if (priced?.price_missing) {
    throw httpError(400, `Enter this patient's price for ${priced.item_name}`, {
      code: "price_needed",
    });
  }
}

const isAdmin = (ctx) => hasCapability(ctx?.role, CAPABILITIES.ADMIN);

export function mayChangeOrderedLine(line, ctx) {
  return line.source !== "ordered" || line.created_by === ctx?.actorId || isAdmin(ctx);
}

function mayChangePrice(line, ctx) {
  return line.agreed_by === null || line.agreed_by === ctx?.actorId || isAdmin(ctx);
}

export async function addLineIn(client, bill, input, ctx) {
  assertDraft(bill);
  const itemId = cleanItemId(input?.item_id ?? input?.item);
  const doctorId = wholeNumber(input?.doctor_id, "Doctor", { min: 1 }) ?? null;
  await refuseRemovedConsultant(client, bill, itemId, doctorId);
  const quantity = wholeNumber(input?.quantity, "Quantity", { min: 1 }) ?? 1;
  const source = input?.source ?? "added";
  if (!LINE_SOURCES.includes(source)) throw httpError(400, "That line source isn't known");
  const labOrderId = input?.lab_order_id ? cleanUuid(input.lab_order_id, "test order") : null;
  if ((source === "lab_order") !== Boolean(labOrderId)) {
    throw httpError(400, "A test-order line must name its order, and no other line may");
  }
  const item = await itemFor(client, itemId);
  const agreedRate = cleanAgreedRate(input?.agreed_rate);
  if (agreedRate !== null && !item.price_per_patient && Number(item.base_price) > 0) {
    throw httpError(
      400,
      `${item.name} has a fixed price; it can't be given a price for this patient`,
    );
  }
  await refuseOtherConsultation(client, bill, item);
  await refuseReceptionTest(client, bill, item, labOrderId);
  if (
    source === "ordered" &&
    (await liveLineFor(client, { visitId: bill.visit_id, serviceItemId: item.id }))
  ) {
    throw httpError(
      409,
      `${item.name} is already ordered for this patient — change its quantity, or remove it and add it again`,
    );
  }
  const repeatRequestId = await approvalFor(
    client,
    bill,
    item,
    input?.repeat_request_id ? cleanUuid(input.repeat_request_id, "approval") : null,
    ctx,
  );
  const linkedOrderId =
    source === "added" && !labOrderId ? await orderToLink(client, bill, item) : null;
  const { rows: seats } = await client.query(
    `SELECT COALESCE(MAX(line_no), 0) + 1 AS next FROM bill_lines WHERE bill_id = $1`,
    [bill.id],
  );
  const { rows } = await client.query(
    `INSERT INTO bill_lines (bill_id, visit_id, line_no, service_item_id, source, lab_order_id,
                             doctor_id, repeat_request_id, bill_name, quantity, created_by, updated_by,
                             agreed_rate, agreed_by, agreed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12,
             CASE WHEN $12::numeric IS NULL OR $14::boolean THEN NULL
                  ELSE COALESCE($13::int, $11::int) END,
             CASE WHEN $12::numeric IS NULL THEN NULL ELSE NOW() END)
     RETURNING ${LINE_COLUMNS}`,
    [
      bill.id,
      bill.visit_id,
      seats[0].next,
      item.id,
      linkedOrderId ? "lab_order" : source,
      labOrderId ?? linkedOrderId,
      doctorId,
      repeatRequestId,
      item.name,
      quantity,
      ctx?.actorId ?? null,
      agreedRate,
      input?.agreed_by ?? null,
      input?.price_from_healthray === true,
    ],
  );
  const saved = await reprice(client, bill, await billCodes(client, bill.id), ctx);
  refuseMissingPrice(saved, rows[0].id);
  await writeAudit(client, {
    entity: "bill_lines",
    entityId: rows[0].id,
    action: "create",
    after: { ...rows[0], bill_no: bill.bill_no },
    ...auditFields(ctx),
  });
  if (linkedOrderId) await resettleTestOrders(client, saved.bill, ctx);
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
    const { rows: owner } = await client.query(`SELECT visit_id FROM bills WHERE id = $1`, [
      cleanUuid(billId, "bill"),
    ]);
    if (owner[0]?.visit_id) await lockVisitBills(client, owner[0].visit_id);
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

export async function resettleTestOrders(client, bill, ctx) {
  if (!(await moneyOn(client, bill.id)).held) return;
  if ((await orderStatesOn(client, bill.id)).size) return;
  const shares = await orderShares(client, bill);
  const uncovered = [...shares].filter(([, share]) => !share.settled).map(([orderId]) => orderId);
  if (uncovered.length) await releaseTestOrders(client, bill, ctx, uncovered);
  await settleTestOrders(client, bill, ctx);
}

async function lastLineOfOrder(client, line) {
  if (!line.lab_order_id) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM bill_lines
      WHERE bill_id = $1 AND lab_order_id = $2 AND is_live AND id <> $3 LIMIT 1`,
    [line.bill_id, line.lab_order_id, line.id],
  );
  return !rows.length;
}

export async function changeQuantity(billId, lineId, input, ctx, db = pool) {
  const quantity = wholeNumber(input?.quantity, "Quantity", { min: 1 });
  if (quantity === undefined) throw httpError(400, "Quantity must be a whole number, 1 or more");
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    const before = await lineOf(client, bill, lineId);
    if (!mayChangeOrderedLine(before, ctx)) {
      throw httpError(
        403,
        `${before.bill_name} was ordered for this patient; only whoever ordered it or an admin can change it`,
      );
    }
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
    await resettleTestOrders(client, saved.bill, ctx);
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

async function dropLineIn(client, bill, before, after, ctx) {
  if (await lastLineOfOrder(client, before)) {
    await releaseTestOrders(client, bill, ctx, [before.lab_order_id]);
  }
  await client.query(`DELETE FROM bill_line_discounts WHERE bill_line_id = $1`, [before.id]);
  await client.query(`DELETE FROM bill_lines WHERE id = $1`, [before.id]);
  await writeAudit(client, {
    entity: "bill_lines",
    entityId: before.id,
    action: "delete",
    before,
    after,
    ...auditFields(ctx),
  });
}

export const REPLACED_DEFAULT_CONSULTATION = "Replaced by the consultant's own consultation";

export async function swapAutoConsultationIn(client, visitId, item, ctx) {
  const { rows } = await client.query(
    `SELECT l.id, l.bill_id FROM bill_lines l
       JOIN bills b ON b.id = l.bill_id AND b.status = 'draft' AND b.bill_type = 'invoice'
       JOIN service_items i ON i.id = l.service_item_id
      WHERE l.visit_id = $1 AND l.is_live AND l.source = 'visit'
        AND i.kind = 'consultation' AND i.doctor_id IS NULL
        AND l.agreed_rate IS NULL AND l.service_item_id <> $2
        AND NOT EXISTS (SELECT 1 FROM bills f WHERE f.visit_id = $1
                          AND f.bill_type = 'invoice' AND f.status = 'final')
      LIMIT 1`,
    [visitId, item.id],
  );
  if (!rows.length) return null;
  const bill = assertDraft(await lockBill(client, rows[0].bill_id));
  const before = await lineOf(client, bill, rows[0].id);
  await dropLineIn(
    client,
    bill,
    before,
    { removed: true, reason: REPLACED_DEFAULT_CONSULTATION },
    ctx,
  );
  return addLineIn(
    client,
    bill,
    { item_id: item.id, source: "visit", doctor_id: item.doctor_id ?? item.chosen_doctor_id },
    ctx,
  );
}

export async function removeLine(billId, lineId, input, ctx, db = pool) {
  const reason = optionalReason(input?.reason, "The reason for removing this line");
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    const before = await lineOf(client, bill, lineId);
    if (!mayChangeOrderedLine(before, ctx)) {
      throw httpError(
        403,
        `${before.bill_name} was ordered for this patient; only whoever ordered it or an admin can remove it`,
      );
    }
    if (before.source === "ordered" && !reason) {
      throw httpError(400, "Say why this ordered service is being removed");
    }
    await dropLineIn(client, bill, before, { removed: true, reason }, ctx);
    const saved = await reprice(client, bill, await billCodes(client, bill.id), ctx);
    await resettleTestOrders(client, saved.bill, ctx);
    return withLines(client, saved.bill, { codes: await billCodes(client, bill.id) });
  }, db);
}

export const PAID_AT_RECEPTION_REASON = "Paid at reception";

async function receptionLinesOn(client, bill) {
  const flagged = await orderStatesOn(client, bill.id);
  const lines = await liveLines(client, bill.id);
  const { rows: tests } = await client.query(
    `SELECT id, test_catalog_id FROM service_items
      WHERE id = ANY($1::int[]) AND kind = 'test' AND test_catalog_id IS NOT NULL`,
    [lines.filter((line) => !line.lab_order_id).map((line) => line.service_item_id)],
  );
  const catalogOf = new Map(tests.map((row) => [row.id, row.test_catalog_id]));
  const going = [];
  for (const line of lines) {
    const catalogId = line.lab_order_id ? null : catalogOf.get(line.service_item_id);
    const held =
      flagged.has(line.id) ||
      (catalogId &&
        (await receptionHolds(client, { visitId: bill.visit_id, billId: bill.id, catalogId })));
    if (held) going.push(line);
  }
  return going;
}

const RECEPTION_DRAFT_SQL = `
  SELECT b.id FROM bills b
   WHERE b.visit_id = $1 AND b.status = 'draft' AND b.bill_type = 'invoice'
     AND EXISTS (SELECT 1 FROM bill_lines l WHERE l.bill_id = b.id AND l.is_live)
     AND EXISTS (SELECT 1 FROM giniflow_lab_orders o
                  WHERE o.visit_id = $1 AND o.sample_status <> 'cancelled'
                    AND ${SETTLED_AT_RECEPTION})`;

async function clearReceptionIn(client, visitId, ctx) {
  await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR NO KEY UPDATE`, [visitId]);
  await lockVisitBills(client, visitId);
  const { rows } = await client.query(
    `SELECT ${BILL_COLUMNS} FROM bills
      WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice' FOR UPDATE`,
    [visitId],
  );
  if (!rows.length) return [];
  let bill = rows[0];
  await lockVisitOrders(client, visitId);
  const removed = [];
  for (const line of await receptionLinesOn(client, bill)) {
    try {
      await inTransaction(async (inner) => {
        const before = await lineOf(inner, bill, line.id);
        await dropLineIn(
          inner,
          bill,
          before,
          { removed: true, reason: PAID_AT_RECEPTION_REASON },
          ctx,
        );
      }, client);
      removed.push(line.bill_name);
    } catch (error) {
      if (!error.status) throw error;
    }
  }
  if (!removed.length) return removed;
  bill = (await reprice(client, bill, await billCodes(client, bill.id), ctx)).bill;
  await resettleTestOrders(client, bill, ctx);
  return removed;
}

export async function clearReceptionLines(visitId, ctx, db = pool) {
  try {
    const id = cleanUuid(visitId, "visit");
    const { rows } = await db.query(RECEPTION_DRAFT_SQL, [id]);
    if (!rows.length) return [];
    return await inTransaction((client) => clearReceptionIn(client, id, ctx), db);
  } catch (error) {
    console.error(`[billing] reception-paid lines left on visit ${visitId}: ${error.message}`);
    return [];
  }
}

export async function clearReceptionLinesOfBill(billId, ctx, db = pool) {
  const id = typeof billId === "string" ? billId.trim().toLowerCase() : "";
  if (!UUID.test(id)) return [];
  const { rows } = await db.query(
    `SELECT visit_id FROM bills WHERE id = $1 AND status = 'draft' AND bill_type = 'invoice'`,
    [id],
  );
  return rows[0]?.visit_id ? clearReceptionLines(rows[0].visit_id, ctx, db) : [];
}

const MANUAL_COLUMNS = ["kind", "value", "reason", "by", "at"];

const manualSnapshot = (row) =>
  Object.fromEntries(MANUAL_COLUMNS.map((key) => [key, row[`manual_discount_${key}`] ?? null]));

function readManualInput(input, label) {
  const raw = input?.value;
  if (raw === null || raw === undefined || raw === "" || Number(raw) === 0) return null;
  return cleanManualDiscount({ kind: input?.kind, value: raw }, label);
}

const SET_MANUAL = `manual_discount_kind = $2, manual_discount_value = $3,
  manual_discount_reason = $4, manual_discount_by = $5,
  manual_discount_at = CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END`;

const manualValues = (discount, reason, ctx) =>
  discount
    ? [discount.kind, discount.value, reason, ctx?.actorId ?? null]
    : [null, null, null, null];

export async function setLineDiscount(billId, lineId, input, ctx, db = pool) {
  const reason = optionalReason(input?.reason, "The reason for this discount");
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    const before = await lineOf(client, bill, lineId);
    const discount = readManualInput(input, `${before.bill_name}'s discount`);
    const { rows } = await client.query(
      `UPDATE bill_lines SET ${SET_MANUAL}, updated_at = NOW(), updated_by = $6
        WHERE id = $1 RETURNING ${LINE_COLUMNS}`,
      [before.id, ...manualValues(discount, reason, ctx), ctx?.actorId ?? null],
    );
    const saved = await reprice(client, bill, await billCodes(client, bill.id), ctx);
    await resettleTestOrders(client, saved.bill, ctx);
    const after = (await liveLines(client, bill.id)).find((line) => line.id === before.id);
    await writeAudit(client, {
      entity: "bill_lines",
      entityId: before.id,
      action: "update",
      before: { manual_discount: manualSnapshot(before), bill_discount: before.bill_discount },
      after: {
        manual_discount: manualSnapshot(rows[0]),
        bill_discount: after?.bill_discount ?? null,
        role: ctx?.role ?? null,
      },
      ...auditFields(ctx),
    });
    return withLines(client, saved.bill, { codes: await billCodes(client, bill.id) });
  }, db);
}

export async function setBillDiscount(billId, input, ctx, db = pool) {
  const reason = optionalReason(input?.reason, "The reason for this discount");
  const discount = readManualInput(input, "The bill's discount");
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    const { rows } = await client.query(
      `UPDATE bills SET ${SET_MANUAL}, updated_at = NOW(), updated_by = $6
        WHERE id = $1 RETURNING ${BILL_COLUMNS}`,
      [bill.id, ...manualValues(discount, reason, ctx), ctx?.actorId ?? null],
    );
    const saved = await reprice(client, rows[0], await billCodes(client, bill.id), ctx);
    await resettleTestOrders(client, saved.bill, ctx);
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: bill.id,
      action: "update",
      before: {
        manual_discount: manualSnapshot(bill),
        discount_amount: bill.discount_amount,
        patient_payable: bill.patient_payable,
      },
      after: {
        manual_discount: manualSnapshot(rows[0]),
        discount_amount: saved.bill.discount_amount,
        patient_payable: saved.bill.patient_payable,
        role: ctx?.role ?? null,
      },
      ...auditFields(ctx),
    });
    return withLines(client, saved.bill, { codes: await billCodes(client, bill.id) });
  }, db);
}

export async function setLinePrice(billId, lineId, input, ctx, db = pool) {
  const rate = cleanAgreedRate(input?.agreed_rate);
  if (rate === null) throw httpError(400, "Enter this patient's price");
  const reason = cleanReason(input?.reason, "Say why the price is being changed");
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    const before = await lineOf(client, bill, lineId);
    const item = await itemFor(client, before.service_item_id);
    if (!item.price_per_patient && Number(item.base_price) > 0) {
      throw httpError(
        400,
        `${item.name} has a fixed price; it can't be given a price for this patient`,
      );
    }
    if (!mayChangePrice(before, ctx)) {
      throw httpError(
        403,
        `Only whoever set ${before.bill_name}'s price or an admin can change it`,
      );
    }
    await client.query(
      `UPDATE bill_lines SET agreed_rate = $2, agreed_by = $3, agreed_at = NOW(),
          updated_at = NOW(), updated_by = $3
        WHERE id = $1`,
      [before.id, rate, ctx?.actorId ?? null],
    );
    const saved = await reprice(client, bill, await billCodes(client, bill.id), ctx);
    await resettleTestOrders(client, saved.bill, ctx);
    await writeAudit(client, {
      entity: "bill_lines",
      entityId: before.id,
      action: "update",
      before: { agreed_rate: before.agreed_rate, agreed_by: before.agreed_by },
      after: {
        agreed_rate: rate,
        agreed_by: ctx?.actorId ?? null,
        reason,
        role: ctx?.role ?? null,
      },
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

const MAX_SUGGESTED_CODES = 5;
const MAX_CODES_TRIED = 40;

export async function suggestCodes(billId, ctx, db = pool) {
  const id = cleanUuid(billId, "bill");
  const { rows } = await db.query(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1`, [id]);
  if (!rows.length) throw httpError(404, "That bill no longer exists");
  const bill = rows[0];
  if (bill.status !== "draft") return { codes: [] };
  const lines = await liveLines(db, id);
  if (!lines.length) return { codes: [] };
  const onBill = await billCodes(db, id);
  const { rows: rules } = await db.query(
    `SELECT code FROM discount_rules
      WHERE is_active AND method = 'code' AND code IS NOT NULL
        AND (valid_from IS NULL OR valid_from <= COALESCE($1::date, (now() AT TIME ZONE 'Asia/Kolkata')::date))
        AND (valid_to IS NULL OR valid_to >= COALESCE($1::date, (now() AT TIME ZONE 'Asia/Kolkata')::date))
        AND NOT (lower(code) = ANY($2::text[]))
      ORDER BY priority, lower(name), id
      LIMIT ${MAX_CODES_TRIED}`,
    [bill.bill_date, onBill.map((code) => code.toLowerCase())],
  );
  if (!rules.length) return { codes: [] };
  const base = await priceBill(pricingInput(bill, lines, onBill, ctx), db);
  const found = [];
  for (const { code } of rules) {
    const priced = await priceBill(pricingInput(bill, lines, [...onBill, code], ctx), db).catch(
      () => null,
    );
    if (!priced) continue;
    const applied = priced.applied_codes.find((entry) => sameCode(entry.code, code));
    const saves = base.totals.payable - priced.totals.payable;
    if (applied?.amount > 0 && saves > 0) {
      found.push({ code, rule_id: applied.rule_id, name: applied.name, saves });
    }
  }
  const best = found.sort((a, b) => b.saves - a.saves).slice(0, MAX_SUGGESTED_CODES);
  return { codes: await withReasons(db, best) };
}

async function withReasons(db, codes) {
  if (!codes.length) return codes;
  const { rows } = await db.query(
    `SELECT d.id, d.min_age, d.max_age, d.gender, d.visit_types, d.requires_all_items,
            (SELECT array_agg(CASE WHEN p.code IS NULL THEN s.label ELSE p.label || ' › ' || s.label END)
               FROM patient_schemes s LEFT JOIN patient_schemes p ON p.code = s.parent_code
              WHERE s.code = ANY(d.scheme_codes)) AS categories,
            (SELECT array_agg(i.name ORDER BY i.name) FROM service_items i
              WHERE i.id = ANY(d.service_item_ids)) AS items,
            (SELECT array_agg(g.name ORDER BY g.name) FROM service_groups g
              WHERE g.id = ANY(d.group_ids)) AS groups,
            (SELECT array_agg(g.name ORDER BY g.name) FROM service_subgroups g
              WHERE g.id = ANY(d.subgroup_ids)) AS subgroups
       FROM discount_rules d WHERE d.id = ANY($1::int[])`,
    [codes.map((entry) => entry.rule_id)],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return codes.map((entry) => ({ ...entry, because: reasonsOf(byId.get(entry.rule_id)) }));
}

const listed = (names, most = 2) =>
  names.length > most
    ? `${names.slice(0, most).join(", ")} +${names.length - most}`
    : names.join(", ");

function reasonsOf(rule) {
  if (!rule) return [];
  const age =
    rule.min_age !== null && rule.max_age !== null
      ? `Age ${rule.min_age}–${rule.max_age}`
      : rule.min_age !== null
        ? `Age ${rule.min_age}+`
        : rule.max_age !== null
          ? `Age up to ${rule.max_age}`
          : null;
  const services = [...(rule.items || []), ...(rule.subgroups || []), ...(rule.groups || [])];
  return [
    rule.categories?.length && listed(rule.categories),
    age,
    rule.gender && `${rule.gender[0].toUpperCase()}${rule.gender.slice(1).toLowerCase()} patients`,
    rule.visit_types?.length && `${rule.visit_types.join(" / ")} visit`,
    services.length && `${rule.requires_all_items ? "Package: " : "On "}${listed(services)}`,
  ].filter(Boolean);
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
    refuseRemovedLines(lines);
    await assertCategoryChosen(client, bill);
    const codes = await billCodes(client, bill.id);
    await recheckCodes(client, bill, codes, ctx);
    const saved = await reprice(client, bill, codes, ctx);
    saved.priced.lines.forEach(assertBillLineBalances);
    const unpriced = saved.priced.lines.find((line) => line.price_missing);
    if (unpriced) {
      throw httpError(
        409,
        `${unpriced.item_name} needs this patient's price before the bill can be made final`,
        { code: "price_needed" },
      );
    }
    await refuseReceptionMoney(client, saved.bill);
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
    const gst = Boolean(settings.gst_enabled) || saved.priced.totals.tax > 0;
    const snapshot = (await issuedGstReady(client))
      ? [gst, gst ? settings.gstin : null, gst ? settings.legal_name : null]
      : [];
    const { rows } = await client.query(
      `UPDATE bills
          SET status = 'final', bill_no = $2, series = $3, fy = $4, claim_status = $5,
              pay_later = $6, finalised_by = $7, finalised_at = NOW(),
              ${snapshot.length ? "issued_gst = $8, issued_gstin = $9, issued_legal_name = $10," : ""}
              version = version + 1, updated_at = NOW(), updated_by = $7
        WHERE id = $1
        RETURNING ${BILL_COLUMNS}`,
      [
        bill.id,
        number.number,
        number.series,
        number.fy,
        claimStatus,
        later,
        ctx?.actorId ?? null,
        ...snapshot,
      ],
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
    if (bill.bill_type === "credit_note") {
      throw httpError(409, "A credit note can't be cancelled — it stays with the bill it credits");
    }
    if (bill.status === "cancelled") throw httpError(409, "That bill is already cancelled");
    if (bill.claim_status === "cleared") throw httpError(409, "Already paid by CGHS");
    const { rows: credits } = await client.query(
      `SELECT bill_no FROM bills WHERE original_bill_id = $1 ORDER BY created_at LIMIT 1`,
      [bill.id],
    );
    if (credits.length) {
      throw httpError(
        409,
        `${billLabel(bill)} has credit note ${credits[0].bill_no} against it, so it can't be cancelled — refund what is left on it instead`,
      );
    }
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

async function refusePendingRequest(client, bill) {
  const { rows } = await client.query(
    `SELECT id FROM billing_requests WHERE bill_id = $1 AND status = 'pending' LIMIT 1`,
    [bill.id],
  );
  if (rows.length) {
    throw httpError(
      409,
      "A desk request on this draft is waiting for an admin — wait for the answer before deleting it",
    );
  }
}

async function detachRequests(client, bill, ctx) {
  const { rows } = await client.query(
    `UPDATE billing_requests SET bill_id = NULL, updated_at = NOW(), updated_by = $2
      WHERE bill_id = $1
      RETURNING id`,
    [bill.id, ctx?.actorId ?? null],
  );
  for (const row of rows) {
    await writeAudit(client, {
      entity: "billing_requests",
      entityId: row.id,
      action: "update",
      before: { bill_id: bill.id },
      after: { bill_id: null, draft_deleted: true },
      ...auditFields(ctx),
    });
  }
}

async function lockDraftOfVisit(client, id) {
  const { rows: found } = await client.query(`SELECT visit_id FROM bills WHERE id = $1`, [id]);
  if (!found.length) throw httpError(404, "That bill no longer exists");
  const visitId = found[0].visit_id;
  if (visitId) {
    await holdConsultation(client, visitId);
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR NO KEY UPDATE`, [visitId]);
    await lockVisitBills(client, visitId);
  }
  const bill = assertDraft(await lockBill(client, id));
  if (bill.bill_type !== "invoice") throw httpError(409, "Only a draft bill can be deleted");
  return bill;
}

async function deleteDraftIn(client, bill, after, ctx) {
  const { rows: ordered } = await client.query(
    `SELECT bill_name FROM bill_lines WHERE bill_id = $1 AND is_live AND source = 'ordered' LIMIT 1`,
    [bill.id],
  );
  if (ordered.length) {
    throw httpError(
      409,
      `${ordered[0].bill_name} was ordered for this patient, so this draft can't be deleted; whoever ordered it or an admin must remove it first`,
    );
  }
  if ((await takenOn(client, bill.id)) > 0) {
    throw httpError(409, "Money was taken on this draft — finalise it or refund it first");
  }
  await refusePendingRequest(client, bill);
  const released = await releaseTestOrders(client, bill, ctx);
  const { rows: lines } = await client.query(
    `SELECT ${LINE_COLUMNS} FROM bill_lines WHERE bill_id = $1 ORDER BY line_no, id FOR UPDATE`,
    [bill.id],
  );
  const lineIds = lines.map((line) => line.id);
  await client.query(`DELETE FROM bill_line_discounts WHERE bill_line_id = ANY($1::uuid[])`, [
    lineIds,
  ]);
  await client.query(`DELETE FROM bill_lines WHERE bill_id = $1`, [bill.id]);
  for (const line of lines) {
    await writeAudit(client, {
      entity: "bill_lines",
      entityId: line.id,
      action: "delete",
      before: line,
      after: { removed: true, ...after },
      ...auditFields(ctx),
    });
  }
  await resettleTestOrders(client, bill, ctx);
  await detachRequests(client, bill, ctx);
  await client.query(`DELETE FROM bills WHERE id = $1`, [bill.id]);
  await writeAudit(client, {
    entity: SPEC.table,
    entityId: bill.id,
    action: "delete",
    before: bill,
    after: { deleted: true, ...after, lines: lines.length },
    ...auditFields(ctx),
  });
  return {
    deleted: true,
    bill_id: bill.id,
    visit_id: bill.visit_id,
    removed: lines.map((line) => line.bill_name),
    released: released.length,
  };
}

export async function deleteDraft(billId, input, ctx, db = pool) {
  const reason = optionalReason(input?.reason, "The reason for deleting this draft");
  const id = cleanUuid(billId, "bill");
  return inTransaction(async (client) => {
    const bill = await lockDraftOfVisit(client, id);
    return deleteDraftIn(client, bill, { reason }, ctx);
  }, db);
}

export async function saveDraft(billId, ctx, db = pool) {
  return inTransaction(async (client) => {
    const bill = assertDraft(await lockBill(client, billId));
    await markDraftSaved(client, bill.id, ctx);
    const { rows } = await client.query(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1`, [
      bill.id,
    ]);
    return withLines(client, rows[0], { codes: await billCodes(client, bill.id) });
  }, db);
}

const snapshotKey = (line) =>
  [line.service_item_id, line.source, line.lab_order_id ?? "", line.doctor_id ?? ""].join("|");

const DISCARDED = { discarded: true, reason: "Discarded without saving" };

const SAVED_MANUAL = ["kind", "value", "reason", "by"].map((key) => `manual_discount_${key}`);

const savedManual = (saved) =>
  SAVED_MANUAL.map((column) =>
    column === "manual_discount_value" && saved?.[column] != null
      ? Number(saved[column])
      : (saved?.[column] ?? null),
  );

const sameManual = (line, saved) =>
  JSON.stringify(savedManual(line)) === JSON.stringify(savedManual(saved));

async function restoreManual(client, table, id, saved, ctx) {
  const [kind, value, reason, by] = savedManual(saved);
  await client.query(
    `UPDATE ${table} SET manual_discount_kind = $2, manual_discount_value = $3,
        manual_discount_reason = $4, manual_discount_by = $5,
        manual_discount_at = CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END,
        updated_at = NOW(), updated_by = $6
      WHERE id = $1`,
    [id, kind, value, reason, by, ctx?.actorId ?? null],
  );
}

async function restoreSavedIn(client, bill, ctx) {
  const { rows: stored } = await client.query(`SELECT saved_snapshot FROM bills WHERE id = $1`, [
    bill.id,
  ]);
  const snapshot = stored[0].saved_snapshot;
  if (!snapshot) return bill;
  await refusePendingRequest(client, bill);
  const wanted = [...snapshot.lines];
  for (const line of await liveLines(client, bill.id)) {
    if (line.source === "ordered") continue;
    const at = wanted.findIndex((kept) => snapshotKey(kept) === snapshotKey(line));
    if (at === -1) {
      await dropLineIn(client, bill, line, { removed: true, ...DISCARDED }, ctx);
      continue;
    }
    const [kept] = wanted.splice(at, 1);
    if (!sameManual(line, kept)) await restoreManual(client, "bill_lines", line.id, kept, ctx);
    if (Number(line.quantity) !== kept.quantity) {
      await client.query(
        `UPDATE bill_lines SET quantity = $2, listed_actual = ROUND($2 * rate, 2),
            updated_at = NOW(), updated_by = $3
          WHERE id = $1`,
        [line.id, kept.quantity, ctx?.actorId ?? null],
      );
    }
    const keptRate = kept.agreed_rate ?? null;
    const lineRate = line.agreed_rate === null ? null : Number(line.agreed_rate);
    if (keptRate !== lineRate) {
      await client.query(
        `UPDATE bill_lines SET agreed_rate = $2,
            agreed_by = CASE WHEN $2::numeric IS NULL THEN NULL ELSE $4::int END,
            agreed_at = CASE WHEN $2::numeric IS NULL THEN NULL ELSE agreed_at END,
            updated_at = NOW(), updated_by = $3
          WHERE id = $1`,
        [line.id, keptRate, ctx?.actorId ?? null, kept.agreed_by ?? null],
      );
    }
  }
  const { header } = snapshot;
  const { rows: restored } = await client.query(
    `UPDATE bills SET scheme_code = $2, scheme_label = $3, payer_name = $4, scheme_ref_enc = $5,
        referral_no_enc = $6, referral_doc_id = $7, updated_at = NOW(), updated_by = $8
      WHERE id = $1 RETURNING ${BILL_COLUMNS}`,
    [
      bill.id,
      header.scheme_code,
      header.scheme_label,
      header.payer_name,
      header.scheme_ref_enc,
      header.referral_no_enc,
      header.referral_doc_id,
      ctx?.actorId ?? null,
    ],
  );
  if (!sameManual(restored[0], header)) {
    await restoreManual(client, "bills", bill.id, header, ctx);
  }
  let current = (await client.query(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1`, [bill.id]))
    .rows[0];
  for (const line of wanted) {
    const added = await addLineIn(
      client,
      current,
      {
        item_id: line.service_item_id,
        quantity: line.quantity,
        source: line.source,
        lab_order_id: line.lab_order_id,
        doctor_id: line.doctor_id,
        agreed_rate: line.agreed_rate ?? null,
        agreed_by: line.agreed_by ?? null,
      },
      ctx,
    ).catch((error) => {
      if (error.code === PAID_AT_RECEPTION) return null;
      throw error;
    });
    if (added) {
      current = added.bill;
      if (line.manual_discount_kind) {
        await restoreManual(client, "bill_lines", added.line_id, line, ctx);
      }
    }
  }
  const saved = await reprice(client, current, snapshot.codes, ctx);
  await resettleTestOrders(client, saved.bill, ctx);
  await writeAudit(client, {
    entity: SPEC.table,
    entityId: bill.id,
    action: "update",
    before: bill,
    after: { ...saved.bill, ...DISCARDED },
    ...auditFields(ctx),
  });
  return saved.bill;
}

export async function discardDraft(billId, ctx, db = pool) {
  const id = cleanUuid(billId, "bill");
  return inTransaction(async (client) => {
    const bill = await lockDraftOfVisit(client, id);
    if (!bill.saved_at) return deleteDraftIn(client, bill, DISCARDED, ctx);
    const restored = await restoreSavedIn(client, bill, ctx);
    return withLines(client, restored, { codes: await billCodes(client, bill.id) });
  }, db);
}
