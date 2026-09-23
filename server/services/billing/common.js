import { writeAudit } from "./audit.js";
import { assertUnused, whereUsed } from "./usage.js";
import { httpError } from "./transaction.js";
import { INT_MAX, MONEY_MAX, VISIT_TYPES } from "../../../shared/billingVocab.js";

export const hasField = (input, key) =>
  Boolean(input) && Object.prototype.hasOwnProperty.call(input, key);

export function cleanCode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  if (!code || /\s/.test(code)) throw httpError(400, "Code can't be blank or contain spaces");
  return code;
}

export function cleanName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw httpError(400, "Name can't be blank");
  return name;
}

export const nameKey = (name) =>
  String(name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

export const NAME_KEY_SQL = `lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))`;

const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

export { INT_MAX, MONEY_MAX };

export function readNumber(value, message) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    if (!NUMBER_TEXT.test(text)) throw httpError(400, message);
    return Number(text);
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw httpError(400, message);
}

export function wholeNumber(value, label, { min = 0, max = INT_MAX } = {}) {
  const message = `${label} must be a whole number from ${min} to ${max}`;
  const n = readNumber(value, message);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(400, message);
  return n;
}

export function cleanOrder(value) {
  return wholeNumber(value, "Sort order", { min: -INT_MAX, max: INT_MAX }) ?? 0;
}

export function cleanMoney(value, label) {
  const amount = readNumber(value, `${label} must be an amount in rupees`);
  if (amount === undefined) throw httpError(400, `${label} is required`);
  if (amount < 0) throw httpError(400, `${label} can't be negative`);
  if (amount > MONEY_MAX) throw httpError(400, `${label} is too large (at most ${MONEY_MAX})`);
  if (Number(amount.toFixed(2)) !== amount) {
    throw httpError(400, `${label} can have at most 2 decimals (paise)`);
  }
  return amount;
}

export function cleanFlag(value, label) {
  if (typeof value !== "boolean") throw httpError(400, `${label} must be true or false`);
  return value;
}

export function cleanActive(value) {
  if (typeof value !== "boolean") throw httpError(400, "Active must be true or false");
  return value;
}

export const auditFields = (ctx) => ({
  actorId: ctx?.actorId ?? null,
  ip: ctx?.ip ?? null,
  importId: ctx?.importId ?? null,
});

export async function assertCodeFree(client, { table, noun }, code, exceptId = null) {
  const { rows } = await client.query(
    `SELECT code FROM ${table} WHERE lower(code) = lower($1) AND id IS DISTINCT FROM $2`,
    [code, exceptId],
  );
  if (rows.length) throw httpError(409, `A ${noun} with code "${rows[0].code}" already exists`);
}

export const duplicateCodeError = (noun, error) =>
  error?.code === "23505" ? httpError(409, `A ${noun} with that code already exists`) : error;

export async function lockRow(client, { table, noun, columns }, id) {
  const { rows } = await client.query(`SELECT ${columns} FROM ${table} WHERE id = $1 FOR UPDATE`, [
    id,
  ]);
  if (!rows.length) throw httpError(404, `That ${noun} no longer exists`);
  return rows[0];
}

export async function deleteUnused(client, { table, key = "id", kind, id, label, before, ctx }) {
  await assertUnused(kind, id, client);
  await client.query("SAVEPOINT billing_delete");
  try {
    await client.query(`DELETE FROM ${table} WHERE ${key} = $1`, [id]);
  } catch (error) {
    if (error.code !== "23503") throw error;
    await client.query("ROLLBACK TO SAVEPOINT billing_delete");
    const { uses } = await whereUsed(kind, id, client);
    throw httpError(
      409,
      `${label} can't be deleted because it is still used: ${uses.map((u) => u.text).join("; ")}. Deactivate it instead.`,
      { uses },
    );
  }
  await writeAudit(client, {
    entity: table,
    entityId: id,
    action: "delete",
    before,
    ...auditFields(ctx),
  });
  return { deleted: true, id };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function cleanDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "string" ? value.trim() : "";
  const parsed = DATE.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw httpError(400, `${label} must be a date like 2026-10-01`);
  }
  return text;
}

export function cleanPriority(value) {
  const priority = readNumber(value, "Priority must be a whole number, 0 or more");
  if (priority === undefined) return 100;
  if (!Number.isInteger(priority) || priority < 0 || priority > INT_MAX) {
    throw httpError(400, "Priority must be a whole number, 0 or more");
  }
  return priority;
}

export function cleanVisitTypes(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!Array.isArray(value)) throw httpError(400, "Visit types must be a list");
  const unknown = value.filter((v) => !VISIT_TYPES.includes(v));
  if (unknown.length) {
    throw httpError(
      400,
      `Visit types must be from: ${VISIT_TYPES.join(", ")} (not ${unknown.map(String).join(", ")})`,
    );
  }
  const chosen = VISIT_TYPES.filter((v) => value.includes(v));
  return chosen.length ? chosen : null;
}
