import { httpError, inTransaction } from "./transaction.js";
import { indiaToday } from "./categoryResolver.js";
import { BILL_SERIES, financialYear, formatNumber } from "./billSeries.js";

export { BILL_SERIES };

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

const SERIES_OF = { bill: "MAIN", receipt: "RCPT" };

export const seriesFor = (kind) => SERIES_OF[kind];

function cleanSeries(value) {
  const series = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!BILL_SERIES.includes(series)) {
    throw httpError(400, `Series must be one of: ${BILL_SERIES.join(", ")}`);
  }
  return series;
}

function cleanDate(value) {
  if (value === undefined || value === null || value === "") return indiaToday();
  if (value instanceof Date) return indiaToday(value);
  const text = typeof value === "string" ? value.trim().slice(0, 10) : "";
  const match = DATE_TEXT.exec(text);
  const month = match ? Number(match[2]) : 0;
  const day = match ? Number(match[3]) : 0;
  if (!match || month < 1 || month > 12 || day < 1 || day > 31) {
    throw httpError(400, "The date must look like 2026-04-01");
  }
  return text;
}

export async function nextNumber(client, series, date) {
  if (!client || typeof client.release !== "function") {
    throw new Error("nextNumber needs the finalising transaction's client, not the pool");
  }
  const name = cleanSeries(series);
  const fy = financialYear(cleanDate(date));
  return inTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT prefix, number_width, next_no FROM bill_series
        WHERE series = $1 AND fy = $2
        FOR UPDATE`,
      [name, fy],
    );
    const row = rows[0];
    if (!row) {
      throw httpError(409, `Ask the admin to set the bill series for ${fy}`, {
        series: name,
        fy,
      });
    }
    const no = Number(row.next_no);
    if (String(no).length > row.number_width) {
      throw httpError(
        409,
        `The ${name} series for ${fy} has used every ${row.number_width}-digit number; ask the admin to widen it`,
        { series: name, fy },
      );
    }
    await tx.query(
      `UPDATE bill_series SET next_no = next_no + 1, updated_at = NOW()
        WHERE series = $1 AND fy = $2`,
      [name, fy],
    );
    return { number: formatNumber(row, no), series: name, fy, no };
  }, client);
}
