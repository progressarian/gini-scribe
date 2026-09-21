import fs from "node:fs/promises";
import ExcelJS from "exceljs";
import { IMPORT_SHEETS, LATER_SHEETS, README_SHEET, isLaterSheet } from "./importColumns.js";
import {
  CGHS_CATEGORY_EXAMPLE,
  CONSULTANT_FEES_EXAMPLE,
  EXAMPLE_NOTICE,
  GENERAL_RULES,
  LATER_SHEET_NOTE,
  README_INTRO,
  README_TITLE,
  VALUE_GLOSSARY,
  laterSheetsRule,
} from "./importReadme.js";

export const TEMPLATE_ROWS = 2000;
export const TEMPLATE_FILE_NAME = "gini-billing-template.xlsx";
export const LATER_TAB_COLOR = "FFB0B0B0";

const LATER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4E5" } };

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } };
const REQUIRED_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE9C9" } };

function columnLetter(index) {
  let n = index;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function numberFormatFor(column) {
  if (column.type === "date") return "yyyy-mm-dd";
  if (column.type === "number") return "General";
  return "@";
}

function addDataSheet(workbook, sheet) {
  const later = isLaterSheet(sheet.name);
  const ws = workbook.addWorksheet(sheet.name, {
    views: [{ state: "frozen", ySplit: 1 }],
    ...(later ? { properties: { tabColor: { argb: LATER_TAB_COLOR } } } : {}),
  });
  ws.columns = sheet.columns.map((column) => ({
    header: column.name,
    key: column.name,
    width: Math.max(14, column.name.length + 4),
    style: { numFmt: numberFormatFor(column) },
  }));

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle" };
  sheet.columns.forEach((column, i) => {
    const cell = header.getCell(i + 1);
    cell.numFmt = "@";
    cell.fill = column.required ? REQUIRED_FILL : HEADER_FILL;
    cell.border = { bottom: { style: "thin" } };
  });
  if (later) header.getCell(1).note = LATER_SHEET_NOTE;

  sheet.columns.forEach((column, i) => {
    if (!column.values) return;
    const letter = columnLetter(i + 1);
    ws.dataValidations.add(`${letter}2:${letter}${TEMPLATE_ROWS + 1}`, {
      type: "list",
      allowBlank: !column.required,
      formulae: [`"${column.values.join(",")}"`],
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: "Not allowed",
      error: `Choose one of: ${column.values.join(", ")}`,
      showInputMessage: true,
      promptTitle: column.name,
      prompt: `One of: ${column.values.join(", ")}`,
    });
  });

  return ws;
}

const SECTION_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1C2426" } };
const SHEET_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1EFE9" } };
const README_COLUMNS = 7;
const README_WIDTHS = [18, 26, 14, 34, 62, 30, 22, 16, 16, 16, 12];
const LINE_HEIGHT = 15;

function linesFor(text, width) {
  const perLine = Math.max(1, Math.floor(width * 1.05));
  return String(text ?? "")
    .split("\n")
    .reduce((total, part) => total + Math.max(1, Math.ceil(part.length / perLine)), 0);
}

function fitHeight(row) {
  let lines = 1;
  row.eachCell((cell, col) => {
    lines = Math.max(lines, linesFor(cell.value, README_WIDTHS[col - 1] ?? 16));
  });
  row.height = lines * LINE_HEIGHT + 3;
}

export function blankText(column) {
  return column.required ? "(required — can't be blank)" : column.blank.text;
}

export function allowedValuesText(column) {
  if (column.values) return column.values.join(" / ");
  if (column.type === "number") return "number";
  if (column.type === "date") return "date YYYY-MM-DD";
  return "text";
}

function wrapRow(row) {
  row.alignment = { vertical: "top", wrapText: true };
  fitHeight(row);
}

function addMergedLine(ws, text, { bold = false, size, fill, color } = {}) {
  const row = ws.addRow([text]);
  ws.mergeCells(row.number, 1, row.number, README_COLUMNS);
  const cell = row.getCell(1);
  cell.font = { bold, ...(size ? { size } : {}), ...(color ? { color: { argb: color } } : {}) };
  if (fill) cell.fill = fill;
  cell.alignment = { vertical: "top", wrapText: true };
  const mergedWidth = README_WIDTHS.slice(0, README_COLUMNS).reduce((a, b) => a + b, 0);
  row.height = linesFor(text, mergedWidth) * (size ? size + 6 : LINE_HEIGHT) + 3;
  return row;
}

function addSection(ws, title) {
  ws.addRow([]);
  addMergedLine(ws, title, { bold: true, fill: SECTION_FILL, color: "FFFFFFFF" });
}

function addExample(ws, example) {
  addSection(ws, example.title);
  const header = ws.addRow(example.columns);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });
  for (const values of example.rows) ws.addRow(values);
  addMergedLine(ws, example.note, { color: "FF4F595C" });
}

