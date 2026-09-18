import pool from "../../config/db.js";
import { writeAudit } from "./audit.js";
import { httpError, inTransaction } from "./transaction.js";
import {
  assertCodeFree,
  auditFields,
  cleanActive,
  cleanCode,
  deleteUnused,
  duplicateCodeError,
  hasField,
  lockRow,
  readNumber,
} from "./common.js";

const SPEC = {
  table: "tax_codes",
  noun: "tax code",
  columns: "id, code, sac_hsn, rate_pct, is_active, created_at, updated_at",
};

function cleanSacHsn(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!/^([0-9]{4}|[0-9]{6}|[0-9]{8})$/.test(text)) {
    throw httpError(400, "SAC/HSN must be 4, 6 or 8 digits");
  }
  return text;
}

function cleanRate(value) {
  const rate = readNumber(value, "Rate must be between 0 and 100 per cent");
  if (rate === undefined) return 0;
  if (rate < 0 || rate > 100) {
    throw httpError(400, "Rate must be between 0 and 100 per cent");
  }
  if (Number(rate.toFixed(2)) !== rate) {
    throw httpError(400, "Rate can have at most 2 decimals");
  }
  return rate;
}

function cleanInput(input, { partial }) {
  const out = {};
  if (!partial || hasField(input, "code")) out.code = cleanCode(input?.code);
  if (!partial || hasField(input, "sac_hsn")) out.sac_hsn = cleanSacHsn(input?.sac_hsn);
  if (!partial || hasField(input, "rate_pct")) out.rate_pct = cleanRate(input?.rate_pct);
  return out;
}

const shape = (row) => (row ? { ...row, rate_pct: Number(row.rate_pct) } : row);

export async function listTaxCodes({ activeOnly = false } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT t.id, t.code, t.sac_hsn, t.rate_pct, t.is_active, t.created_at, t.updated_at,
            (SELECT count(*)::int FROM service_items i WHERE i.tax_code_id = t.id) AS item_count
       FROM tax_codes t
      ${activeOnly ? "WHERE t.is_active" : ""}
      ORDER BY t.rate_pct, t.code`,
  );
  return rows.map(shape);
}

export async function createTaxCode(input, ctx, db = pool) {
  const values = cleanInput(input, { partial: false });
  return inTransaction(async (client) => {
    await assertCodeFree(client, SPEC, values.code);
    const { rows } = await client
      .query(
        `INSERT INTO tax_codes (code, sac_hsn, rate_pct, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4)
         RETURNING ${SPEC.columns}`,
        [values.code, values.sac_hsn, values.rate_pct, ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw duplicateCodeError(SPEC.noun, error);
      });
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: rows[0].id,
      action: "create",
      after: rows[0],
      ...auditFields(ctx),
    });
    return shape(rows[0]);
  }, db);
}

export async function updateTaxCode(id, input, ctx, db = pool) {
  const values = cleanInput(input, { partial: true });
  const keys = Object.keys(values);
  if (!keys.length) throw httpError(400, "Nothing to change");
  return inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, id);
    if (values.code !== undefined) await assertCodeFree(client, SPEC, values.code, id);
    const { rows } = await client
      .query(
        `UPDATE tax_codes
            SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")},
                updated_at = NOW(), updated_by = $${keys.length + 2}
          WHERE id = $1
          RETURNING ${SPEC.columns}`,
        [id, ...keys.map((k) => values[k]), ctx?.actorId ?? null],
      )
      .catch((error) => {
        throw duplicateCodeError(SPEC.noun, error);
      });
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: id,
      action: "update",
      before,
      after: rows[0],
      ...auditFields(ctx),
    });
    return shape(rows[0]);
  }, db);
}

export async function setTaxCodeActive(id, value, ctx, db = pool) {
  const active = cleanActive(value);
  return inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, id);
    if (before.is_active === active) return shape(before);
    if (!active) {
      const { rows } = await client.query(
        `SELECT name FROM service_items WHERE tax_code_id = $1 AND is_active ORDER BY name`,
        [id],
      );
      if (rows.length) {
        const names = rows.map((r) => r.name);
        throw httpError(
          409,
          `${before.code} is still used by ${rows.length} active item${rows.length === 1 ? "" : "s"}: ${names.join(", ")}. Give ${rows.length === 1 ? "it" : "them"} another tax code first.`,
          { active: names },
        );
      }
    }
    const { rows } = await client.query(
      `UPDATE tax_codes SET is_active = $2, updated_at = NOW(), updated_by = $3
        WHERE id = $1 RETURNING ${SPEC.columns}`,
      [id, active, ctx?.actorId ?? null],
    );
    await writeAudit(client, {
      entity: SPEC.table,
      entityId: id,
      action: active ? "activate" : "deactivate",
      before,
      after: rows[0],
      ...auditFields(ctx),
    });
    return shape(rows[0]);
  }, db);
}

export async function deleteTaxCode(id, ctx, db = pool) {
  return inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, id);
    return deleteUnused(client, {
      table: SPEC.table,
      kind: "taxCode",
      id,
      label: before.code,
      before,
      ctx,
    });
  }, db);
}
