import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import {
  bucketLabel,
  dashboardFileName,
  misLayout,
  PENDING_PARTS,
  PERIOD_LABELS,
  rangeLabel,
} from "../../../shared/billingDashboardText.js";
import { billingDashboard } from "./dashboard.js";
import { filterNames, stamp } from "./reportsExport.js";

const MONEY_FORMAT = "#,##0.00;-#,##0.00";
const PCT_FORMAT = '0.00"%"';
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF4" } };
const GROUP_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD5DFEA" } };

const rupees = (paise) => (paise === null || paise === undefined ? null : paise / 100);

const dateOf = (day) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date));
};

function rowLabel(row, period) {
  if (period === "day") return dateOf(row.bucket);
  return `${bucketLabel(row, period)}${row.partial ? " (part)" : ""}`;
}

function misColumns(data) {
  const layout = misLayout(data);
  const period = data.filters.period;
  const money = (group, header, value) => ({ group, header, value, money: true, width: 14 });
  return [
    {
      group: "",
      header: PERIOD_LABELS[period],
      width: period === "week" ? 24 : 14,
      value: (row, total) => (total ? "Grand Total" : rowLabel(row, period)),
      date: period === "day",
    },
    money("Collection", "Net Revenue", (row) => row.net_revenue),
    ...layout.moneyColumns.map((column) =>
      money("Collection", column.label, (row) => row.money[column.key] ?? 0),
    ),
    money("Collection", "Pending Payment", (row) => row.pending),
    money("Collection", "Rev/Pt", (row) => row.rev_per_patient),
    ...data.columns.charges.map((column) =>
      money("Charges", column.label, (row) => row.charges[column.key] ?? 0),
    ),
    { group: "Charges", header: "Pharmacy Charges (not in Scribe)", width: 16, value: () => null },
    money("Discounts", "Discount given", (row) => -row.discount),
    money("Discounts", "Discount on Consultation", (row) => -row.discount_consultation),
    money("Discounts", "Discount on Tests", (row) => -row.discount_tests),
    ...layout.extras.map((column) => money("Checks", column.label, (row) => row[column.key])),
    ...(layout.cashOut ? [money("Checks", "Cash taken out", (row) => row.cash_taken_out)] : []),
    { group: "Checks", header: "Bills", width: 8, value: (row) => row.bills },
    { group: "Checks", header: "Patients", width: 9, value: (row) => row.patients },
    {
      group: "Checks",
      header: "Lines = bill",
      width: 14,
      value: (row) => (row.check.ok ? "OK" : `Off by ${(row.check.difference / 100).toFixed(2)}`),
    },
    ...PENDING_PARTS.map((part) =>
      money("Pending explained", part.label, (row) => row.pending_parts[part.key]),
    ),
  ];
}

function addMisSheet(workbook, data) {
  const period = data.filters.period;
  const columns = misColumns(data);
  const ws = workbook.addWorksheet(`${PERIOD_LABELS[period]} wise Summary`, {
    views: [{ state: "frozen", xSplit: 1, ySplit: 2 }],
  });
  ws.columns = columns.map((column) => ({ width: column.width }));
  const groups = ws.addRow(columns.map((column) => column.group));
  const headers = ws.addRow(columns.map((column) => column.header));
  for (let start = 0; start < columns.length; ) {
    let end = start;
    while (end + 1 < columns.length && columns[end + 1].group === columns[start].group) end += 1;
    if (end > start && columns[start].group) ws.mergeCells(1, start + 1, 1, end + 1);
    start = end + 1;
  }
  for (const row of [groups, headers]) {
    row.font = { bold: true };
    row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  }
  groups.eachCell((cell) => (cell.fill = GROUP_FILL));
  headers.eachCell((cell) => (cell.fill = HEADER_FILL));
  headers.height = 32;
  const write = (row, total) => {
    const added = ws.addRow(
      columns.map((column) => {
        const value = column.value(row, total);
        return column.money ? rupees(value) : value;
      }),
    );
    columns.forEach((column, index) => {
      const cell = added.getCell(index + 1);
      if (column.money) cell.numFmt = MONEY_FORMAT;
      if (column.date && !total) cell.numFmt = "d-mmm-yyyy";
    });
    return added;
  };
  for (const row of data.rows) write(row, false);
  const total = write(data.total, true);
  total.font = { bold: true };
  total.eachCell((cell) => (cell.border = { top: { style: "thin" } }));
  ws.addRow([]);
  ws.addRow([
    "Net Revenue is the patients' share on final bills (credit notes taken off). Pending = Net Revenue − all money collected in the period; a minus means more came in than was billed.",
  ]);
}

