import ExcelJS from "exceljs";
import { readableZodError } from "../../middleware/validate.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { cellValue } from "./stockParse.js";

export const SHEET_MAX_BYTES = 5 * 1024 * 1024;
export const SHEET_MAX_ROWS = 5000;
export const ERROR_COLUMN = "Errors";
export const DECISIONS = ["sheet", "keep", "add", "skip"];

const CHOICE_TEXT = {
  sheet: "Use the sheet",
  keep: "Keep current",
  add: "Add quantities together",
};

const choicesFor = (spec, current) =>
  (current.choices ?? ["sheet", "keep", ...(spec.add && current.addable ? ["add"] : [])]).map(
    (c) => (typeof c === "string" ? { value: c, label: CHOICE_TEXT[c] } : c),
  );

const BATCH = 100;
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8B4B0" } };
const ERROR_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE2E1" } };

const normal = (v) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const blank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const plainValue = (cell) => {
  const v = cellValue(cell);
  if (v instanceof Date) return v;
  if (v && typeof v === "object" && "hyperlink" in v) return v.text ?? null;
  return v;
};

export async function readSheet(buffer, columns, { keep = null, empty = null } = {}) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw httpError(400, "This file could not be opened. Upload the sheet as an .xlsx file.");
  }
  const sheet = workbook.worksheets.find((ws) => ws.actualRowCount > 0);
  if (!sheet) throw httpError(400, "The file has no rows in it.");

  const byHeader = new Map();
  for (const c of columns) {
    for (const name of [c.header, ...(c.aliases ?? [])]) byHeader.set(normal(name), c.field);
  }
  const positions = {};
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const field = byHeader.get(normal(cellValue(cell)));
    if (field && !positions[field]) positions[field] = col;
  });
  const missing = columns.filter((c) => c.required && !positions[c.field]);
  if (missing.length) {
    throw httpError(
      400,
      `The ${missing.map((c) => `"${c.header}"`).join(", ")} column${missing.length > 1 ? "s are" : " is"} missing. Download the template and fill that in.`,
    );
  }

  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const excelRow = sheet.getRow(r);
    const values = {};
    for (const [field, col] of Object.entries(positions)) {
      const v = plainValue(excelRow.getCell(col));
      values[field] = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
    }
    if (Object.values(values).every(blank) || (keep && !keep(values))) continue;
    rows.push({ row: r, values });
    if (rows.length > SHEET_MAX_ROWS) {
      throw httpError(
        400,
        `The sheet has more than ${SHEET_MAX_ROWS} rows; split it into smaller files.`,
      );
    }
  }
  if (!rows.length) throw httpError(400, empty ?? "The sheet has no filled rows.");
  return rows;
}

