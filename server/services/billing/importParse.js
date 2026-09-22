import ExcelJS from "exceljs";
import {
  ERROR_COLUMN,
  IMPORT_SHEETS,
  README_SHEET,
  isExampleKey,
  isLaterSheet,
  parseRow,
} from "./importColumns.js";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_SHEET_ROWS = 5000;

const normal = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase();

const SHEETS_BY_NAME = new Map(IMPORT_SHEETS.map((sheet) => [normal(sheet.name), sheet]));

const dateText = (value) =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : null;

const cellText = (cell) => {
  try {
    const shown = dateText(cell.value) ?? dateText(cell.value?.result);
    return shown ?? String(cell.text ?? "").trim();
  } catch {
    return "";
  }
};

function rowHasContent(row) {
  let found = false;
  row.eachCell({ includeEmpty: false }, (cell) => {
    if (cellText(cell) !== "") found = true;
  });
  return found;
}

function keyColumnOf(ws, sheet) {
  let at = 1;
  const key = normal(sheet.columns[0].name);
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    if (normal(cellText(cell)) === key) at = col;
  });
  return at;
}

const isExampleRow = (row, keyCol) => isExampleKey(cellText(row.getCell(keyCol)));

function sheetHasContent(ws) {
  let found = false;
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (!found && rowHasContent(row)) found = true;
  });
  return found;
}

const listed = (names) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];

function readHeader(ws, sheet, problems) {
  const known = new Map(sheet.columns.map((column) => [normal(column.name), column.name]));
  const positions = {};
  const unknown = [];
  const ignored = new Set();
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const heading = cellText(cell);
    if (!heading) return;
    if (normal(heading) === ERROR_COLUMN) {
      ignored.add(col);
      return;
    }
    const name = known.get(normal(heading));
    if (!name) {
      unknown.push(heading);
    } else if (name in positions) {
      problems.push(`${sheet.name}: the column ${name} appears twice`);
    } else {
      positions[name] = col;
    }
  });
  if (!Object.keys(positions).length) {
    problems.push(
      `${sheet.name}: row 1 must hold the column names (${sheet.columns.map((c) => c.name).join(", ")})`,
    );
    return positions;
  }
  for (const heading of unknown) {
    problems.push(
      `${sheet.name}: the column "${heading}" isn't one of this sheet's columns; fix its name or delete the column`,
    );
  }
  const missing = sheet.columns.filter((c) => !(c.name in positions)).map((c) => c.name);
  if (missing.length) {
    problems.push(
      `${sheet.name}: the ${missing.length === 1 ? "column" : "columns"} ${listed(missing)} ${
        missing.length === 1 ? "is" : "are"
      } missing; put the header back (leave its cells empty to use the default)`,
    );
  }
  const headed = new Set(Object.values(positions));
  const stray = new Set();
  ws.eachRow({ includeEmpty: false }, (row, number) => {
    if (number === 1) return;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      if (!headed.has(col) && !ignored.has(col) && cellText(cell) !== "") {
        stray.add(ws.getColumn(col).letter);
      }
    });
  });
  for (const letter of stray) {
    problems.push(
      `${sheet.name}: column ${letter} has values but no header; put the header back or clear the column`,
    );
  }
  return positions;
}

function readRows(ws, sheet, positions) {
  const rows = [];
  const keyCol = positions[sheet.columns[0].name] ?? keyColumnOf(ws, sheet);
  ws.eachRow({ includeEmpty: false }, (row, number) => {
    if (number === 1 || !rowHasContent(row) || isExampleRow(row, keyCol)) return;
    const cells = {};
    const input = {};
    for (const column of sheet.columns) {
      const col = positions[column.name];
      const cell = col ? row.getCell(col) : null;
      cells[column.name] = cell ? cell.value : null;
      input[column.name] = cell ? cellText(cell) : "";
    }
    if (Object.values(input).every((text) => text === "")) return;
    const { values, errors } = parseRow(sheet, cells);
    rows.push({ row: number, input, values, errors });
  });
  return rows;
}

function countRows(ws, sheet) {
  const keyCol = keyColumnOf(ws, sheet);
  let count = 0;
  ws.eachRow({ includeEmpty: false }, (row, number) => {
    if (number > 1 && rowHasContent(row) && !isExampleRow(row, keyCol)) count += 1;
  });
  return count;
}

async function loadWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
    return workbook;
  } catch {
    return null;
  }
}

export async function parseUpload(buffer) {
  if (!buffer?.length) return { problems: ["The file is empty"], sheets: [] };
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return {
      problems: [
        `The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB; split it into smaller files`,
      ],
      sheets: [],
    };
  }
  const workbook = await loadWorkbook(buffer);
  if (!workbook) {
    return {
      problems: [
        "This isn't an Excel .xlsx file; save it as an Excel Workbook (.xlsx) and upload again",
      ],
      sheets: [],
    };
  }

  const problems = [];
  const found = [];
  for (const ws of workbook.worksheets) {
    if (normal(ws.name) === normal(README_SHEET)) continue;
    const sheet = SHEETS_BY_NAME.get(normal(ws.name));
    const twin = sheet && found.find((f) => f.sheet === sheet);
    if (twin) {
      problems.push(
        `The sheet ${sheet.name} appears twice ("${twin.ws.name}" and "${ws.name}"); keep one`,
      );
      continue;
    }
    if (!sheet) {
      if (sheetHasContent(ws)) {
        problems.push(
          `The sheet "${ws.name}" isn't one of the template's sheets; rename it or delete it`,
        );
      }
      continue;
    }
    found.push({ ws, sheet });
  }

  const sheets = [];
  for (const { ws, sheet } of found) {
    const count = countRows(ws, sheet);
    if (!count) continue;
    if (count > MAX_SHEET_ROWS) {
      problems.push(
        `${sheet.name} has ${count} rows; at most ${MAX_SHEET_ROWS} can be uploaded at once`,
      );
      continue;
    }
    if (isLaterSheet(sheet.name)) {
      sheets.push({ name: sheet.name, later: true, notImported: count, rows: [] });
      continue;
    }
    const before = problems.length;
    const positions = readHeader(ws, sheet, problems);
    if (problems.length > before) continue;
    sheets.push({
      name: sheet.name,
      later: false,
      notImported: 0,
      rows: readRows(ws, sheet, positions),
    });
  }

  if (!problems.length && !sheets.some((sheet) => sheet.rows.length || sheet.notImported)) {
    problems.push("The file has no rows to import");
  }
  const order = IMPORT_SHEETS.map((sheet) => sheet.name);
  sheets.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return { problems, sheets: problems.length ? [] : sheets };
}
