import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { createBill, finaliseBill, getBill, updateBill } from "./bills.js";
import { DUE_SQL } from "./billDue.js";
import { createSaleReturn, returnedUnits } from "./saleReturns.js";

const HEADER = `i.id, i.indent_no, i.location_id, l.name AS location_name, i.patient_id,
  p.name AS patient_name, p.file_no AS patient_file_no, i.ipd_number, i.notes, i.raised_at,
  (SELECT name FROM doctors d WHERE d.id = i.raised_by) AS raised_by_name,
  i.bill_id, b.bill_no, b.net_amount, b.paid_amount, ${DUE_SQL} AS due_amount,
  (SELECT count(*)::int FROM pharmacy_bill_lines bl WHERE bl.bill_id = b.id) AS line_count`;

const FROM = `FROM pharmacy_indents i
  JOIN pharmacy_locations l ON l.id = i.location_id
  JOIN patients p ON p.id = i.patient_id
  JOIN pharmacy_bills b ON b.id = i.bill_id`;

export async function listIndents({ location_id, q, limit = 25, offset = 0 } = {}, db = pool) {
  const where = [];
  const params = [limit, offset];
  if (location_id) {
    params.push(location_id);
    where.push(`i.location_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const $ = `$${params.length}`;
    where.push(
      `(lower(p.name) LIKE ${$} OR lower(COALESCE(p.file_no, '')) LIKE ${$}
        OR lower(i.indent_no) LIKE ${$} OR lower(COALESCE(i.ipd_number, '')) LIKE ${$})`,
    );
  }
  const { rows } = await db.query(
    `SELECT ${HEADER}, count(*) OVER()::int AS total
       ${FROM}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY i.raised_at DESC, i.id DESC
      LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

export async function getIndent(id, db = pool) {
  const { rows } = await db.query(`SELECT ${HEADER} ${FROM} WHERE i.id = $1`, [id]);
  if (!rows.length) throw httpError(404, "Indent not found");
  return {
    ...rows[0],
    bill: await getBill(rows[0].bill_id, db),
    returned_units: Object.fromEntries(await returnedUnits(db, rows[0].bill_id)),
  };
}

export async function returnIndent(id, input, ctx = {}, db = pool) {
  const { rows } = await db.query(`SELECT bill_id FROM pharmacy_indents WHERE id = $1`, [id]);
  if (!rows.length) throw httpError(404, "Indent not found");
  await createSaleReturn(rows[0].bill_id, { ...input, refund: { mode: "cash" } }, ctx, db, {
    dueOnly: true,
  });
  return getIndent(id, db);
}

export async function createIndent(input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const { rows: places } = await client.query(
      `SELECT id, name, kind, is_active FROM pharmacy_locations WHERE id = $1`,
      [input.location_id],
    );
    const place = places[0];
    if (!place) throw httpError(400, "Choose the department from the list");
    if (place.kind !== "department") {
      throw httpError(
        400,
        "Indents are issued from a department's own stock, not the main pharmacy",
      );
    }
    if (!place.is_active) throw httpError(409, `${place.name} is deactivated`);

    const draft = await createBill(
      {
        patient_id: input.patient_id,
        sale_type: "indent",
        visit_id: null,
        location_id: place.id,
        ipd_number: input.ipd_number ?? null,
      },
      ctx,
      client,
    );
    const priced = await updateBill(
      draft.id,
      {
        version: draft.version,
        sale_type: "indent",
        ipd_number: input.ipd_number ?? null,
        notes: input.notes ?? null,
        lines: input.lines,
      },
      ctx,
      client,
    );
    const bill = await finaliseBill(
      draft.id,
      { version: priced.version, payments: [] },
      ctx,
      client,
      { allDue: true, movementKind: "indent_issue" },
    );
    const { rows } = await client.query(
      `INSERT INTO pharmacy_indents (location_id, patient_id, ipd_number, bill_id, notes, raised_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, indent_no`,
      [
        place.id,
        input.patient_id,
        input.ipd_number ?? null,
        bill.id,
        input.notes ?? null,
        ctx.actorId ?? null,
      ],
    );
    await writeAudit(client, {
      entity: "pharmacy_indents",
      entityId: String(rows[0].id),
      action: "create",
      after: {
        indent_no: rows[0].indent_no,
        location: place.name,
        bill_no: bill.bill_no,
        net_amount: bill.net_amount,
      },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return getIndent(rows[0].id, client);
  }, db);
}