export async function sheetFile({ sheetName, columns, rows = [], help = [], errors = false }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  const all = errors
    ? [...columns, { field: "__errors", header: ERROR_COLUMN, width: 60 }]
    : columns;
  sheet.columns = all.map((c) => ({ header: c.header, key: c.field, width: c.width ?? 16 }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const values of rows) {
    const added = sheet.addRow(values);
    if (errors && values.__errors) {
      const cell = added.getCell(all.length);
      cell.fill = ERROR_FILL;
      cell.alignment = { wrapText: true, vertical: "top" };
    }
  }
  if (errors) sheet.getRow(1).getCell(all.length).fill = HEADER_FILL;
  if (help.length) {
    const sheetHelp = workbook.addWorksheet("How to fill");
    sheetHelp.getColumn(1).width = 110;
    help.forEach((line) => sheetHelp.addRow([line]));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const same = (a, b) => {
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  const na = Number(a);
  const nb = Number(b);
  if (
    typeof a !== "boolean" &&
    Number.isFinite(na) &&
    Number.isFinite(nb) &&
    String(a).trim() !== "" &&
    String(b).trim() !== ""
  ) {
    return Math.abs(na - nb) < 1e-9;
  }
  return normal(a) === normal(b);
};

const headerOf = (columns, field) => columns.find((c) => c.field === field)?.header ?? field;

function issuesOf(error, columns, labels) {
  return error.issues.map((issue) => ({
    column: headerOf(columns, issue.path?.[0]),
    message: readableZodError({ issues: [issue] }, labels),
  }));
}

const filled = (input) => Object.fromEntries(Object.entries(input).filter(([, v]) => !blank(v)));

export async function previewRows(spec, rawRows, db) {
  const ctx = spec.load ? await spec.load(rawRows, db) : {};
  const firstRowOf = new Map();
  const rows = rawRows.map(({ row, values }) => {
    const input = spec.toInput(values, ctx);
    const errors = [...(spec.problems?.(input, ctx) ?? [])];
    const current = errors.length ? null : (spec.match(input, ctx) ?? null);
    const compare = current?.compare ?? spec.compare;
    const base = current ? Object.fromEntries(compare.map((f) => [f, current.values[f]])) : {};
    const provided = Object.keys(filled(input));
    const result = errors.length
      ? null
      : spec.schema.safeParse({ ...spec.defaults, ...base, ...filled(input) });
    if (result && !result.success)
      errors.push(...issuesOf(result.error, spec.columns, spec.labels ?? {}));
    const data = result?.success ? result.data : null;
    if (data) {
      const key = spec.keyOf(data);
      if (firstRowOf.has(key)) {
        errors.push({
          column: null,
          message: `Same ${spec.noun} as row ${firstRowOf.get(key)}. Keep one row for it.`,
        });
      } else firstRowOf.set(key, row);
    }
    const described = spec.describe({ ...input, ...(data ?? {}) }, ctx);
    const changes =
      current && !errors.length
        ? compare
            .filter((f) => provided.includes(f) && !same(current.values[f], data[f]))
            .map((f) => ({
              column: headerOf(spec.columns, f),
              field: f,
              from: current.values[f] ?? null,
              to: data[f] ?? null,
            }))
        : [];
    const status = errors.length
      ? "error"
      : !current
        ? "new"
        : changes.length
          ? "conflict"
          : "same";
    return {
      row,
      key: described.key,
      label: described.label,
      status,
      errors,
      changes,
      choices: status === "conflict" ? choicesFor(spec, current) : [],
      note: status === "conflict" ? (current.note ?? null) : null,
      existing: current ? { id: current.id, label: current.label ?? null } : null,
      data,
      provided,
      current,
      values,
    };
  });

  const counts = { new: 0, same: 0, conflict: 0, error: 0 };
  for (const r of rows) counts[r.status] += 1;
  return { rows, counts };
}

export const resolveDecision = (r, decisionOf) => {
  const chosen = decisionOf(r.row);
  return r.choices.some((c) => c.value === chosen) ? chosen : r.choices[0].value;
};

export const publicPreview = (preview) => ({
  counts: preview.counts,
  rows: preview.rows.map(({ data, current, values, provided, ...r }) => r),
});

export function decisionsFrom({
  default: fallback = "sheet",
  keep = [],
  sheet = [],
  add = [],
  skip = [],
} = {}) {
  const chosen = new Map();
  for (const [decision, list] of Object.entries({ keep, sheet, add, skip })) {
    for (const row of list) chosen.set(Number(row), decision);
  }
  return (row) => chosen.get(row) ?? fallback;
}

export async function applyRows(spec, preview, decisionOf, ctx = {}, db) {
  const result = { created: 0, updated: 0, added: 0, kept: 0, unchanged: 0, failed: [] };
  const work = preview.rows.filter((r) => r.status === "new" || r.status === "conflict");
  result.unchanged = preview.counts.same;
  result.skipped = preview.counts.error;
  if (spec.applyAll) return spec.applyAll(work, decisionOf, ctx, db, result);
  for (let start = 0; start < work.length; start += BATCH) {
    const batch = work.slice(start, start + BATCH);
    await inTransaction(async (client) => {
      for (const r of batch) {
        const chosen = r.status === "new" ? "create" : decisionOf(r.row);
        const decision =
          chosen === "create" || r.choices.some((c) => c.value === chosen)
            ? chosen
            : r.choices[0].value;
        if (decision === "keep" || decision === "skip") {
          result.kept += 1;
          continue;
        }
        try {
          await inTransaction(async (inner) => {
            if (decision === "create") {
              await spec.create(inner, r, ctx);
              result.created += 1;
            } else if (decision === "add") {
              await spec.add(inner, r, ctx);
              result.added += 1;
            } else {
              await spec.update(inner, r, ctx);
              result.updated += 1;
            }
          }, client);
        } catch (error) {
          result.failed.push({
            row: r.row,
            key: r.key,
            message: error.status
              ? error.message
              : "This row could not be saved. Check it and try again.",
          });
        }
      }
    }, db);
  }
  return result;
}

export function problemRows(spec, preview, failed = []) {
  const failedBy = new Map(failed.map((f) => [f.row, f.message]));
  return preview.rows
    .filter((r) => r.status === "error" || failedBy.has(r.row))
    .map((r) => ({
      ...Object.fromEntries(spec.columns.map((c) => [c.field, r.values[c.field] ?? null])),
      __errors:
        failedBy.get(r.row) ??
        r.errors.map((e) => (e.column ? `${e.column}: ${e.message}` : e.message)).join("; "),
    }));
}
