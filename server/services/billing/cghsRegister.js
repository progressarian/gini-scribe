import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import { paise, rupeesFromPaise } from "../../../shared/labPayment.js";
import { CLAIM_BILLS_AT_ONCE, claimSubtotals } from "../../../shared/claimsRegister.js";
import { writeAudit, writeAuditMany } from "./audit.js";
import { maskTail } from "./bills.js";
import { indiaToday } from "./categoryResolver.js";
import { auditFields, cleanDate, cleanMoney, wholeNumber } from "./common.js";
import { settleTestOrders } from "./payments.js";
import { httpError, inTransaction } from "./transaction.js";

export const REGISTER_TABS = ["pending", "cleared"];
export const ROW_LIMIT = 2000;
export const BILLS_AT_ONCE = CLAIM_BILLS_AT_ONCE;
export const REFERENCE_MAX = 60;
export const NOTE_MAX = 1000;
export const FILTER_TEXT_MAX = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rupees = (amount) => `₹${(amount / 100).toFixed(2)}`;

const billName = (bill) => `Bill ${bill.bill_no}`;

const BASE_SQL = `
  SELECT b.id, b.bill_no, b.bill_date, b.bill_date::text AS bill_day, b.patient_id,
         p.name AS patient_name, p.file_no AS uhid, b.scheme_code, b.scheme_label, b.payer_name,
         b.referral_no_enc, b.claim_status, b.claim_settlement_id, b.version,
         b.claim_amount AS billed_claim,
         COALESCE(cn.claim, 0) AS credited_claim,
         b.claim_amount - COALESCE(cn.claim, 0) AS claim,
         doc.id AS doctor_id, doc.name AS doctor_name,
         COALESCE(codes.bill_codes, '{}') AS bill_codes,
         COALESCE(s.received_on, (NOW() AT TIME ZONE 'Asia/Kolkata')::date) - b.bill_date
           AS days_pending,
         s.id AS settlement_id, s.received_on::text AS received_on, s.reference,
         s.amount AS settlement_amount, s.note AS settlement_note, s.cleared_at,
         s.cleared_by, cb.name AS cleared_by_name, sb.amount AS cleared_amount
    FROM bills b
    JOIN patients p ON p.id = b.patient_id
    LEFT JOIN appointments a ON a.id = b.appointment_id
    LEFT JOIN giniflow_visits v ON v.id = b.visit_id
    LEFT JOIN LATERAL (
      SELECT SUM(c.claim_amount) AS claim FROM bills c
       WHERE c.original_bill_id = b.id AND c.bill_type = 'credit_note' AND c.status = 'final'
    ) cn ON TRUE
    LEFT JOIN LATERAL (
      SELECT l.doctor_id FROM bill_lines l
       WHERE l.bill_id = b.id AND l.credited_line_id IS NULL AND l.doctor_id IS NOT NULL
       ORDER BY l.line_no, l.id LIMIT 1
    ) ld ON TRUE
    LEFT JOIN doctors doc ON doc.id = COALESCE(ld.doctor_id, a.doctor_id, v.assigned_doctor_id)
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT l.bill_code ORDER BY l.bill_code) AS bill_codes
        FROM bill_lines l
       WHERE l.bill_id = b.id AND l.credited_line_id IS NULL AND l.bill_code IS NOT NULL
         AND l.claim_amount > COALESCE(
           (SELECT SUM(x.claim_amount) FROM bill_lines x WHERE x.credited_line_id = l.id), 0)
    ) codes ON TRUE
    LEFT JOIN claim_settlements s ON s.id = b.claim_settlement_id
    LEFT JOIN doctors cb ON cb.id = s.cleared_by
    LEFT JOIN claim_settlement_bills sb
      ON sb.settlement_id = s.id AND sb.bill_id = b.id AND sb.voided_at IS NULL
   WHERE b.bill_type = 'invoice' AND b.status = 'final' AND b.claim_status = $1`;

const FILTERED_SQL = `
  WITH register AS (${BASE_SQL})
  SELECT * FROM register
   WHERE ($2::date IS NULL OR bill_date >= $2::date)
     AND ($3::date IS NULL OR bill_date <= $3::date)
     AND ($4::text IS NULL OR scheme_code = $4)
     AND ($5::int IS NULL OR doctor_id = $5)
     AND ($6::text IS NULL OR payer_name = $6)
     AND ($7::text IS NULL OR reference ILIKE '%' || $7 || '%' ESCAPE '\\')`;