function addReadmeSheet(workbook) {
  const ws = workbook.addWorksheet(README_SHEET, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.columns = [
    { header: "sheet", key: "sheet" },
    { header: "column", key: "column" },
    { header: "required", key: "required" },
    { header: "allowed values", key: "allowed" },
    { header: "meaning", key: "meaning" },
    { header: "if left blank", key: "blank" },
    { header: "example", key: "example" },
  ];
  README_WIDTHS.forEach((width, i) => {
    ws.getColumn(i + 1).width = width;
  });
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });

  addMergedLine(ws, README_TITLE, { bold: true, size: 16 });
  addMergedLine(ws, README_INTRO);

  addSection(ws, "How to fill this file");
  [...GENERAL_RULES, ...(LATER_SHEETS.length ? [laterSheetsRule(LATER_SHEETS)] : [])].forEach(
    (rule, i) => wrapRow(ws.addRow(["All sheets", `Rule ${i + 1}`, "", "", rule, "", ""])),
  );

  addSection(ws, "Allowed values");
  for (const [column, value, meaning] of VALUE_GLOSSARY) {
    wrapRow(ws.addRow(["Values", column, "", value, meaning, "", ""]));
  }

  addSection(ws, "Columns, sheet by sheet");
  for (const sheet of IMPORT_SHEETS) {
    const sheetRow = ws.addRow([
      sheet.name,
      "(what this sheet is for)",
      "",
      "",
      sheet.purpose,
      "",
      "",
    ]);
    wrapRow(sheetRow);
    sheetRow.font = { bold: true };
    sheetRow.eachCell((cell) => {
      cell.fill = SHEET_FILL;
    });
    if (isLaterSheet(sheet.name)) {
      const laterRow = ws.addRow([
        sheet.name,
        "(available after Phase 3)",
        "",
        "",
        LATER_SHEET_NOTE,
        "",
        "",
      ]);
      wrapRow(laterRow);
      laterRow.font = { bold: true, color: { argb: "FF9A4B08" } };
      laterRow.eachCell((cell) => {
        cell.fill = LATER_FILL;
      });
    }
    for (const column of sheet.columns) {
      wrapRow(
        ws.addRow([
          sheet.name,
          column.name,
          column.required ? "yes" : "no",
          allowedValuesText(column),
          column.meaning,
          blankText(column),
          column.example ?? "",
        ]),
      );
    }
  }

  addSection(ws, "Examples");
  addMergedLine(ws, EXAMPLE_NOTICE, { bold: true, color: "FF9A4B08" });
  addExample(ws, CGHS_CATEGORY_EXAMPLE);
  addExample(ws, CONSULTANT_FEES_EXAMPLE);
  return ws;
}

export function buildTemplateWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Gini Scribe";
  workbook.created = new Date(0);
  workbook.modified = new Date(0);
  for (const sheet of IMPORT_SHEETS) addDataSheet(workbook, sheet);
  addReadmeSheet(workbook);
  return workbook;
}

export async function templateBuffer() {
  return buildTemplateWorkbook().xlsx.writeBuffer();
}

export async function writeTemplateFile(filePath) {
  await fs.writeFile(filePath, Buffer.from(await templateBuffer()));
  return filePath;
}
