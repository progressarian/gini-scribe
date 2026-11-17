import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { nextNumber } from "../billing/billNumber.js";
import { mainLocationId, postMovements } from "./stockLedger.js";
import { BALANCE_SQL, recordBillPayments } from "./accounts.js";
import { getPharmacySettings } from "./settings.js";
import { getBillPatient } from "./billPatients.js";
import { DUE_SQL, PATIENT_DUE_SQL } from "./billDue.js";
import { canonicalMedKey } from "../medication/normalize.js";
import { appointmentFor, markCollection } from "../medication/collection.js";
import {
  applyDiscounts,
  discountOf,
  pharmacyBillTotals,
  pricePharmacyLine,
  undiscountedOf,
} from "../../../shared/pharmacyPricing.js";
import { toPaise, toRupees } from "../../../shared/pharmacyMoney.js";
import {
  GST_FOLDED_SALE_TYPES,
  PAYMENT_MODE_LABEL,
  PHARMACY_SERIES,
  splitUnits,
} from "../../../shared/pharmacyVocab.js";

const ENTITY = "pharmacy_bills";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const HEADER = `b.id, b.bill_no, b.bill_type, b.original_bill_id, b.sale_type, b.gst_folded,
  b.sale_rate_includes_gst, b.patient_id, b.visit_id, b.location_id, l.name AS location_name,
  b.ipd_number, b.prescriber_name, b.bill_date, b.status, b.gross_amount, b.taxable_amount,
  b.cgst_amount, b.sgst_amount, b.folded_gst_amount, b.round_off, b.net_amount, b.paid_amount,
  b.pay_later, b.due_adjusted, b.discount_kind, b.discount_value, b.discount_amount,
  (SELECT max_discount_pct FROM pharmacy_settings WHERE id) AS max_discount_pct, ${DUE_SQL} AS due_amount, b.issued_legal_name, b.issued_gstin, b.issued_drug_license, b.notes, b.version,
  b.created_at, b.updated_at, b.finalised_at, b.cancelled_at, b.cancel_reason,
  p.name AS patient_name, p.file_no AS patient_file_no, p.phone AS patient_phone,
  ${PATIENT_DUE_SQL("p.id")} AS patient_due, ${BALANCE_SQL("p.id")} AS patient_balance, p.age AS patient_age, p.sex AS patient_sex, p.registration_source AS patient_source,
  (SELECT o.bill_no FROM pharmacy_bills o WHERE o.id = b.original_bill_id) AS original_bill_no,
  (SELECT name FROM doctors d WHERE d.id = b.created_by) AS created_by_name,
  (SELECT name FROM doctors d WHERE d.id = b.finalised_by) AS finalised_by_name`;

const FROM = `FROM pharmacy_bills b
  JOIN patients p ON p.id = b.patient_id
  JOIN pharmacy_locations l ON l.id = b.location_id`;

const rupees = (paise) => toRupees(paise);