const ORDER = {
  pending: "bill_date, bill_no",
  cleared: "received_on DESC, reference, bill_date, bill_no",
};

function optionalText(value, label, max = FILTER_TEXT_MAX) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw httpError(400, `${label} must be text`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max)
    throw httpError(400, `${label} is too long — keep it under ${max} letters`);
  return text;
}

export function cleanFilters(input = {}) {
  const from = cleanDate(input.from, "From");
  const to = cleanDate(input.to, "To");
  if (from && to && from > to) throw httpError(400, "From must be on or before To");
  const doctor =
    input.doctor_id === "" ? undefined : wholeNumber(input.doctor_id, "Doctor", { min: 1 });
  return {
    from,
    to,
    category: optionalText(input.category, "Sub-category"),
    doctorId: doctor ?? null,
    payer: optionalText(input.payer, "Payer"),
    reference: optionalText(input.reference, "Reference", REFERENCE_MAX),
  };
}

const filterParams = (tab, f) => [
  tab,
  f.from,
  f.to,
  f.category,
  f.doctorId,
  f.payer,
  tab === "cleared" && f.reference ? f.reference.replace(/[\\%_]/g, "\\$&") : null,
];

function shapeRow(row) {
  return {
    bill_id: row.id,
    bill_no: row.bill_no,
    bill_date: row.bill_day,
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    uhid: row.uhid,
    category: row.scheme_code,
    category_label: row.scheme_label,
    payer_name: row.payer_name,
    doctor_id: row.doctor_id,
    doctor_name: row.doctor_name,
    bill_codes: row.bill_codes ?? [],
    referral_no: maskTail(row.referral_no_enc),
    billed_claim: paise(row.billed_claim),
    credited: paise(row.credited_claim),
    claim: paise(row.claim),
    days_pending: Number(row.days_pending),
    claim_status: row.claim_status,
    version: row.version,
    settlement: row.settlement_id
      ? {
          id: row.settlement_id,
          received_on: row.received_on,
          reference: row.reference,
          amount: paise(row.cleared_amount),
          total: paise(row.settlement_amount),
          note: row.settlement_note,
          cleared_by: row.cleared_by,
          cleared_by_name: row.cleared_by_name,
          cleared_at: row.cleared_at,
        }
      : null,
  };
}

async function optionsFor(db, tab) {
  const { rows } = await db.query(
    `WITH register AS (${BASE_SQL})
     SELECT 'category' AS kind, scheme_code AS value, MAX(scheme_label) AS label
       FROM register WHERE scheme_code IS NOT NULL GROUP BY scheme_code
     UNION ALL
     SELECT 'doctor', doctor_id::text, MAX(doctor_name)
       FROM register WHERE doctor_id IS NOT NULL GROUP BY doctor_id
     UNION ALL
     SELECT 'payer', payer_name, payer_name
       FROM register WHERE payer_name IS NOT NULL GROUP BY payer_name`,
    [tab],
  );
  const of = (kind) =>
    rows
      .filter((row) => row.kind === kind)
      .map((row) => ({ value: row.value, label: row.label ?? row.value }))
      .sort((a, b) => a.label.localeCompare(b.label));
  return {
    categories: of("category"),
    doctors: of("doctor").map((d) => ({ ...d, value: Number(d.value) })),
    payers: of("payer"),
  };
}

async function listRegister(tab, input, db) {
  const filters = cleanFilters(input);
  const params = filterParams(tab, filters);
  const { rows } = await db.query(
    `${FILTERED_SQL} ORDER BY ${ORDER[tab]} LIMIT ${ROW_LIMIT}`,
    params,
  );
  const { rows: sums } = await db.query(
    `WITH filtered AS (${FILTERED_SQL})
     SELECT COUNT(*)::int AS count, COALESCE(SUM(claim), 0) AS amount FROM filtered`,
    params,
  );
  const count = sums[0].count;
  return {
    tab,
    filters,
    rows: rows.map(shapeRow),
    totals: { count, amount: paise(sums[0].amount) },
    truncated: count > rows.length,
    options: await optionsFor(db, tab),
  };
}

