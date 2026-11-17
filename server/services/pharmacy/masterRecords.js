import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";

export function masterRecords({
  table,
  noun,
  fields,
  duplicates = {},
  searchColumns,
  prepare,
  listColumns = "",
  orderBy = "is_active DESC, lower(name)",
  guardUpdate,
  guardActive,
  readOnly = [],
}) {
  const row = `id, ${[...fields, ...readOnly].join(", ")}, is_active, version, created_at, updated_at`;
  const prepared = (input) => (prepare ? prepare(input) : input);
  const shape = (input) => {
    const values = prepared(input);
    return fields.map((f) => values[f] ?? null);
  };

  const friendly = (error) =>
    error?.code === "23505" && duplicates[error.constraint]
      ? httpError(409, duplicates[error.constraint])
      : error;

  const lock = async (client, id) => {
    const { rows } = await client.query(`SELECT ${row} FROM ${table} WHERE id = $1 FOR UPDATE`, [
      id,
    ]);
    if (!rows.length) throw httpError(404, `That ${noun} no longer exists`);
    return rows[0];
  };

  const audit = (client, ctx, entry) =>
    writeAudit(client, { entity: table, actorId: ctx.actorId, ip: ctx.ip, ...entry });

  async function list(
    { q, status = "active", limit = 50, offset = 0, filters = [] } = {},
    db = pool,
  ) {
    const where = [];
    const params = [];
    if (status !== "all") {
      params.push(status === "active");
      where.push(`is_active = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      const p = `$${params.length}`;
      where.push(
        `(${searchColumns.map((c) => `lower(coalesce(${c}, '')) LIKE ${p}`).join(" OR ")})`,
      );
    }
    for (const { sql, value } of filters) {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    }
    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT ${row}${listColumns ? `, ${listColumns}` : ""}, count(*) OVER()::int AS total
         FROM ${table} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ${orderBy}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
  }

  async function get(id, db = pool) {
    const { rows } = await db.query(`SELECT ${row} FROM ${table} WHERE id = $1`, [id]);
    if (!rows.length) throw httpError(404, `${noun[0].toUpperCase()}${noun.slice(1)} not found`);
    return rows[0];
  }

  async function create(input, ctx = {}, db = pool) {
    return inTransaction(async (client) => {
      const values = prepared(input);
      const columns = fields.filter((f) => values[f] !== undefined);
      const { rows } = await client
        .query(
          `INSERT INTO ${table} (${columns.join(", ")}, created_by, updated_by)
           VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}, $${columns.length + 1}, $${columns.length + 1})
           RETURNING ${row}`,
          [...columns.map((f) => values[f]), ctx.actorId ?? null],
        )
        .catch((error) => {
          throw friendly(error);
        });
      await audit(client, ctx, { entityId: rows[0].id, action: "create", after: rows[0] });
      return rows[0];
    }, db);
  }

  async function update(id, { version, ...input }, ctx = {}, db = pool) {
    return inTransaction(async (client) => {
      const before = await lock(client, id);
      if (before.version !== version) {
        throw httpError(
          409,
          `Someone else changed this ${noun}. Reload it and make your change again`,
        );
      }
      guardUpdate?.(before, prepared(input));
      const { rows } = await client
        .query(
          `UPDATE ${table}
              SET ${fields.map((f, i) => `${f} = $${i + 1}`).join(", ")},
                  version = version + 1, updated_by = $${fields.length + 1}, updated_at = NOW()
            WHERE id = $${fields.length + 2}
            RETURNING ${row}`,
          [...shape(input), ctx.actorId ?? null, id],
        )
        .catch((error) => {
          throw friendly(error);
        });
      await audit(client, ctx, { entityId: id, action: "update", before, after: rows[0] });
      return rows[0];
    }, db);
  }

  async function setActive(id, isActive, ctx = {}, db = pool) {
    return inTransaction(async (client) => {
      const before = await lock(client, id);
      if (before.is_active === isActive) return before;
      guardActive?.(before, isActive);
      const { rows } = await client.query(
        `UPDATE ${table}
            SET is_active = $1, version = version + 1, updated_by = $2, updated_at = NOW()
          WHERE id = $3
          RETURNING ${row}`,
        [isActive, ctx.actorId ?? null, id],
      );
      await audit(client, ctx, {
        entityId: id,
        action: isActive ? "activate" : "deactivate",
        before,
        after: rows[0],
      });
      return rows[0];
    }, db);
  }

  return { list, get, create, update, setActive };
}
