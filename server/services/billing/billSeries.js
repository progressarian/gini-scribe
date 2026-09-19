import pool from "../../config/db.js";
import { writeAudit } from "./audit.js";
import { indiaToday } from "./categoryResolver.js";
import { httpError, inTransaction } from "./transaction.js";
import { auditFields, hasField, readNumber } from "./common.js";

const FY = /^([0-9]{4})-([0-9]{2})$/;

export const BILL_SERIES = ["MAIN", "RCPT"];

export function financialYear(date = indiaToday()) {
  const [year, month] = date.split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export const formatNumber = ({ prefix, number_width: width }, number) =>
  `${prefix}${String(number).padStart(width, "0")}`;

function cleanSeries(value) {
  const series = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!BILL_SERIES.includes(series)) {
    throw httpError(400, `Series must be one of: ${BILL_SERIES.join(", ")}`);
  }
  return series;
}

function cleanFy(value) {
  const fy = typeof value === "string" ? value.trim() : "";
  const match = FY.exec(fy);
  if (!match || (Number(match[1]) + 1) % 100 !== Number(match[2])) {
    throw httpError(400, "Financial year must look like 2026-27");
  }
  return fy;
}

function cleanPrefix(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw httpError(400, "Prefix must be text");
  const prefix = value.trim();
  if (/\s/.test(prefix)) throw httpError(400, "Prefix can't contain spaces");
  if (prefix.length > 30) throw httpError(400, "Prefix can be at most 30 characters");
  return prefix;
}

function cleanWhole(value, label, min, max) {
  const n = readNumber(value, `${label} must be a whole number`);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw httpError(400, `${label} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

const shape = (row) => ({
  ...row,
  next_no: Number(row.next_no),
  next_number: formatNumber(row, Number(row.next_no)),
});

const COLUMNS = `series, fy, prefix, number_width, next_no, created_at, updated_at`;

export async function listSeries(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM bill_series ORDER BY fy DESC, series`);
  return rows.map(shape);
}

export async function saveSeries(input, ctx, db = pool) {
  const series = cleanSeries(input?.series);
  const fy = cleanFy(input?.fy);
  const values = {};
  if (hasField(input, "prefix")) values.prefix = cleanPrefix(input.prefix);
  if (hasField(input, "number_width")) {
    const width = cleanWhole(input.number_width, "Number width", 1, 12);
    if (width !== undefined) values.number_width = width;
  }
  if (hasField(input, "next_no")) {
    const next = cleanWhole(input.next_no, "Next number", 1, 999999999999);
    if (next !== undefined) values.next_no = next;
  }
  return inTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT ${COLUMNS} FROM bill_series WHERE series = $1 AND fy = $2 FOR UPDATE`,
      [series, fy],
    );
    const before = existing[0] ?? null;
    if (before && values.next_no !== undefined && values.next_no < Number(before.next_no)) {
      throw httpError(
        409,
        `The next number can only go up (it is ${Number(before.next_no)}); lowering it could reuse bill numbers`,
      );
    }
    const width = values.number_width ?? before?.number_width ?? 6;
    const next = values.next_no ?? Number(before?.next_no ?? 1);
    if (String(next).length > width) {
      throw httpError(
        400,
        `Next number ${next} doesn't fit in ${width} digits; widen the number first`,
      );
    }
    let row;
    if (!before) {
      const { rows } = await client.query(
        `INSERT INTO bill_series (series, fy, prefix, number_width, next_no, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING ${COLUMNS}`,
        [series, fy, values.prefix ?? "", width, next, ctx?.actorId ?? null],
      );
      row = rows[0];
    } else {
      const keys = Object.keys(values);
      if (!keys.length) throw httpError(400, "Nothing to change");
      const changed = keys.filter((k) => String(values[k]) !== String(before[k]));
      if (!changed.length) return shape(before);
      const { rows } = await client.query(
        `UPDATE bill_series
            SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")},
                updated_at = NOW(), updated_by = $${keys.length + 3}
          WHERE series = $1 AND fy = $2
          RETURNING ${COLUMNS}`,
        [series, fy, ...keys.map((k) => values[k]), ctx?.actorId ?? null],
      );
      row = rows[0];
    }
    await writeAudit(client, {
      entity: "bill_series",
      entityId: `${series}:${fy}`,
      action: before ? "update" : "create",
      before,
      after: row,
      ...auditFields(ctx),
    });
    return shape(row);
  }, db);
}
