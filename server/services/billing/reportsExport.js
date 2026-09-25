import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import { reportFor, runReport } from "./reports.js";
import { FILTER_LABELS, IST } from "./reportsFilters.js";
import { reportFileName } from "../../../shared/billingReportFiles.js";

export const EXPORT_ROW_CAP = 100000;
const SHEET_NAME_MAX = 31;
const MONEY_FORMAT = "#,##0.00";

const WIDTH = {
  money: 14,
  count: 10,
  quantity: 10,
  limit: 12,
  days: 10,
  percent: 11,
  date: 12,
  instant: 18,
  flag: 10,
  text: 28,
};

const IST_STAMP = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const stamp = (value) => {
  if (!value) return null;
  const parts = Object.fromEntries(
    IST_STAMP.formatToParts(new Date(value)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

const CELL = {
  money: (value) => (value === null || value === undefined ? null : value / 100),
  flag: (value) => (value ? "yes" : ""),
  instant: stamp,
};

const cell = (column, value) => (CELL[column.kind] ?? ((v) => v ?? null))(value);

function sheetName(title, used) {
  const plain = title.replace(/[[\]:*?/\\]/g, " ").replace(/›/g, ">");
  let name = plain.slice(0, SHEET_NAME_MAX).trim();
  for (let n = 2; used.has(name.toLowerCase()); n += 1) {
    name = `${plain.slice(0, SHEET_NAME_MAX - String(n).length - 1).trim()} ${n}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function addSection(workbook, part, used) {
  const ws = workbook.addWorksheet(sheetName(part.title, used), {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.columns = part.columns.map((column) => ({
    header: column.label,
    key: column.key,
    width: WIDTH[column.kind] ?? 14,
    style: column.kind === "money" ? { numFmt: MONEY_FORMAT } : {},
  }));
  ws.getRow(1).font = { bold: true };
  const labelColumn = part.columns.findIndex((column) => column.kind === "text") + 1;
  for (const row of part.rows) {
    const added = ws.addRow(
      Object.fromEntries(part.columns.map((column) => [column.key, cell(column, row[column.key])])),
    );
    if (row.depth > 1 && labelColumn > 0) {
      added.getCell(labelColumn).alignment = { indent: (row.depth - 1) * 2 };
    }
    if (row.depth && row.depth < maxDepth(part)) added.font = { bold: true };
  }
  if (part.total) {
    const totalRow = ws.addRow(
      Object.fromEntries(
        part.columns.map((column) => [
          column.key,
          ["money", "count", "quantity"].includes(column.kind)
            ? cell(column, part.total[column.key])
            : null,
        ]),
      ),
    );
    totalRow.getCell(1).value = "Total";
    totalRow.font = { bold: true };
  }
  if (part.truncated) {
    ws.addRow([]);
    ws.addRow([
      `Only the first ${part.rows.length} of ${part.row_count} rows are listed — the total covers them all. Narrow the filters to see the rest.`,
    ]);
  }
  if (part.note) {
    ws.addRow([]);
    ws.addRow([part.note]);
  }
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(part.rows.length, 1) + 1, column: part.columns.length },
  };
  return ws;
}

const maxDepth = (part) => Math.max(0, ...part.rows.map((row) => row.depth ?? 0));

async function filterNames(filters, db) {
  const names = {};
  const lookup = async (key, sql) => {
    if (filters[key] === undefined) return;
    const { rows } = await db.query(sql, [filters[key]]);
    names[key] = rows[0]?.name ? `${rows[0].name} (${filters[key]})` : String(filters[key]);
  };
  await lookup("category", `SELECT label AS name FROM patient_schemes WHERE code = $1`);
  await lookup("sub_category", `SELECT label AS name FROM patient_schemes WHERE code = $1`);
  await lookup("group", `SELECT name FROM service_groups WHERE lower(code) = lower($1)`);
  await lookup("subgroup", `SELECT name FROM service_subgroups WHERE lower(code) = lower($1)`);
  await lookup("consultant", `SELECT name FROM doctors WHERE id = $1::int`);
  await lookup("user", `SELECT name FROM doctors WHERE id = $1::int`);
  return names;
}

function addFilters(workbook, result, names, used) {
  const ws = workbook.addWorksheet(sheetName("Filters", used));
  ws.columns = [
    { header: "Filter", key: "label", width: 18 },
    { header: "Value", key: "value", width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow({ label: "Report", value: result.title });
  ws.addRow({ label: "Generated", value: stamp(result.generated_at) });
  for (const [key, label] of Object.entries(FILTER_LABELS)) {
    const value = result.filters[key];
    if (value === undefined || value === null) continue;
    ws.addRow({ label, value: names[key] ?? String(value) });
  }
  if (result.filters.from === null) ws.addRow({ label: FILTER_LABELS.from, value: "All dates" });
}

export async function reportWorkbook(key, input = {}, db = pool) {
  reportFor(key);
  const result = await runReport(key, input, db, { cap: EXPORT_ROW_CAP });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Gini Scribe";
  const used = new Set();
  addFilters(workbook, result, await filterNames(result.filters, db), used);
  for (const part of result.sections) addSection(workbook, part, used);
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: reportFileName(result.key, result.filters),
    result,
  };
}