export const listPending = (filters = {}, db = pool) => listRegister("pending", filters, db);

export const listCleared = (filters = {}, db = pool) => listRegister("cleared", filters, db);

function cleanBillIds(value) {
  if (!Array.isArray(value) || !value.length) throw httpError(400, "Choose the bills to clear");
  if (value.length > BILLS_AT_ONCE) {
    throw httpError(400, `At most ${BILLS_AT_ONCE} bills can be cleared at once`);
  }
  const ids = value.map((id) => (typeof id === "string" ? id.trim().toLowerCase() : ""));
  if (ids.some((id) => !UUID.test(id))) throw httpError(400, "Choose valid bills to clear");
  if (new Set(ids).size !== ids.length) throw httpError(400, "A bill is chosen twice");
  return ids;
}

function cleanReference(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw httpError(400, "Enter the payment's reference (UTR)");
  if (text.length > REFERENCE_MAX) {
    throw httpError(400, `The reference is too long — keep it under ${REFERENCE_MAX} letters`);
  }
  return text;
}

function cleanNote(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw httpError(400, `${label} must be text`);
  const text = value.trim();
  if (text.length > NOTE_MAX) {
    throw httpError(400, `${label} is too long — keep it under ${NOTE_MAX} letters`);
  }
  return text || null;
}

function cleanClear(input) {
  const receivedOn = cleanDate(input?.received_on, "Date received");
  if (!receivedOn) throw httpError(400, "Enter the date the money was received");
  if (receivedOn > indiaToday()) throw httpError(400, "The date received can't be in the future");
  const amount = paise(cleanMoney(input?.amount, "The amount received"));
  if (amount <= 0) throw httpError(400, "The amount received must be more than zero");
  return {
    billIds: cleanBillIds(input?.bill_ids),
    receivedOn,
    reference: cleanReference(input?.reference),
    amount,
    note: cleanNote(input?.note, "The note"),
  };
}

async function lockClaimBills(client, ids) {
  const { rows } = await client.query(
    `SELECT b.id, b.bill_no, b.bill_date::text AS bill_date, b.bill_type, b.status,
            b.claim_status, b.claim_settlement_id, b.claim_amount, b.payer_name, b.version,
            b.patient_id, b.visit_id
       FROM bills b WHERE b.id = ANY($1::uuid[]) ORDER BY b.id FOR UPDATE`,
    [ids],
  );
  if (rows.length !== ids.length) {
    throw httpError(404, "One of the chosen bills no longer exists — open the register again");
  }
  const { rows: credits } = await client.query(
    `SELECT original_bill_id AS id, SUM(claim_amount) AS claim FROM bills
      WHERE original_bill_id = ANY($1::uuid[]) AND bill_type = 'credit_note' AND status = 'final'
      GROUP BY original_bill_id`,
    [ids],
  );
  const credited = new Map(credits.map((row) => [row.id, paise(row.claim)]));
  return rows.map((row) => ({
    ...row,
    claim: paise(row.claim_amount) - (credited.get(row.id) ?? 0),
  }));
}

async function settlementOf(client, id) {
  const { rows } = await client.query(
    `SELECT id, reference, received_on::text AS received_on FROM claim_settlements WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function refuseUnclearable(client, bills) {
  for (const bill of bills) {
    if (bill.bill_type !== "invoice") {
      throw httpError(409, `${billName(bill)} is a credit note, not a bill with a claim`);
    }
    if (bill.status === "cancelled") throw httpError(409, `${billName(bill)} is cancelled`);
    if (bill.status !== "final") {
      throw httpError(409, "One of the chosen bills is still a draft, so it has no claim yet");
    }
    if (bill.claim_status === "cleared") {
      const paid = await settlementOf(client, bill.claim_settlement_id);
      throw httpError(
        409,
        `${billName(bill)} is already cleared${paid ? ` (reference ${paid.reference}, received ${paid.received_on})` : ""}`,
        { bill_id: bill.id, bill_no: bill.bill_no },
      );
    }
    if (bill.claim_status !== "pending" || bill.claim <= 0) {
      throw httpError(409, `${billName(bill)} has no claim pending`, {
        bill_id: bill.id,
        bill_no: bill.bill_no,
      });
    }
  }
}

function onePayer(bills) {
  const unnamed = bills.find((bill) => !bill.payer_name);
  if (unnamed) throw httpError(409, `${billName(unnamed)} has no payer to clear it against`);
  const payers = [...new Set(bills.map((bill) => bill.payer_name))];
  if (payers.length > 1) {
    throw httpError(
      409,
      `These bills are claimed from different payers (${payers.join(", ")}) — clear each payer's bills separately`,
    );
  }
  return payers[0];
}