function addTable(ws, title, headers, rows, formats = []) {
  if (title) {
    const heading = ws.addRow([title]);
    heading.font = { bold: true, size: 12 };
  }
  const head = ws.addRow(headers);
  head.font = { bold: true };
  head.eachCell((cell) => (cell.fill = HEADER_FILL));
  if (!rows.length) {
    ws.addRow(["Nothing in this range"]);
  }
  for (const values of rows) {
    const added = ws.addRow(values);
    formats.forEach((format, index) => {
      if (format) added.getCell(index + 1).numFmt = format;
    });
  }
  ws.addRow([]);
}

const KPI_ROWS = [
  ["Net revenue", "net_revenue", MONEY_FORMAT],
  ["Collected", "collected", MONEY_FORMAT],
  ["Pending", "pending", MONEY_FORMAT],
  ["Refunds paid back", "paid_back", MONEY_FORMAT],
  ["Discount", "discount", MONEY_FORMAT],
  ["Discount % of charges", "discount_pct", PCT_FORMAT],
  ["Bills", "bills", null],
  ["Credit notes", "credit_notes", null],
  ["Patients", "patients", null],
  ["Average bill", "avg_bill", MONEY_FORMAT],
  ["Revenue per patient", "rev_per_patient", MONEY_FORMAT],
];

function addHeadline(workbook, data) {
  const ws = workbook.addWorksheet("Headline");
  ws.columns = [{ width: 26 }, { width: 18 }, { width: 18 }, { width: 14 }];
  const { current, previous } = data.kpis;
  const value = (key, format, kpis) =>
    format === MONEY_FORMAT ? rupees(kpis[key]) : (kpis[key] ?? null);
  addTable(
    ws,
    null,
    [
      "Measure",
      rangeLabel(data.filters.from, data.filters.to),
      `Before: ${rangeLabel(data.previous_range.from, data.previous_range.to)}`,
      "Change",
    ],
    [
      ...KPI_ROWS.map(([label, key, format]) => {
        const now = current[key];
        const was = previous[key];
        const change =
          key === "discount_pct"
            ? now !== null && was !== null
              ? `${Math.round((now - was) * 100) / 100} pt`
              : ""
            : was
              ? `${Math.round((1000 * (now - was)) / Math.abs(was)) / 10}%`
              : "";
        return [label, value(key, format, current), value(key, format, previous), change];
      }),
      ["Dues still owed (as of now)", rupees(data.dues.outstanding), null, ""],
    ],
    [null, MONEY_FORMAT, MONEY_FORMAT, null],
  );
  ws.eachRow((row, number) => {
    if (number < 2) return;
    const key = KPI_ROWS[number - 2];
    if (key && key[2] !== MONEY_FORMAT) {
      row.getCell(2).numFmt = key[2] ?? "0";
      row.getCell(3).numFmt = key[2] ?? "0";
    }
  });
}

