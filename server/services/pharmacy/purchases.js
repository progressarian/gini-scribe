import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { mainLocationId, postMovements } from "./stockLedger.js";
import { purchaseLineAmounts, purchaseTotals, toRupees } from "../../../shared/pharmacyMoney.js";

const ENTITY = "pharmacy_purchases";

const HEADER = `p.id, p.receipt_no, p.kind, p.vendor_id, v.name AS vendor_name, p.invoice_no,
  p.invoice_date, p.location_id, l.name AS location_name, p.status, p.notes, p.taxable_amount,
  p.gst_amount, p.discount_amount, p.net_amount, p.version, p.created_at, p.updated_at,
  p.posted_at, p.cancelled_at, p.cancel_reason,
  (SELECT name FROM doctors d WHERE d.id = p.created_by) AS created_by_name,
  (SELECT name FROM doctors d WHERE d.id = p.posted_by) AS posted_by_name`;

const FROM = `FROM pharmacy_purchases p
  LEFT JOIN pharmacy_vendors v ON v.id = p.vendor_id
  JOIN pharmacy_locations l ON l.id = p.location_id`;

const LINE_FIELDS = [
  "medicine_id",
  "batch_no",
  "expiry_date",
  "mfg_date",
  "qty_packs",
  "free_packs",
  "purchase_rate",
  "discount_pct",
  "gst_rate_pct",
  "mrp",
  "sale_rate",
  "rack_no",
  "vendor_id",
];

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

function friendly(error) {
  if (error?.code === "23505" && error.constraint === "pharmacy_purchases_invoice_key") {
    return httpError(409, "This vendor's invoice number is already recorded on another receipt");
  }
  return error;
}

export async function listPurchases(
  { q, status = "all", kind, vendor_id, limit = 25, offset = 0 } = {},
  db = pool,
) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (status !== "all") add("p.status = ?", status);
  if (kind) add("p.kind = ?", kind);
  if (vendor_id) add("p.vendor_id = ?", vendor_id);
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const p = `$${params.length}`;
    where.push(
      `(lower(p.receipt_no) LIKE ${p} OR lower(coalesce(p.invoice_no, '')) LIKE ${p} OR lower(coalesce(v.name, '')) LIKE ${p})`,
    );
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT ${HEADER},
            (SELECT count(*)::int FROM pharmacy_purchase_lines pl WHERE pl.purchase_id = p.id) AS line_count,
            count(*) OVER()::int AS total
       ${FROM}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY (p.status = 'draft') DESC, p.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

async function loadLines(db, purchaseId) {
  const { rows } = await db.query(
    `SELECT pl.*, m.name AS medicine_name, m.code AS medicine_code, m.pack_size, m.pack_label,
            m.unit_label, m.is_active AS medicine_active, lv.name AS vendor_name
       FROM pharmacy_purchase_lines pl
       JOIN pharmacy_medicines m ON m.id = pl.medicine_id
       LEFT JOIN pharmacy_vendors lv ON lv.id = pl.vendor_id
      WHERE pl.purchase_id = $1
      ORDER BY pl.line_no`,
    [purchaseId],
  );
  return rows;
}

export async function getPurchase(id, db = pool) {
  const { rows } = await db.query(`SELECT ${HEADER} ${FROM} WHERE p.id = $1`, [id]);
  if (!rows.length) throw httpError(404, "Goods receipt not found");
  return { ...rows[0], lines: await loadLines(db, id) };
}

async function lockDraft(client, id, version) {
  const { rows } = await client.query(`SELECT * FROM pharmacy_purchases WHERE id = $1 FOR UPDATE`, [
    id,
  ]);
  if (!rows.length) throw httpError(404, "Goods receipt not found");
  const row = rows[0];
  if (row.version !== version) {
    throw httpError(409, "Someone else changed this receipt. Reload it and make your change again");
  }
  if (row.status !== "draft") {
    throw httpError(409, `This receipt is already ${row.status} and can no longer be changed`);
  }
  return row;
}

async function assertVendor(client, vendorId) {
  if (!vendorId) return;
  const { rows } = await client.query(
    `SELECT name, is_active FROM pharmacy_vendors WHERE id = $1`,
    [vendorId],
  );
  if (!rows.length) throw httpError(400, "Choose a vendor from the list");
  if (!rows[0].is_active) throw httpError(409, `${rows[0].name} is deactivated`);
}