function refuseMismatch(bills, amount) {
  const expected = bills.reduce((sum, bill) => sum + bill.claim, 0);
  if (amount === expected) return expected;
  const difference = amount - expected;
  const count = bills.length === 1 ? "claim" : `${bills.length} claims`;
  throw httpError(
    409,
    `The amount received (${rupees(amount)}) doesn't match the selected ${count} (${rupees(expected)}) — difference ${rupees(Math.abs(difference))} ${difference > 0 ? "more" : "less"} than claimed. CGHS pays each claim in full, so check the amount and the bills chosen`,
    { expected, received: amount, difference },
  );
}

function refuseEarlyReceipt(bills, receivedOn) {
  const late = bills.find((bill) => bill.bill_date > receivedOn);
  if (late) {
    throw httpError(
      409,
      `${billName(late)} is dated ${late.bill_date}, so its money can't have been received on ${receivedOn}`,
    );
  }
}

function shapeSettlement(row, bills = []) {
  return {
    id: row.id,
    payer_name: row.payer_name,
    received_on: row.received_on,
    reference: row.reference,
    amount: paise(row.amount),
    note: row.note,
    cleared_by: row.cleared_by,
    cleared_at: row.cleared_at,
    voided_at: row.voided_at,
    voided_by: row.voided_by,
    void_reason: row.void_reason,
    bills,
  };
}

const SETTLEMENT_COLUMNS = `id, payer_name, received_on::text AS received_on, reference, amount,
  note, cleared_by, cleared_at, voided_at, voided_by, void_reason`;

export async function clearBills(input, ctx, db = pool) {
  const wanted = cleanClear(input);
  return inTransaction(async (client) => {
    const bills = await lockClaimBills(client, wanted.billIds);
    await refuseUnclearable(client, bills);
    const payer = onePayer(bills);
    refuseEarlyReceipt(bills, wanted.receivedOn);
    refuseMismatch(bills, wanted.amount);
    const actor = ctx?.actorId ?? null;
    const { rows } = await client.query(
      `INSERT INTO claim_settlements (payer_name, received_on, reference, amount, note,
                                      cleared_by, created_by, updated_by)
       VALUES ($1, $2::date, $3, $4, $5, $6, $6, $6)
       RETURNING ${SETTLEMENT_COLUMNS}`,
      [
        payer,
        wanted.receivedOn,
        wanted.reference,
        rupeesFromPaise(wanted.amount),
        wanted.note,
        actor,
      ],
    );
    const settlement = rows[0];
    await client.query(
      `INSERT INTO claim_settlement_bills (settlement_id, bill_id, amount, created_by, updated_by)
       SELECT $1, x.bill_id, x.amount, $4, $4
         FROM unnest($2::uuid[], $3::numeric[]) AS x(bill_id, amount)`,
      [
        settlement.id,
        bills.map((bill) => bill.id),
        bills.map((bill) => rupeesFromPaise(bill.claim)),
        actor,
      ],
    );
    const { rows: cleared } = await client.query(
      `UPDATE bills
          SET claim_status = 'cleared', claim_settlement_id = $2, version = version + 1,
              updated_at = NOW(), updated_by = $3
        WHERE id = ANY($1::uuid[]) AND claim_status = 'pending'
        RETURNING id, bill_no, claim_status, claim_settlement_id, version`,
      [bills.map((bill) => bill.id), settlement.id, actor],
    );
    if (cleared.length !== bills.length) {
      throw httpError(409, "A chosen bill changed while it was being cleared — try again");
    }
    const orders = [];
    for (const bill of bills) orders.push(...(await settleTestOrders(client, bill, ctx)));
    const shaped = bills.map((bill) => ({
      bill_id: bill.id,
      bill_no: bill.bill_no,
      amount: bill.claim,
    }));
    await writeAudit(client, {
      entity: "claim_settlements",
      entityId: settlement.id,
      action: "create",
      after: { ...settlement, bills: shaped },
      ...auditFields(ctx),
    });
    const after = new Map(cleared.map((row) => [row.id, row]));
    await writeAuditMany(
      client,
      bills.map((bill) => ({
        entity: "bills",
        entityId: bill.id,
        action: "update",
        before: {
          claim_status: bill.claim_status,
          claim_settlement_id: bill.claim_settlement_id,
          version: bill.version,
        },
        after: after.get(bill.id),
      })),
      auditFields(ctx),
    );
    return { ...shapeSettlement(settlement, shaped), orders };
  }, db);
}

