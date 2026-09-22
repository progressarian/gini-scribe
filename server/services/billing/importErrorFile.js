import ExcelJS from "exceljs";
import { ERROR_COLUMN } from "./importColumns.js";

export const ERROR_FILE_SUFFIX = " - errors";

const ERROR_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE2E1" } };
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8B4B0" } };
const CLEAR_FILL = { type: "pattern", pattern: "none" };

const normal = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase();

const headingOf = (cell) => {
  try {
    return normal(cell.text);
  } catch {
    return "";
  }
};

function headerPositions(ws) {
  const positions = new Map();
  let last = 0;
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const heading = headingOf(cell);
    if (heading) positions.set(heading, col);
    last = Math.max(last, col);
  });
  return { positions, last };
}

const restyle = (cell, style) => {
  cell.style = { ...cell.style, ...style };
};

const describe = (row) => row.errors.map((e) => e.message).join("; ");

function markSheet(ws, sheet) {
  const { positions, last } = headerPositions(ws);
  let errorCol = positions.get(ERROR_COLUMN);
  if (!errorCol) {
    errorCol = last + 1;
    ws.getRow(1).getCell(errorCol).value = ERROR_COLUMN;
  }
  restyle(ws.getRow(1).getCell(errorCol), { font: { bold: true }, fill: HEADER_FILL });
  ws.getColumn(errorCol).width = Math.max(ws.getColumn(errorCol).width ?? 0, 60);

  const byRow = new Map(sheet.rows.map((row) => [row.row, row]));
  ws.eachRow({ includeEmpty: false }, (excelRow, number) => {
    if (number === 1) return;
    const cell = excelRow.getCell(errorCol);
    const row = byRow.get(number);
    if (row?.status === "error") return;
    if (cell.value !== null && cell.value !== undefined) cell.value = null;
    restyle(cell, { fill: CLEAR_FILL });
  });

  for (const row of sheet.rows.filter((r) => r.status === "error")) {
    const excelRow = ws.getRow(row.row);
    const cell = excelRow.getCell(errorCol);
    cell.value = describe(row);
    restyle(cell, { fill: ERROR_FILL, alignment: { wrapText: true, vertical: "top" } });
    for (const column of new Set(row.errors.map((e) => e.column))) {
      const col = positions.get(normal(column));
      if (col) restyle(excelRow.getCell(col), { fill: ERROR_FILL });
    }
  }
}

export function errorFileName(fileName) {
  const name = String(fileName ?? "").trim() || "billing-import.xlsx";
  const base = name.replace(/\.xlsx$/i, "");
  return `${base}${ERROR_FILE_SUFFIX}.xlsx`;
}

export async function errorFile(buffer, preview) {
  if (preview.problems.length || !preview.counts.error) return null;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheetsByName = new Map(workbook.worksheets.map((ws) => [normal(ws.name), ws]));
  for (const sheet of preview.sheets) {
    const ws = sheetsByName.get(normal(sheet.name));
    if (!ws) continue;
    const hasErrors = sheet.rows.some((row) => row.status === "error");
    if (hasErrors || headerPositions(ws).positions.has(ERROR_COLUMN)) markSheet(ws, sheet);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
