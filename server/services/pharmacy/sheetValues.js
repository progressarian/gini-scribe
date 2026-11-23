import { number } from "./stockParse.js";

export const asNumber = (v) => {
  if (v === null || v === undefined || v === "") return v;
  const n = number(v);
  return Number.isNaN(n) ? v : n;
};

const pad = (n) => String(n).padStart(2, "0");

export function isoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return monthEnd(Number(m[2]), Number(m[1]));
  m = /^([A-Za-z]{3})[A-Za-z]*[\s/.-]+(\d{4})$/.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) {
    return monthEnd(Number(m[2]), MONTHS.indexOf(m[1].toLowerCase()) + 1);
  }
  return s;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthEnd(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(last)}`;
}

export const asText = (v) =>
  v === null || v === undefined ? v : typeof v === "number" ? String(v) : String(v).trim();

export const nameKey = (v) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