function cleanSettlementId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID.test(id)) throw httpError(400, "Choose a valid payment");
  return id;
}

export async function undoClear(settlementId, input, ctx, db = pool) {
  const id = cleanSettlementId(settlementId);
  const reason = cleanNote(input?.reason, "The reason");
  if (!reason) throw httpError(400, "Say why this payment is being undone");
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT ${SETTLEMENT_COLUMNS} FROM claim_settlements WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!rows.length) throw httpError(404, "That payment no longer exists");
    const settlement = rows[0];
    if (settlement.voided_at) {
      throw httpError(409, `The payment ${settlement.reference} has already been undone`);
    }
    const { rows: links } = await client.query(
      `SELECT bill_id, amount FROM claim_settlement_bills
        WHERE settlement_id = $1 AND voided_at IS NULL`,
      [id],
    );
    const bills = await lockClaimBills(
      client,
      links.map((link) => link.bill_id),
    );
    const stray = bills.find(
      (bill) => bill.claim_status !== "cleared" || bill.claim_settlement_id !== id,
    );
    if (stray) {
      throw httpError(
        409,
        `${billName(stray)} is no longer cleared by this payment, so it can't be undone here`,
      );
    }
    const actor = ctx?.actorId ?? null;
    const { rows: pending } = await client.query(
      `UPDATE bills
          SET claim_status = 'pending', claim_settlement_id = NULL, version = version + 1,
              updated_at = NOW(), updated_by = $2
        WHERE id = ANY($1::uuid[])
        RETURNING id, bill_no, claim_status, claim_settlement_id, version`,
      [bills.map((bill) => bill.id), actor],
    );
    await client.query(
      `UPDATE claim_settlement_bills SET voided_at = NOW(), updated_at = NOW(), updated_by = $2
        WHERE settlement_id = $1 AND voided_at IS NULL`,
      [id, actor],
    );
    const { rows: voided } = await client.query(
      `UPDATE claim_settlements
          SET voided_at = NOW(), voided_by = $2, void_reason = $3, updated_at = NOW(),
              updated_by = $2
        WHERE id = $1
        RETURNING ${SETTLEMENT_COLUMNS}`,
      [id, actor, reason],
    );
    const shaped = links.map((link) => ({
      bill_id: link.bill_id,
      bill_no: bills.find((bill) => bill.id === link.bill_id)?.bill_no ?? null,
      amount: paise(link.amount),
    }));
    await writeAudit(client, {
      entity: "claim_settlements",
      entityId: id,
      action: "cancel",
      before: { ...settlement, bills: shaped },
      after: voided[0],
      ...auditFields(ctx),
    });
    const after = new Map(pending.map((row) => [row.id, row]));
    await writeAuditMany(
      client,
      bills.map((bill) => ({
        entity: "bills",
        entityId: bill.id,
        action: "update",
        before: {
          claim_status: bill.claim_status,
          claim_settlement_id: bill.claim_settlement_id,
          version: bill.version,
        },
        after: after.get(bill.id),
      })),
      auditFields(ctx),
    );
    return shapeSettlement(voided[0], shaped);
  }, db);
}

export async function readSettlement(settlementId, db = pool) {
  const id = cleanSettlementId(settlementId);
  const { rows } = await db.query(
    `SELECT ${SETTLEMENT_COLUMNS} FROM claim_settlements WHERE id = $1`,
    [id],
  );
  if (!rows.length) throw httpError(404, "That payment no longer exists");
  const { rows: links } = await db.query(
    `SELECT sb.bill_id, b.bill_no, sb.amount, sb.voided_at
       FROM claim_settlement_bills sb JOIN bills b ON b.id = sb.bill_id
      WHERE sb.settlement_id = $1 ORDER BY b.bill_no`,
    [id],
  );
  return shapeSettlement(
    rows[0],
    links.map((link) => ({
      bill_id: link.bill_id,
      bill_no: link.bill_no,
      amount: paise(link.amount),
      voided_at: link.voided_at,
    })),
  );
}