function addDiscounts(workbook, data) {
  const block = data.discounts;
  const period = data.filters.period;
  const ws = workbook.addWorksheet("Discounts");
  ws.columns = [
    { width: 34 },
    { width: 22 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 14 },
    { width: 18 },
  ];
  const methods = block.methods;
  addTable(
    ws,
    `Discounts by ${PERIOD_LABELS[period].toLowerCase()}`,
    [PERIOD_LABELS[period], ...methods.map((m) => m.label), "Total", "Charged", "% of charges"],
    [
      ...block.rows.map((row) => [
        rowLabel(row, period),
        ...methods.map((m) => rupees(row[m.key])),
        rupees(row.given),
        rupees(row.charges),
        row.pct,
      ]),
      [
        "Total",
        ...methods.map((m) => rupees(block.total[m.key])),
        rupees(block.total.given),
        rupees(block.total.charges),
        block.total.pct,
      ],
    ],
    [
      period === "day" ? "d-mmm-yyyy" : null,
      ...methods.map(() => MONEY_FORMAT),
      MONEY_FORMAT,
      MONEY_FORMAT,
      PCT_FORMAT,
    ],
  );
  if (block.total.credited) {
    ws.addRow([`Discount credited back on refunds: ${(block.total.credited / 100).toFixed(2)}`]);
    ws.addRow([]);
  }
  addTable(
    ws,
    "By rule or code",
    ["Rule", "Code", "Method", "Times", "Discount"],
    block.rules.map((r) => [r.label, r.code ?? "", r.method ?? "", r.steps, rupees(r.amount)]),
    [null, null, null, null, MONEY_FORMAT],
  );
  addTable(
    ws,
    "By service group",
    ["Group", "Discount", "Charged", "% of charges"],
    block.groups.map((r) => [r.label, rupees(r.amount), rupees(r.charges), r.pct]),
    [null, MONEY_FORMAT, MONEY_FORMAT, PCT_FORMAT],
  );
  addTable(
    ws,
    "By staff who applied it",
    ["Applied by", "Times", "Discount"],
    block.users.map((r) => [r.label, r.steps, rupees(r.amount)]),
    [null, null, MONEY_FORMAT],
  );
  addTable(
    ws,
    "By consultant",
    ["Consultant", "Times", "Discount"],
    block.consultants.map((r) => [r.label, r.steps, rupees(r.amount)]),
    [null, null, MONEY_FORMAT],
  );
  addTable(
    ws,
    block.top_bills.length
      ? `Biggest discounts — top ${block.top_bills.length} ${block.top_bills.length === 1 ? "bill" : "bills"}`
      : "Biggest discounts",
    ["Bill", "Bill date", "Patient", "UHID", "Charged", "Discount", "% of charges", "Applied by"],
    block.top_bills.map((b) => [
      b.bill_no,
      dateOf(b.bill_date),
      b.patient_name,
      b.file_no || b.health_id || "",
      rupees(b.charges),
      rupees(b.discount),
      b.pct,
      b.applied_by ?? "",
    ]),
    [null, "d-mmm-yyyy", null, null, MONEY_FORMAT, MONEY_FORMAT, PCT_FORMAT],
  );
}

function addSplit(workbook, data) {
  const ws = workbook.addWorksheet("Revenue split");
  ws.columns = [{ width: 34 }, { width: 16 }];
  const block = (title, header, rows) =>
    addTable(
      ws,
      title,
      [header, "Amount"],
      rows.map((r) => [r.label, rupees(r.net)]),
      [null, MONEY_FORMAT],
    );
  block("Revenue by service group", "Group", data.mix.groups);
  block("Revenue by category", "Category", data.mix.categories);
  block("Revenue by consultant", "Consultant", data.mix.consultants);
  block(
    "Collected by payment mode",
    "Mode",
    data.columns.money.map((c) => ({ label: c.label, net: data.total.money[c.key] ?? 0 })),
  );
}

function addFilters(workbook, data, names) {
  const ws = workbook.addWorksheet("Filters");
  ws.columns = [{ width: 22 }, { width: 50 }];
  const f = data.filters;
  addTable(
    ws,
    null,
    ["Filter", "Value"],
    [
      ["Dates", rangeLabel(f.from, f.to)],
      ["View by", PERIOD_LABELS[f.period]],
      ["Compared with", rangeLabel(data.previous_range.from, data.previous_range.to)],
      ...(f.category ? [["Category", names.category]] : []),
      ...(f.sub_category ? [["Sub-category", names.sub_category]] : []),
      ...(f.consultant ? [["Consultant", names.consultant]] : []),
      ["Generated", stamp(data.generated_at)],
      ["Bills counted", "Final bills only; credit notes taken off. Days are India dates."],
    ],
  );
}

export async function dashboardWorkbook(input = {}, db = pool) {
  const data = await billingDashboard(input, db);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Gini Scribe";
  addMisSheet(workbook, data);
  addHeadline(workbook, data);
  addDiscounts(workbook, data);
  addSplit(workbook, data);
  addFilters(workbook, data, await filterNames(data.filters, db));
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: dashboardFileName(data.filters),
    data,
  };
}
