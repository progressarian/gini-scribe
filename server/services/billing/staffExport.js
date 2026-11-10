import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import { indiaToday } from "./categoryResolver.js";
import { addTable, MONEY_FORMAT } from "./dashboardExport.js";
import { EXPORT_PAYMENTS_MAX, rangePayments, staffDashboard } from "./staffDashboard.js";

const rupees = (paise) => (paise === null || paise === undefined ? null : paise / 100);
const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const moment = (value) => (value ? IST.format(new Date(value)) : "");

function shiftStatus(shift) {
  if (shift.is_open) return shift.left_open ? "Left open" : "Open";
  if (shift.counted_cash === null) return "Not counted";
  if (shift.difference < 0) return "Short";
  if (shift.difference > 0) return "Over";
  return "Matches";
}

function addStaff(workbook, data) {
  const ws = workbook.addWorksheet("Staff");
  const money = data.columns.money;
  const cleared = data.columns.cleared;
  const headers = [
    "Staff",
    "Patients",
    "Check-ins",
    "Bills finalised",
    "Closed by test cancel",
    ...money.map((col) => col.label),
    "Refunds paid back",
    "Net collected",
    ...cleared.map((col) => col.label),
    "Cash short",
    "Cash over",
    "Manual discounts",
    "Manual discount amount",
  ];
  ws.columns = headers.map((_, index) => ({ width: index ? 16 : 26 }));
  const formats = [
    null,
    null,
    null,
    null,
    null,
    ...money.map(() => MONEY_FORMAT),
    MONEY_FORMAT,
    MONEY_FORMAT,
    ...cleared.map(() => MONEY_FORMAT),
    MONEY_FORMAT,
    MONEY_FORMAT,
    null,
    MONEY_FORMAT,
  ];
  const rowOf = (person, name) => [
    name,
    person.patients,
    person.check_ins,
    person.finalised,
    person.closed_by_cancel ?? 0,
    ...money.map((col) => rupees(person.money[col.key])),
    rupees(-person.refunded),
    rupees(person.collected),
    ...cleared.map((col) => rupees(person.cleared[col.key])),
    rupees(person.short ?? 0),
    rupees(person.over ?? 0),
    person.manual_discounts,
    rupees(person.manual_discount_amount),
  ];
  addTable(
    ws,
    null,
    headers,
    [...data.staff.map((person) => rowOf(person, person.name)), rowOf(data.total, "Total")],
    formats,
  );
}

function addShifts(workbook, data) {
  const ws = workbook.addWorksheet("Shifts");
  const headers = [
    "Staff",
    "Opened",
    "Closed",
    "Opening cash",
    "Cash in",
    "Cash out",
    "Expected",
    "Counted",
    "Difference",
    "Status",
    "Card",
    "UPI",
    "NEFT / Cheque",
    "Paid in HealthRay",
    "Note",
  ];
  ws.columns = headers.map((_, index) => ({ width: [0, 1, 2, 14].includes(index) ? 22 : 14 }));
  const net = (shift, mode) => (shift.collected[mode] ?? 0) - (shift.refunded[mode] ?? 0);
  addTable(
    ws,
    null,
    headers,
    data.shifts.map((shift) => [
      shift.user.name ?? "",
      moment(shift.opened_at),
      shift.is_open ? "Open" : moment(shift.closed_at),
      rupees(shift.opening_cash),
      rupees(shift.collected.cash),
      rupees(-shift.refunded.cash),
      rupees(shift.expected_cash),
      rupees(shift.counted_cash),
      rupees(shift.difference),
      shiftStatus(shift),
      rupees(net(shift, "card")),
      rupees(net(shift, "upi")),
      rupees(net(shift, "neft")),
      rupees(shift.healthray.collected - shift.healthray.refunded),
      shift.note ?? "",
    ]),
    [
      null,
      null,
      null,
      MONEY_FORMAT,
      MONEY_FORMAT,
      MONEY_FORMAT,
      MONEY_FORMAT,
      MONEY_FORMAT,
      MONEY_FORMAT,
      null,
      MONEY_FORMAT,
      MONEY_FORMAT,
      MONEY_FORMAT,
      MONEY_FORMAT,
    ],
  );
}

function addPayments(workbook, rows) {
  const ws = workbook.addWorksheet("Payments");
  const headers = [
    "Time",
    "Staff",
    "Receipt",
    "Patient",
    "UHID",
    "Bill",
    "Mode",
    "UPI app",
    "Reference",
    "Amount",
    "Voided",
  ];
  ws.columns = headers.map((_, index) => ({ width: [0, 1, 3].includes(index) ? 24 : 14 }));
  if (rows.length >= EXPORT_PAYMENTS_MAX) {
    ws.addRow([`Only the first ${EXPORT_PAYMENTS_MAX} payments are listed — choose fewer days.`]);
  }
  addTable(
    ws,
    null,
    headers,
    rows.map((row) => [
      moment(row.received_at),
      row.staff ?? "",
      row.receipt_no ?? "",
      row.patient_name ?? "",
      row.file_no ?? "",
      row.deposit ? "Deposit" : (row.bill_no ?? "Draft"),
      row.paid_via ? `${row.mode} (${row.paid_via})` : row.mode,
      row.upi_app ?? "",
      row.reference ?? "",
      rupees(row.direction === "out" ? -row.amount : row.amount),
      row.voided_at ? "Voided" : "",
    ]),
    [null, null, null, null, null, null, null, null, null, MONEY_FORMAT],
  );
}

export const staffFileName = ({ from, to }) => `staff-and-shifts-${from}-to-${to}.xlsx`;

export async function staffWorkbook(input = {}, db = pool, { today = indiaToday() } = {}) {
  const data = await staffDashboard(input, db, { today });
  const rows = await rangePayments(input, db, { today });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Gini Scribe";
  addStaff(workbook, data);
  addShifts(workbook, data);
  addPayments(workbook, rows);
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: staffFileName(data.filters),
    data,
  };
}
