import pool from "../../config/db.js";
import { writeAudit } from "./audit.js";
import { httpError, inTransaction } from "./transaction.js";
import { auditFields, cleanFlag, hasField, INT_MAX, readNumber } from "./common.js";

export const STACKING_MODES = ["best_only", "per_rule"];

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function gstinCheckCharacter(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export function cleanGstin(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw httpError(400, "GSTIN must be text");
  const gstin = value.trim().toUpperCase();
  if (!gstin) return null;
  if (!GSTIN_SHAPE.test(gstin)) {
    throw httpError(400, "GSTIN must be 15 characters, like 03ABCDE1234F1Z5");
  }
  if (gstinCheckCharacter(gstin.slice(0, 14)) !== gstin[14]) {
    throw httpError(
      400,
      "That GSTIN's last character doesn't match — check it for a typing mistake",
    );
  }
  return gstin;
}

function cleanStateCode(value) {
  if (value === undefined || value === null || value === "") return null;
  const code =
    typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!/^[0-9]{2}$/.test(code)) throw httpError(400, "State code must be 2 digits, like 03");
  return code;
}

function cleanText(value, label, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw httpError(400, `${label} must be text`);
  const text = value.trim();
  if (text.length > max) throw httpError(400, `${label} can be at most ${max} characters`);
  return text || null;
}

function cleanMaxCodes(value) {
  const max = readNumber(value, "Codes per bill must be a whole number, 1 or more");
  if (max === undefined) return null;
  if (!Number.isInteger(max) || max < 1 || max > INT_MAX) {
    throw httpError(400, "Codes per bill must be a whole number, 1 or more");
  }
  return max;
}

function cleanStacking(value) {
  if (!STACKING_MODES.includes(value)) {
    throw httpError(400, `Discount stacking must be one of: ${STACKING_MODES.join(", ")}`);
  }
  return value;
}

const CLEANERS = {
  discount_stacking: cleanStacking,
  allow_pay_later: (v) => cleanFlag(v, "Allow pay later"),
  max_codes_per_bill: cleanMaxCodes,
  gst_enabled: (v) => cleanFlag(v, "GST"),
  gstin: cleanGstin,
  state_code: cleanStateCode,
  legal_name: (v) => cleanText(v, "Legal name", 200),
  bill_footer: (v) => cleanText(v, "Bill footer", 1000),
};

const COLUMNS = `discount_stacking, allow_pay_later, max_codes_per_bill, gst_enabled, gstin,
                 state_code, legal_name, bill_footer, updated_at, updated_by`;

export async function getSettings(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM billing_settings`);
  if (!rows.length) throw httpError(500, "Billing settings are missing");
  return rows[0];
}

export async function updateSettings(patch, ctx, db = pool) {
  const values = {};
  for (const key of Object.keys(CLEANERS)) {
    if (hasField(patch, key)) values[key] = CLEANERS[key](patch[key]);
  }
  if (!Object.keys(values).length) throw httpError(400, "Nothing to change");
  return inTransaction(async (client) => {
    const { rows } = await client.query(`SELECT ${COLUMNS} FROM billing_settings FOR UPDATE`);
    if (!rows.length) throw httpError(500, "Billing settings are missing");
    const before = rows[0];
    if (values.gstin && !("state_code" in values) && !before.state_code) {
      values.state_code = values.gstin.slice(0, 2);
    }
    const after = { ...before, ...values };
    if (after.gstin && after.state_code && after.gstin.slice(0, 2) !== after.state_code) {
      throw httpError(
        400,
        `The GSTIN starts with ${after.gstin.slice(0, 2)}, but the state code is ${after.state_code}; they must match`,
      );
    }
    if (after.gst_enabled) {
      const missing = [
        ["gstin", "GSTIN"],
        ["state_code", "state code"],
        ["legal_name", "legal name"],
      ]
        .filter(([key]) => !after[key])
        .map(([, label]) => label);
      if (missing.length) {
        const list = missing.join(", ");
        throw httpError(
          409,
          before.gst_enabled
            ? `GST is switched on, so the ${list} can't be cleared; switch GST off first`
            : `GST can't be switched on until the ${list} ${missing.length === 1 ? "is" : "are"} filled in`,
        );
      }
    }
    const keys = Object.keys(values);
    const { rows: saved } = await client.query(
      `UPDATE billing_settings
          SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")},
              updated_at = NOW(), updated_by = $${keys.length + 1}
        RETURNING ${COLUMNS}`,
      [...keys.map((k) => values[k]), ctx?.actorId ?? null],
    );
    await writeAudit(client, {
      entity: "billing_settings",
      entityId: "settings",
      action: "update",
      before,
      after: saved[0],
      ...auditFields(ctx),
    });
    return saved[0];
  }, db);
}