const rupeeCell = (amount) => rupeesFromPaise(amount);

const PENDING_COLUMNS = [
  { header: "Bill number", key: "bill_no", width: 20 },
  { header: "Bill date", key: "bill_date", width: 12 },
  { header: "Patient", key: "patient_name", width: 28 },
  { header: "UHID", key: "uhid", width: 14 },
  { header: "Sub-category", key: "category_label", width: 26 },
  { header: "Doctor", key: "doctor_name", width: 24 },
  { header: "Bill codes", key: "bill_codes", width: 18 },
  { header: "Referral number", key: "referral_no", width: 16 },
  { header: "Payer", key: "payer_name", width: 26 },
  { header: "Claim (₹)", key: "claim", width: 14, style: { numFmt: "#,##0.00" } },
  { header: "Days pending", key: "days_pending", width: 13 },
];

const CLEARED_COLUMNS = [
  ...PENDING_COLUMNS.slice(0, -1),
  { header: "Days to clear", key: "days_pending", width: 13 },
  { header: "Date received", key: "received_on", width: 14 },
  { header: "Reference", key: "reference", width: 24 },
  { header: "Cleared by", key: "cleared_by_name", width: 22 },
];

const sheetRow = (row) => ({
  ...row,
  bill_codes: row.bill_codes.join(", "),
  claim: rupeeCell(row.claim),
  received_on: row.settlement?.received_on ?? null,
  reference: row.settlement?.reference ?? null,
  cleared_by_name: row.settlement?.cleared_by_name ?? null,
});

function addSheet(workbook, name, columns, rows) {
  const ws = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  for (const row of rows) ws.addRow(row);
  return ws;
}

function addTotal(ws, label, totals) {
  const row = ws.addRow({ bill_no: label, claim: rupeeCell(totals.amount) });
  row.font = { bold: true };
  row.getCell("patient_name").value = `${totals.count} bill${totals.count === 1 ? "" : "s"}`;
}

function addSubtotals(workbook, rows) {
  const ws = workbook.addWorksheet("By sub-category and doctor");
  ws.columns = [
    { header: "Sub-category", key: "category", width: 28 },
    { header: "Doctor", key: "doctor", width: 26 },
    { header: "Bills", key: "count", width: 8 },
    { header: "Claim (₹)", key: "amount", width: 14, style: { numFmt: "#,##0.00" } },
  ];
  ws.getRow(1).font = { bold: true };
  for (const group of claimSubtotals(rows)) {
    for (const doctor of group.doctors) {
      ws.addRow({
        category: group.label,
        doctor: doctor.label,
        count: doctor.count,
        amount: rupeeCell(doctor.amount),
      });
    }
    const subtotal = ws.addRow({
      category: `${group.label} — subtotal`,
      count: group.count,
      amount: rupeeCell(group.amount),
    });
    subtotal.font = { bold: true };
  }
  return ws;
}

export async function exportRegister(tab, filters = {}, db = pool) {
  if (!REGISTER_TABS.includes(tab)) {
    throw httpError(400, `The register has two lists: ${REGISTER_TABS.join(", ")}`);
  }
  const list = await listRegister(tab, filters, db);
  if (list.truncated) {
    throw httpError(
      409,
      `The ${tab} list has ${list.totals.count} bills, more than the ${ROW_LIMIT} a file can hold — narrow the filters`,
    );
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Gini Scribe";
  const title = tab === "pending" ? "Pending claims" : "Cleared claims";
  const ws = addSheet(
    workbook,
    title,
    tab === "pending" ? PENDING_COLUMNS : CLEARED_COLUMNS,
    list.rows.map(sheetRow),
  );
  addTotal(ws, "Total", list.totals);
  if (tab === "pending") addSubtotals(workbook, list.rows);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    buffer,
    fileName: `cghs-${tab}-${indiaToday()}.xlsx`,
    totals: list.totals,
  };
}
