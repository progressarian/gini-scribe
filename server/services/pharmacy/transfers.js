import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { postMovements } from "./stockLedger.js";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const HEADER = `t.id, t.transfer_no, t.from_location_id, f.name AS from_location_name,
  f.kind AS from_kind, t.to_location_id, l.name AS to_location_name, l.kind AS to_kind,
  t.notes, t.issued_at, (SELECT name FROM doctors d WHERE d.id = t.issued_by) AS issued_by_name`;

const FROM = `FROM pharmacy_transfers t
  JOIN pharmacy_locations f ON f.id = t.from_location_id
  JOIN pharmacy_locations l ON l.id = t.to_location_id`;

export async function listTransfers({ location_id, limit = 25, offset = 0 } = {}, db = pool) {
  const params = [limit, offset];
  let where = "TRUE";
  if (location_id) {
    params.push(location_id);
    where = "(t.from_location_id = $3 OR t.to_location_id = $3)";
  }
  const { rows } = await db.query(
    `SELECT ${HEADER},
            (SELECT count(*)::int FROM pharmacy_transfer_lines tl WHERE tl.transfer_id = t.id) AS line_count,
            (SELECT COALESCE(SUM(tl.qty_units), 0)::int FROM pharmacy_transfer_lines tl
              WHERE tl.transfer_id = t.id) AS units,
            count(*) OVER()::int AS total
       ${FROM}
      WHERE ${where}
      ORDER BY t.issued_at DESC, t.id DESC
      LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

export async function getTransfer(id, db = pool) {
  const { rows } = await db.query(`SELECT ${HEADER} ${FROM} WHERE t.id = $1`, [id]);
  if (!rows.length) throw httpError(404, "Stock transfer not found");
  const { rows: lines } = await db.query(
    `SELECT tl.id, tl.line_no, tl.medicine_id, m.name AS medicine_name, m.pack_size, m.pack_label,
            m.unit_label, tl.batch_id, b.batch_no, b.expiry_date, b.rack_no, tl.qty_units
       FROM pharmacy_transfer_lines tl
       JOIN pharmacy_medicines m ON m.id = tl.medicine_id
       JOIN pharmacy_batches b ON b.id = tl.batch_id
      WHERE tl.transfer_id = $1
      ORDER BY tl.line_no`,
    [id],
  );
  return { ...rows[0], lines };
}

async function activeLocation(client, id, role) {
  const { rows } = await client.query(
    `SELECT id, name, kind, is_active FROM pharmacy_locations WHERE id = $1`,
    [id],
  );
  if (!rows.length) throw httpError(400, `Choose the ${role} location from the list`);
  if (!rows[0].is_active) throw httpError(409, `${rows[0].name} is deactivated`);
  return rows[0];
}

export async function createTransfer(input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    if (input.from_location_id === input.to_location_id) {
      throw httpError(400, "Stock has to move between two different locations");
    }
    const from = await activeLocation(client, input.from_location_id, "from");
    const to = await activeLocation(client, input.to_location_id, "to");
    if (from.kind !== "main" && to.kind !== "main") {
      throw httpError(400, "Stock moves between the main pharmacy and a department");
    }
    const ids = input.lines.map((l) => l.batch_id);
    if (new Set(ids).size !== ids.length) {
      throw httpError(400, "The same batch is on two lines. Put the whole quantity on one line");
    }
    const { rows: batches } = await client.query(
      `SELECT b.id, b.medicine_id, b.batch_no, b.expiry_date, m.name AS medicine_name
         FROM pharmacy_batches b JOIN pharmacy_medicines m ON m.id = b.medicine_id
        WHERE b.id = ANY($1::int[])`,
      [ids],
    );
    const byId = new Map(batches.map((b) => [b.id, b]));
    for (const line of input.lines) {
      const batch = byId.get(line.batch_id);
      if (!batch) throw httpError(400, "One of the batches no longer exists");
      if (batch.expiry_date <= today() && to.kind !== "main") {
        throw httpError(
          409,
          `${batch.medicine_name} batch ${batch.batch_no} has expired and cannot be sent to a department`,
        );
      }
    }
    const { rows } = await client.query(
      `INSERT INTO pharmacy_transfers (from_location_id, to_location_id, notes, issued_by)
       VALUES ($1, $2, $3, $4) RETURNING id, transfer_no`,
      [from.id, to.id, input.notes ?? null, ctx.actorId ?? null],
    );
    const transfer = rows[0];
    await client.query(
      `INSERT INTO pharmacy_transfer_lines (transfer_id, line_no, medicine_id, batch_id, qty_units)
       SELECT $1, x.line_no, b.medicine_id, x.batch_id, x.qty_units
         FROM jsonb_to_recordset($2::jsonb) AS x(line_no int, batch_id int, qty_units int)
         JOIN pharmacy_batches b ON b.id = x.batch_id`,
      [transfer.id, JSON.stringify(input.lines.map((l, i) => ({ line_no: i + 1, ...l })))],
    );
    const ref = { refType: "pharmacy_transfers", refId: transfer.id, reason: input.notes ?? null };
    await postMovements(
      client,
      input.lines.flatMap((l) => [
        {
          locationId: from.id,
          batchId: l.batch_id,
          delta: -l.qty_units,
          kind: "transfer_out",
          ...ref,
        },
        { locationId: to.id, batchId: l.batch_id, delta: l.qty_units, kind: "transfer_in", ...ref },
      ]),
      ctx,
    );
    await writeAudit(client, {
      entity: "pharmacy_transfers",
      entityId: String(transfer.id),
      action: "create",
      after: {
        transfer_no: transfer.transfer_no,
        from: from.name,
        to: to.name,
        lines: input.lines,
      },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return getTransfer(transfer.id, client);
  }, db);
}