export async function createPurchase({ kind = "purchase", ...input }, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    await assertVendor(client, input.vendor_id);
    const location = await mainLocationId(client);
    const { rows } = await client
      .query(
        `INSERT INTO pharmacy_purchases
           (kind, vendor_id, invoice_no, invoice_date, notes, location_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING id`,
        [
          kind,
          kind === "opening" ? null : (input.vendor_id ?? null),
          input.invoice_no ?? null,
          input.invoice_date ?? null,
          input.notes ?? null,
          location,
          ctx.actorId ?? null,
        ],
      )
      .catch((error) => {
        throw friendly(error);
      });
    const created = await getPurchase(rows[0].id, client);
    await writeAudit(client, {
      entity: ENTITY,
      entityId: created.id,
      action: "create",
      after: created,
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return created;
  }, db);
}

async function assertLines(client, lines) {
  const seen = new Set();
  lines.forEach((l, i) => {
    const key = `${l.medicine_id}|${l.batch_no}|${l.expiry_date}`;
    if (seen.has(key)) {
      throw httpError(400, `Line ${i + 1} repeats a medicine and batch already on this receipt`);
    }
    seen.add(key);
  });
  const ids = [...new Set(lines.map((l) => l.medicine_id))];
  if (!ids.length) return;
  const { rows } = await client.query(
    `SELECT id, name, is_active FROM pharmacy_medicines WHERE id = ANY($1::int[])`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  lines.forEach((l, i) => {
    const m = byId.get(l.medicine_id);
    if (!m) throw httpError(400, `Line ${i + 1}: choose a medicine from the list`);
    if (!m.is_active) throw httpError(409, `Line ${i + 1}: ${m.name} is deactivated`);
  });
}

export async function updatePurchase(id, { version, lines, ...input }, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const row = await lockDraft(client, id, version);
    const before = await getPurchase(id, client);
    if (row.kind === "purchase") await assertVendor(client, input.vendor_id);
    await assertLines(client, lines);
    const totals = purchaseTotals(lines);

    await client
      .query(
        `UPDATE pharmacy_purchases
            SET vendor_id = $1, invoice_no = $2, invoice_date = $3, notes = $4,
                taxable_amount = $5, gst_amount = $6, discount_amount = $7, net_amount = $8,
                version = version + 1, updated_by = $9, updated_at = NOW()
          WHERE id = $10`,
        [
          row.kind === "opening" ? null : (input.vendor_id ?? null),
          input.invoice_no ?? null,
          input.invoice_date ?? null,
          input.notes ?? null,
          toRupees(totals.taxable),
          toRupees(totals.gst),
          toRupees(totals.discount),
          toRupees(totals.total),
          ctx.actorId ?? null,
          id,
        ],
      )
      .catch((error) => {
        throw friendly(error);
      });

    await client.query(`DELETE FROM pharmacy_purchase_lines WHERE purchase_id = $1`, [id]);
    if (lines.length) {
      const records = lines.map((l, i) => {
        const a = purchaseLineAmounts(l);
        return {
          ...Object.fromEntries(LINE_FIELDS.map((f) => [f, l[f] ?? null])),
          line_no: i + 1,
          taxable_amount: toRupees(a.taxable),
          discount_amount: toRupees(a.discount),
          gst_amount: toRupees(a.gst),
          line_total: toRupees(a.total),
        };
      });
      await client.query(
        `INSERT INTO pharmacy_purchase_lines
           (purchase_id, line_no, ${LINE_FIELDS.join(", ")},
            taxable_amount, discount_amount, gst_amount, line_total)
         SELECT $1, x.line_no, ${LINE_FIELDS.map((f) => `x.${f}`).join(", ")},
                x.taxable_amount, x.discount_amount, x.gst_amount, x.line_total
           FROM jsonb_to_recordset($2::jsonb) AS x(
             line_no int, medicine_id int, batch_no text, expiry_date date, mfg_date date,
             qty_packs int, free_packs int, purchase_rate numeric, discount_pct numeric,
             gst_rate_pct numeric, mrp numeric, sale_rate numeric, rack_no text, vendor_id int,
             taxable_amount numeric, discount_amount numeric, gst_amount numeric, line_total numeric)`,
        [id, JSON.stringify(records)],
      );
    }

    const after = await getPurchase(id, client);
    await writeAudit(client, {
      entity: ENTITY,
      entityId: id,
      action: "update",
      before,
      after,
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return after;
  }, db);
}

function assertReadyToPost(purchase) {
  const problems = [];
  if (purchase.kind === "purchase") {
    if (!purchase.vendor_id) problems.push("choose the vendor");
    if (!purchase.invoice_no) problems.push("enter the invoice number");
    if (!purchase.invoice_date) problems.push("enter the invoice date");
    else if (purchase.invoice_date > today())
      problems.push("the invoice date cannot be in the future");
  }
  if (!purchase.lines.length) problems.push("add at least one medicine");
  const expired = purchase.lines.filter((l) => l.expiry_date <= today());
  if (expired.length) {
    problems.push(`remove expired stock (line ${expired.map((l) => l.line_no).join(", ")})`);
  }
  const inactive = purchase.lines.filter((l) => !l.medicine_active);
  if (inactive.length) {
    problems.push(`${inactive.map((l) => l.medicine_name).join(", ")} is deactivated`);
  }
  if (problems.length) {
    throw httpError(409, `Before posting: ${problems.join("; ")}`);
  }
}

async function batchFor(client, line, purchase, ctx) {
  const { rows: created } = await client.query(
    `INSERT INTO pharmacy_batches
       (medicine_id, batch_no, expiry_date, mfg_date, pack_size, mrp, sale_rate, purchase_rate,
        gst_rate_pct, rack_no, vendor_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (medicine_id, batch_no, expiry_date) DO NOTHING
     RETURNING id`,
    [
      line.medicine_id,
      line.batch_no,
      line.expiry_date,
      line.mfg_date,
      line.pack_size,
      line.mrp,
      line.sale_rate,
      line.purchase_rate,
      line.gst_rate_pct,
      line.rack_no,
      line.vendor_id ?? purchase.vendor_id,
      ctx.actorId ?? null,
    ],
  );
  if (created.length) return created[0].id;
  const { rows } = await client.query(
    `SELECT id, mrp, sale_rate, pack_size, rack_no FROM pharmacy_batches
      WHERE medicine_id = $1 AND batch_no = $2 AND expiry_date = $3
      FOR UPDATE`,
    [line.medicine_id, line.batch_no, line.expiry_date],
  );
  const batch = rows[0];
  if (Number(batch.mrp) !== Number(line.mrp)) {
    throw httpError(
      409,
      `Line ${line.line_no}: batch ${line.batch_no} of ${line.medicine_name} is already in stock with MRP ₹${batch.mrp}. Check the invoice`,
    );
  }
  if (Number(batch.sale_rate) !== Number(line.sale_rate)) {
    throw httpError(
      409,
      `Line ${line.line_no}: batch ${line.batch_no} of ${line.medicine_name} is already sold at ₹${batch.sale_rate} a pack. Use the same sale rate for the same batch`,
    );
  }
  if (batch.pack_size !== line.pack_size) {
    throw httpError(
      409,
      `Line ${line.line_no}: batch ${line.batch_no} of ${line.medicine_name} was received as ${batch.pack_size} per pack, but the medicine now says ${line.pack_size}`,
    );
  }
  if (line.rack_no && line.rack_no !== batch.rack_no) {
    await client.query(`UPDATE pharmacy_batches SET rack_no = $1 WHERE id = $2`, [
      line.rack_no,
      batch.id,
    ]);
  }
  return batch.id;
}

export async function postPurchase(id, { version }, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    await lockDraft(client, id, version);
    const purchase = await getPurchase(id, client);
    assertReadyToPost(purchase);

    const movements = [];
    for (const line of purchase.lines) {
      const batchId = await batchFor(client, line, purchase, ctx);
      await client.query(`UPDATE pharmacy_purchase_lines SET batch_id = $1 WHERE id = $2`, [
        batchId,
        line.id,
      ]);
      movements.push({
        locationId: purchase.location_id,
        batchId,
        delta: (line.qty_packs + line.free_packs) * line.pack_size,
        kind: purchase.kind,
        refType: ENTITY,
        refId: id,
      });
    }
    await postMovements(client, movements, ctx);

    await client.query(
      `UPDATE pharmacy_purchases
          SET status = 'posted', posted_by = $1, posted_at = NOW(), version = version + 1,
              updated_by = $1, updated_at = NOW()
        WHERE id = $2`,
      [ctx.actorId ?? null, id],
    );
    const after = await getPurchase(id, client);
    await writeAudit(client, {
      entity: ENTITY,
      entityId: id,
      action: "approve",
      before: { status: "draft" },
      after: { status: "posted", net_amount: after.net_amount, lines: after.lines.length },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return after;
  }, db);
}

export async function cancelPurchase(id, { version, reason }, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    await lockDraft(client, id, version);
    await client.query(
      `UPDATE pharmacy_purchases
          SET status = 'cancelled', cancel_reason = $1, cancelled_by = $2, cancelled_at = NOW(),
              version = version + 1, updated_by = $2, updated_at = NOW()
        WHERE id = $3`,
      [reason, ctx.actorId ?? null, id],
    );
    const after = await getPurchase(id, client);
    await writeAudit(client, {
      entity: ENTITY,
      entityId: id,
      action: "cancel",
      before: { status: "draft" },
      after: { status: "cancelled", reason },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return after;
  }, db);
}