export async function listBills(
  { q, status = "all", sale_type, from, to, limit = 25, offset = 0 } = {},
  db = pool,
) {
  const where = ["b.bill_type = 'invoice'"];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (status !== "all") add("b.status = ?", status);
  if (sale_type) add("b.sale_type = ?", sale_type);
  if (from) add("b.bill_date >= ?::date", from);
  if (to) add("b.bill_date <= ?::date", to);
  if (q) {
    add(
      `(lower(coalesce(b.bill_no, '')) LIKE ? OR lower(p.name) LIKE ?
        OR lower(coalesce(p.file_no, '')) LIKE ? OR lower(coalesce(b.ipd_number, '')) LIKE ?)`,
      `%${q.toLowerCase()}%`,
    );
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT ${HEADER},
            (SELECT count(*)::int FROM pharmacy_bill_lines bl WHERE bl.bill_id = b.id) AS line_count,
            count(*) OVER()::int AS total
       ${FROM}
      WHERE ${where.join(" AND ")}
      ORDER BY (b.status = 'draft') DESC, COALESCE(b.finalised_at, b.created_at) DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

async function loadLines(db, billId) {
  const { rows } = await db.query(
    `SELECT bl.id, bl.line_no, bl.medicine_id, bl.batch_id, bl.medicine_name, bl.batch_no,
            bl.expiry_date, bl.hsn_code, bl.schedule, bl.rack_no, bl.pack_size, bl.unit_label,
            m.pack_label, m.allow_loose_sale, bl.qty_units, bl.pack_mrp, bl.pack_sale_rate,
            bl.gst_rate_pct, bl.tax_rate_pct, bl.gross_amount, bl.mrp_amount, bl.mrp_capped,
            bl.taxable, bl.cgst, bl.sgst, bl.folded_gst, bl.total, bl.discount_pct,
            bl.discount_amount, bl.bill_discount,
            (bl.near_expiry_ok_by IS NOT NULL) AS near_expiry_ok
       FROM pharmacy_bill_lines bl
       JOIN pharmacy_medicines m ON m.id = bl.medicine_id
      WHERE bl.bill_id = $1
      ORDER BY bl.line_no`,
    [billId],
  );
  return rows;
}

async function loadPayments(db, billId) {
  const { rows } = await db.query(
    `SELECT pp.id, pp.direction, pp.mode, pp.amount, pp.reference, pp.upi_app, pp.receipt_no,
            pp.received_at, d.name AS received_by_name
       FROM pharmacy_payments pp
       LEFT JOIN doctors d ON d.id = pp.received_by
      WHERE pp.bill_id = $1
      ORDER BY pp.received_at, pp.receipt_no, pp.id`,
    [billId],
  );
  return rows;
}

async function loadCredit(db, billId) {
  const { rows } = await db.query(
    `SELECT r.id, r.status, r.amount, r.approved_amount, r.reason, r.decision_note,
            r.requested_at, r.decided_at,
            (SELECT name FROM doctors d WHERE d.id = r.requested_by) AS requested_by_name,
            (SELECT name FROM doctors d WHERE d.id = r.decided_by) AS decided_by_name
       FROM pharmacy_credit_requests r
      WHERE r.bill_id = $1
      ORDER BY r.requested_at DESC LIMIT 1`,
    [billId],
  );
  return rows[0] ?? null;
}

export async function getBill(id, db = pool) {
  const { rows } = await db.query(`SELECT ${HEADER} ${FROM} WHERE b.id = $1`, [id]);
  if (!rows.length) throw httpError(404, "Pharmacy bill not found");
  return {
    ...rows[0],
    lines: await loadLines(db, id),
    payments: await loadPayments(db, id),
    credit: await loadCredit(db, id),
  };
}

async function openCredit(client, billId) {
  const { rows } = await client.query(
    `SELECT * FROM pharmacy_credit_requests
      WHERE bill_id = $1 AND status IN ('pending', 'approved') FOR UPDATE`,
    [billId],
  );
  return rows[0] ?? null;
}

async function assertNoOpenCredit(client, billId) {
  const credit = await openCredit(client, billId);
  if (credit?.status === "pending") {
    throw httpError(
      409,
      "A credit request for this bill is waiting for approval. Withdraw it before changing the bill",
    );
  }
  if (credit?.status === "approved") {
    throw httpError(
      409,
      "Credit was approved for this bill as it stands. Withdraw the approval before changing the bill",
    );
  }
}

async function lockDraft(client, id, version) {
  const { rows } = await client.query(`SELECT * FROM pharmacy_bills WHERE id = $1 FOR UPDATE`, [
    id,
  ]);
  if (!rows.length) throw httpError(404, "Pharmacy bill not found");
  const row = rows[0];
  if (row.version !== version) {
    throw httpError(409, "Someone else changed this bill. Reload it and make your change again");
  }
  if (row.status !== "draft") {
    throw httpError(409, `This bill is already ${row.status} and can no longer be changed`);
  }
  return row;
}

async function assertVisit(client, visitId, patientId) {
  if (!visitId) return;
  const { rows } = await client.query(`SELECT patient_id FROM giniflow_visits WHERE id = $1`, [
    visitId,
  ]);
  if (!rows.length || rows[0].patient_id !== patientId) {
    throw httpError(400, "That visit does not belong to this patient");
  }
}

export async function createBill(input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const patient = await getBillPatient(input.patient_id, client);
    if (!patient) throw httpError(400, "Choose a patient from the list");
    const visitId = input.visit_id === undefined ? patient.today_visit_id : input.visit_id;
    await assertVisit(client, visitId, patient.id);
    if (visitId) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('pharmacy_bill_visit:' || $1))`, [
        visitId,
      ]);
      const { rows: open } = await client.query(
        `SELECT id FROM pharmacy_bills
          WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice' AND sale_type = $2
          ORDER BY created_at LIMIT 1`,
        [visitId, input.sale_type],
      );
      if (open.length) return getBill(open[0].id, client);
    }
    const location = input.location_id ?? (await mainLocationId(client));
    const { rows } = await client.query(
      `INSERT INTO pharmacy_bills
         (sale_type, gst_folded, patient_id, visit_id, location_id, ipd_number, prescriber_name,
          created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING id`,
      [
        input.sale_type,
        GST_FOLDED_SALE_TYPES.includes(input.sale_type),
        patient.id,
        visitId ?? null,
        location,
        input.ipd_number ?? null,
        input.prescriber_name ?? null,
        ctx.actorId ?? null,
      ],
    );
    const bill = await getBill(rows[0].id, client);
    await writeAudit(client, {
      entity: ENTITY,
      entityId: bill.id,
      action: "create",
      after: { sale_type: bill.sale_type, patient_id: bill.patient_id, visit_id: bill.visit_id },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return bill;
  }, db).catch(friendly);
}

async function batchesFor(client, locationId, batchIds) {
  const { rows } = await client.query(
    `SELECT b.id, b.medicine_id, b.batch_no, b.expiry_date, b.pack_size, b.mrp, b.sale_rate,
            b.gst_rate_pct, b.rack_no, m.name AS medicine_name, m.hsn_code, m.schedule,
            m.unit_label, m.allow_loose_sale, m.is_active,
            COALESCE(s.qty_units, 0) AS qty_units
       FROM pharmacy_batches b
       JOIN pharmacy_medicines m ON m.id = b.medicine_id
       LEFT JOIN pharmacy_stock s ON s.batch_id = b.id AND s.location_id = $1
      WHERE b.id = ANY($2::int[])`,
    [locationId, batchIds],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

function checkLine(line, batch, settings, { forFinal = false } = {}) {
  if (!batch) throw httpError(400, "One of the batches on this bill no longer exists");
  const label = `${batch.medicine_name} (batch ${batch.batch_no})`;
  if (!batch.is_active) throw httpError(409, `${batch.medicine_name} is deactivated`);
  const left = daysBetween(today(), batch.expiry_date);
  if (left <= 0) {
    throw httpError(409, `${label} expired on ${batch.expiry_date} and cannot be sold`);
  }
  if (left <= settings.near_expiry_warn_days && !line.near_expiry_ok) {
    throw httpError(
      409,
      `${label} expires in ${left} day${left === 1 ? "" : "s"}. Confirm the near-expiry batch on that line before billing it`,
      { batch_id: batch.id, near_expiry: true },
    );
  }
  if (!batch.allow_loose_sale && line.qty_units % batch.pack_size !== 0) {
    throw httpError(
      400,
      `${batch.medicine_name} is sold in whole packs of ${batch.pack_size} ${batch.unit_label}`,
    );
  }
  if (!forFinal && line.qty_units > batch.qty_units) {
    throw httpError(
      409,
      `Only ${batch.qty_units} ${batch.unit_label} of ${label} are in stock, ${line.qty_units} asked for`,
    );
  }
}

function pricedLine(line, batch, { gstFolded, includesGst }) {
  return pricePharmacyLine({
    packSaleRate: batch.sale_rate,
    packMrp: batch.mrp,
    packSize: batch.pack_size,
    qtyUnits: line.qty_units,
    gstRatePct: batch.gst_rate_pct,
    saleRateIncludesGst: includesGst,
    gstFolded,
  });
}

export async function updateBill(id, input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const before = await lockDraft(client, id, input.version);
    await assertNoOpenCredit(client, id);
    const settings = await getPharmacySettings(client);
    const saleType = input.sale_type ?? before.sale_type;
    const gstFolded = GST_FOLDED_SALE_TYPES.includes(saleType);
    const includesGst = settings.sale_rate_includes_gst;
    const seen = new Set();
    for (const line of input.lines) {
      if (seen.has(line.batch_id)) {
        throw httpError(400, "The same batch is on two lines. Put the whole quantity on one line");
      }
      seen.add(line.batch_id);
    }
    const batches = await batchesFor(client, before.location_id, [...seen]);
    const priced = input.lines.map((line, i) => {
      const batch = batches.get(line.batch_id);
      checkLine(line, batch, settings);
      const price = pricedLine(line, batch, { gstFolded, includesGst });
      if (price.total <= 0 || price.mrpAmount <= 0) {
        throw httpError(
          400,
          `${line.qty_units} ${batch.unit_label} of ${batch.medicine_name} is too small to bill. Sell more units or a whole pack`,
        );
      }
      return { line, batch, price, no: i + 1 };
    });
    const discountKind =
      input.discount_kind === undefined ? before.discount_kind : input.discount_kind;
    const discountValue =
      input.discount_value === undefined ? before.discount_value : input.discount_value;
    const hasBillDiscount = Boolean(discountKind) && Number(discountValue) > 0;
    const maxPct = settings.max_discount_pct === null ? null : Number(settings.max_discount_pct);
    for (const { line, batch } of priced) {
      if (maxPct !== null && Number(line.discount_pct ?? 0) > maxPct) {
        throw httpError(
          409,
          `The discount on ${batch.medicine_name} is ${Number(line.discount_pct)}%; the most allowed is ${maxPct}%`,
        );
      }
    }
    if (
      hasBillDiscount &&
      discountKind === "percent" &&
      maxPct !== null &&
      Number(discountValue) > maxPct
    ) {
      throw httpError(
        409,
        `The bill discount is ${Number(discountValue)}%; the most allowed is ${maxPct}%`,
      );
    }
    const discounted = applyDiscounts(
      priced.map(({ line, batch, price }) => ({
        price,
        discountPct: line.discount_pct ?? 0,
        gstRatePct: batch.gst_rate_pct,
        gstFolded,
      })),
      hasBillDiscount ? { kind: discountKind, value: discountValue } : {},
    );
    const fullPrice = undiscountedOf(discounted);
    const discountTotal = discountOf(discounted);
    if (maxPct !== null && fullPrice && discountTotal * 100 > maxPct * fullPrice) {
      throw httpError(
        409,
        `Discounts come to ${((discountTotal * 100) / fullPrice).toFixed(2)}% of this bill; the most allowed is ${maxPct}%`,
      );
    }
    discounted.forEach((price, i) => {
      if (price.total <= 0) {
        throw httpError(
          400,
          `The discount leaves nothing to charge for ${priced[i].batch.medicine_name}`,
        );
      }
      priced[i].price = price;
    });
    const totals = pharmacyBillTotals(priced.map((p) => p.price));

    await client.query(`DELETE FROM pharmacy_bill_lines WHERE bill_id = $1`, [id]);
    if (priced.length) {
      await client.query(
        `INSERT INTO pharmacy_bill_lines
           (bill_id, line_no, medicine_id, batch_id, medicine_name, batch_no, expiry_date,
            hsn_code, schedule, rack_no, pack_size, unit_label, qty_units, pack_mrp,
            pack_sale_rate, gst_rate_pct, tax_rate_pct, gross_amount, mrp_amount, mrp_capped,
            taxable, cgst, sgst, folded_gst, total, near_expiry_ok_by, created_by,
            discount_pct, discount_amount, bill_discount)
         SELECT $1, x.line_no, x.medicine_id, x.batch_id, x.medicine_name, x.batch_no,
                x.expiry_date, x.hsn_code, x.schedule, x.rack_no, x.pack_size, x.unit_label,
                x.qty_units, x.pack_mrp, x.pack_sale_rate, x.gst_rate_pct, x.tax_rate_pct,
                x.gross_amount, x.mrp_amount, x.mrp_capped, x.taxable, x.cgst, x.sgst,
                x.folded_gst, x.total, CASE WHEN x.near_expiry_ok THEN $2::int END, $2,
                x.discount_pct, x.discount_amount, x.bill_discount
           FROM jsonb_to_recordset($3::jsonb) AS x(
                line_no int, medicine_id int, batch_id int, medicine_name text, batch_no text,
                expiry_date date, hsn_code text, schedule text, rack_no text, pack_size int,
                unit_label text, qty_units int, pack_mrp numeric, pack_sale_rate numeric,
                gst_rate_pct numeric, tax_rate_pct numeric, gross_amount numeric,
                mrp_amount numeric, mrp_capped boolean, taxable numeric, cgst numeric,
                sgst numeric, folded_gst numeric, total numeric, near_expiry_ok boolean,
                discount_pct numeric, discount_amount numeric, bill_discount numeric)`,
        [
          id,
          ctx.actorId ?? null,
          JSON.stringify(
            priced.map(({ line, batch, price, no }) => ({
              line_no: no,
              medicine_id: batch.medicine_id,
              batch_id: batch.id,
              medicine_name: batch.medicine_name,
              batch_no: batch.batch_no,
              expiry_date: batch.expiry_date,
              hsn_code: batch.hsn_code,
              schedule: batch.schedule,
              rack_no: batch.rack_no,
              pack_size: batch.pack_size,
              unit_label: batch.unit_label,
              qty_units: line.qty_units,
              pack_mrp: batch.mrp,
              pack_sale_rate: batch.sale_rate,
              gst_rate_pct: batch.gst_rate_pct,
              tax_rate_pct: price.taxRatePct,
              gross_amount: rupees(price.gross),
              mrp_amount: rupees(price.mrpAmount),
              mrp_capped: price.mrpCapped,
              taxable: rupees(price.taxable),
              cgst: rupees(price.cgst),
              sgst: rupees(price.sgst),
              folded_gst: rupees(price.foldedGst),
              total: rupees(price.total),
              near_expiry_ok: Boolean(line.near_expiry_ok),
              discount_pct: Number(line.discount_pct ?? 0),
              discount_amount: rupees(price.discount ?? 0),
              bill_discount: rupees(price.billDiscount ?? 0),
            })),
          ),
        ],
      );
    }
    await client.query(
      `UPDATE pharmacy_bills
          SET sale_type = $2, gst_folded = $3, sale_rate_includes_gst = $4, ipd_number = $5,
              prescriber_name = $6, notes = $7, gross_amount = $8, taxable_amount = $9,
              cgst_amount = $10, sgst_amount = $11, folded_gst_amount = $12, round_off = $13,
              net_amount = $14, version = version + 1, updated_by = $15, updated_at = NOW(),
              discount_kind = $16, discount_value = $17, discount_amount = $18,
              discount_by = CASE WHEN $18::numeric > 0 THEN $15::int END
        WHERE id = $1`,
      [
        id,
        saleType,
        gstFolded,
        includesGst,
        input.ipd_number === undefined ? before.ipd_number : input.ipd_number,
        input.prescriber_name === undefined ? before.prescriber_name : input.prescriber_name,
        input.notes === undefined ? before.notes : input.notes,
        rupees(totals.gross),
        rupees(totals.taxable),
        rupees(totals.cgst),
        rupees(totals.sgst),
        rupees(totals.foldedGst),
        rupees(totals.roundOff),
        rupees(totals.net),
        ctx.actorId ?? null,
        hasBillDiscount ? discountKind : null,
        hasBillDiscount ? discountValue : null,
        rupees(discountTotal),
      ],
    );
    return getBill(id, client);
  }, db).catch(friendly);
}

function friendly(error) {
  if (error?.constraint === "pharmacy_bills_ipd_number") {
    throw httpError(400, "Enter the IPD number for an IPD sale");
  }
  throw error;
}

const paymentLabel = (p) =>
  `${PAYMENT_MODE_LABEL[p.mode]} ₹${toRupees(toPaise(p.amount))}${p.reference ? ` (${p.reference})` : ""}`;

export async function finaliseBill(
  id,
  { version, payments },
  ctx = {},
  db = pool,
  { allDue = false, movementKind = "sale" } = {},
) {
  return inTransaction(async (client) => {
    const bill = await lockDraft(client, id, version);
    const lines = await loadLines(client, id);
    if (!lines.length) throw httpError(409, "Add at least one medicine before finalising");
    const settings = await getPharmacySettings(client);
    const batches = await batchesFor(
      client,
      bill.location_id,
      lines.map((l) => l.batch_id),
    );
    for (const line of lines)
      checkLine(line, batches.get(line.batch_id), settings, { forFinal: true });

    const net = toPaise(bill.net_amount);
    const credit = await openCredit(client, id);
    if (credit?.status === "pending") {
      throw httpError(409, "The credit request for this bill is still waiting for approval");
    }
    const allowed = allDue
      ? toPaise(bill.net_amount)
      : credit
        ? toPaise(credit.approved_amount)
        : 0;
    const paid = payments.reduce((sum, p) => sum + toPaise(p.amount), 0);
    if (paid > net) {
      throw httpError(
        409,
        `₹${toRupees(paid - net)} more than the bill total of ₹${toRupees(net)} was entered`,
      );
    }
    if (net - paid > allowed) {
      throw httpError(
        409,
        allowed
          ? `Collect at least ₹${toRupees(net - allowed)} now. ₹${toRupees(allowed)} of credit was approved on a bill of ₹${toRupees(net)}`
          : `₹${toRupees(net - paid)} is still to be collected. The bill total is ₹${toRupees(net)}`,
      );
    }
    const payLater = paid < net;

    await postMovements(
      client,
      lines.map((l) => ({
        locationId: bill.location_id,
        batchId: l.batch_id,
        delta: -l.qty_units,
        kind: movementKind,
        refType: ENTITY,
        refId: id,
      })),
      ctx,
    );

    const billDate = today();
    const number = await nextNumber(client, PHARMACY_SERIES.bill, billDate, ctx);
    const { rows: issuer } = await client.query(
      `SELECT COALESCE(ps.legal_name, bs.legal_name) AS legal_name,
              COALESCE(ps.gstin, bs.gstin) AS gstin, ps.drug_license_no
         FROM pharmacy_settings ps LEFT JOIN billing_settings bs ON TRUE
        WHERE ps.id LIMIT 1`,
    );
    await recordBillPayments(
      client,
      { billId: id, patientId: bill.patient_id, payments, day: billDate },
      ctx,
    );
    await client.query(
      `UPDATE pharmacy_bills
          SET status = 'final', bill_no = $2, series = $3, fy = $4, bill_date = $5,
              paid_amount = $6, pay_later = $11, issued_legal_name = $7, issued_gstin = $8,
              issued_drug_license = $9, finalised_by = $10, finalised_at = NOW(),
              updated_by = $10, updated_at = NOW(), version = version + 1
        WHERE id = $1`,
      [
        id,
        number.number,
        number.series,
        number.fy,
        billDate,
        toRupees(paid),
        issuer[0]?.legal_name ?? null,
        issuer[0]?.gstin ?? null,
        issuer[0]?.drug_license_no ?? null,
        ctx.actorId ?? null,
        payLater,
      ],
    );
    if (credit) {
      await client.query(
        `UPDATE pharmacy_credit_requests SET status = 'used', used_at = NOW() WHERE id = $1`,
        [credit.id],
      );
    }
    const after = await getBill(id, client);
    const marked = await markDispensed(client, after, lines, ctx);
    await writeAudit(client, {
      entity: ENTITY,
      entityId: id,
      action: "approve",
      before: { status: "draft", net_amount: bill.net_amount },
      after: {
        status: "final",
        bill_no: after.bill_no,
        net_amount: after.net_amount,
        payments: payments.map(paymentLabel),
        ...(payLater ? { due: toRupees(net - paid), credit_request_id: credit?.id ?? null } : {}),
        dispensed_medications: marked,
        lines: lines.map((l) => ({
          batch_id: l.batch_id,
          qty: splitUnits(l.qty_units, l.pack_size),
          total: l.total,
        })),
      },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return after;
  }, db);
}

async function markDispensed(client, bill, lines, ctx) {
  if (!bill.visit_id) return [];
  const { rows: visits } = await client.query(
    `SELECT id, patient_id, visit_date::text AS visit_date, appointment_id
       FROM giniflow_visits WHERE id = $1 AND current_status = 'pharmacy_pending'`,
    [bill.visit_id],
  );
  if (!visits.length) return [];
  const visit = visits[0];
  const { rows: medications } = await client.query(
    `SELECT id, name, pharmacy_match FROM medications
      WHERE patient_id = $1 AND is_active AND external_doctor IS NULL`,
    [visit.patient_id],
  );
  const { rows: keyed } = await client.query(
    `SELECT id, medicine_key FROM pharmacy_medicines WHERE id = ANY($1::int[])`,
    [[...new Set(lines.map((l) => l.medicine_id))]],
  );
  const units = new Map();
  for (const line of lines) {
    const key = keyed.find((k) => k.id === line.medicine_id)?.medicine_key;
    if (!key) continue;
    const entry = units.get(key) ?? { qty: 0, unit: line.unit_label };
    units.set(key, { ...entry, qty: entry.qty + line.qty_units });
  }
  const appointmentId =
    visit.appointment_id || (await appointmentFor(client, visit.patient_id, visit.visit_date));
  const marked = [];
  for (const medication of medications) {
    const key = [canonicalMedKey(medication.pharmacy_match), canonicalMedKey(medication.name)].find(
      (k) => k && units.has(k),
    );
    if (!key) continue;
    const { qty, unit } = units.get(key);
    await markCollection(client, {
      medicationId: medication.id,
      patientId: visit.patient_id,
      appointmentId,
      date: visit.visit_date,
      status: "given",
      qtyNote: `${qty} ${unit} on bill ${bill.bill_no}`,
      markedBy: ctx.actorName ?? null,
    });
    marked.push(medication.id);
  }
  return marked;
}

export async function discardBill(id, { version }, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const bill = await lockDraft(client, id, version);
    await assertNoOpenCredit(client, id);
    await client.query(`DELETE FROM pharmacy_bills WHERE id = $1`, [id]);
    await writeAudit(client, {
      entity: ENTITY,
      entityId: id,
      action: "delete",
      before: { status: bill.status, patient_id: bill.patient_id, net_amount: bill.net_amount },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return { id, discarded: true };
  }, db);
}
