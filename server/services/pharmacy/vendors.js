import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";

const ENTITY = "pharmacy_vendors";

const FIELDS = [
  "name",
  "contact_person",
  "phone",
  "alt_phone",
  "email",
  "address",
  "city",
  "state",
  "pincode",
  "gstin",
  "pan",
  "drug_license_no",
  "drug_license_expiry",
  "payment_terms_days",
  "bank_name",
  "bank_account",
  "ifsc",
  "notes",
];

const ROW = `id, ${FIELDS.join(", ")}, is_active, version, created_at, updated_at`;

const DUPLICATES = {
  pharmacy_vendors_name_key: "A vendor with this name already exists",
  pharmacy_vendors_gstin_key: "A vendor with this GSTIN already exists",
};

function friendlyDuplicate(error) {
  if (error?.code === "23505" && DUPLICATES[error.constraint]) {
    return httpError(409, DUPLICATES[error.constraint]);
  }
  return error;
}

async function lockVendor(client, id) {
  const { rows } = await client.query(`SELECT ${ROW} FROM ${ENTITY} WHERE id = $1 FOR UPDATE`, [
    id,
  ]);
  if (!rows.length) throw httpError(404, "That vendor no longer exists");
  return rows[0];
}

function assertVersion(row, version) {
  if (row.version !== version) {
    throw httpError(409, "Someone else changed this vendor. Reload it and make your change again");
  }
}

export async function listVendors(
  { q, status = "active", limit = 50, offset = 0 } = {},
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
      `(lower(name) LIKE ${p} OR lower(coalesce(contact_person, '')) LIKE ${p}
        OR phone LIKE ${p} OR lower(coalesce(gstin, '')) LIKE ${p} OR lower(coalesce(city, '')) LIKE ${p})`,
    );
  }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT ${ROW}, count(*) OVER()::int AS total
       FROM ${ENTITY} ${filter}
      ORDER BY is_active DESC, lower(name)
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    vendors: rows.map(({ total, ...vendor }) => vendor),
    total: rows[0]?.total ?? 0,
  };
}

export async function getVendor(id, db = pool) {
  const { rows } = await db.query(`SELECT ${ROW} FROM ${ENTITY} WHERE id = $1`, [id]);
  if (!rows.length) throw httpError(404, "Vendor not found");
  return rows[0];
}

export async function createVendor(input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const values = FIELDS.map((f) => input[f] ?? null);
    values[FIELDS.indexOf("payment_terms_days")] = input.payment_terms_days ?? 0;
    const { rows } = await client
      .query(
        `INSERT INTO ${ENTITY} (${FIELDS.join(", ")}, created_by, updated_by)
         VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(", ")}, $${FIELDS.length + 1}, $${FIELDS.length + 1})
         RETURNING ${ROW}`,
        [...values, ctx.actorId ?? null],
      )
      .catch((error) => {
        throw friendlyDuplicate(error);
      });
    await writeAudit(client, {
      entity: ENTITY,
      entityId: rows[0].id,
      action: "create",
      after: rows[0],
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return rows[0];
  }, db);
}

export async function updateVendor(id, { version, ...input }, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const before = await lockVendor(client, id);
    assertVersion(before, version);
    const values = FIELDS.map((f) => input[f] ?? null);
    values[FIELDS.indexOf("payment_terms_days")] = input.payment_terms_days ?? 0;
    const { rows } = await client
      .query(
        `UPDATE ${ENTITY}
            SET ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(", ")},
                version = version + 1, updated_by = $${FIELDS.length + 1}, updated_at = NOW()
          WHERE id = $${FIELDS.length + 2}
          RETURNING ${ROW}`,
        [...values, ctx.actorId ?? null, id],
      )
      .catch((error) => {
        throw friendlyDuplicate(error);
      });
    await writeAudit(client, {
      entity: ENTITY,
      entityId: id,
      action: "update",
      before,
      after: rows[0],
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return rows[0];
  }, db);
}

export async function setVendorActive(id, isActive, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const before = await lockVendor(client, id);
    if (before.is_active === isActive) return before;
    const { rows } = await client.query(
      `UPDATE ${ENTITY}
          SET is_active = $1, version = version + 1, updated_by = $2, updated_at = NOW()
        WHERE id = $3
        RETURNING ${ROW}`,
      [isActive, ctx.actorId ?? null, id],
    );
    await writeAudit(client, {
      entity: ENTITY,
      entityId: id,
      action: isActive ? "activate" : "deactivate",
      before,
      after: rows[0],
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return rows[0];
  }, db);
}
