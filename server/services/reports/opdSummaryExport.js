import ExcelJS from "exceljs";
import pool from "../../config/db.js";
import { allOpdVisits, getOpdSummary, VISIT_ROW_CAP } from "./opdSummary.js";
import {
  OPD_STATES,
  OPD_STATUS_OPTIONS,
  OPD_TYPE_OPTIONS,
  opdSummaryFileName,
  typeIncludes,
} from "../../../shared/opdSummary.js";

const COUNT_COLUMNS = [
  { header: "Visits attended", key: "attended" },
  { header: "Unique patients", key: "uniquePatients" },
  { header: "Not closed in HealthRay", key: "notClosed" },
  { header: "New", key: "new" },
  { header: "Follow-up", key: "followUp" },
  { header: "Other OPD", key: "other" },
  { header: "Tele", key: "tele" },
  { header: "Lab-only", key: "labOnly" },
  { header: "No-show", key: "noShow" },
];

const bucketLabel = (type, bucket, label) =>
  `${label} (${typeIncludes(type, bucket) ? "included above" : "shown separately"})`;

const labelOf = (options, value) => options.find((o) => o.value === value)?.label ?? value;

function sheet(workbook, name, columns, rows) {
  const ws = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ width: c.width ?? 14, ...c }));
  ws.getRow(1).font = { bold: true };
  ws.addRows(rows);
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(rows.length, 1) + 1, column: columns.length },
  };
  return ws;
}

export async function opdSummaryWorkbook(filters, db = pool) {
  const type = filters.type || "opd";
  const status = filters.status || "came";
  const [summary, visits] = await Promise.all([
    getOpdSummary({ month: filters.month, doctor: filters.doctor ?? null, type }, db),
    allOpdVisits({ ...filters, type, status }, db),
  ]);
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  const t = summary.totals;
  const overview = workbook.addWorksheet("Summary");
  overview.columns = [
    { header: "Measure", key: "label", width: 34 },
    { header: "Value", key: "value", width: 40 },
  ];
  overview.getRow(1).font = { bold: true };
  overview.addRows([
    { label: "Month", value: summary.month },
    { label: "Dates", value: `${summary.from} to ${summary.to}` },
    { label: "Doctor", value: summary.doctor || "All doctors" },
    { label: "Visit type", value: labelOf(OPD_TYPE_OPTIONS, type) },
    { label: "Visits sheet: status", value: labelOf(OPD_STATUS_OPTIONS, status) },
    { label: "Visits sheet: day", value: filters.day || "Whole month" },
    { label: "Visits sheet: search", value: filters.q || "None" },
    { label: "Visits attended", value: t.attended },
    { label: "Unique patients (each person counted once)", value: t.uniquePatients },
    { label: "Patients who came more than once", value: t.repeatPatients },
    { label: "Extra visits by those patients", value: t.repeatVisits },
    { label: "Not closed in HealthRay (included above)", value: t.notClosed },
    { label: bucketLabel(type, "new", "New"), value: t.new },
    { label: bucketLabel(type, "follow_up", "Follow-up"), value: t.followUp },
    { label: bucketLabel(type, "other", "Other OPD"), value: t.other },
    { label: bucketLabel(type, "tele", "Tele"), value: t.tele },
    { label: bucketLabel(type, "lab_only", "Lab-only"), value: t.labOnly },
    { label: "No-shows", value: t.noShow },
    { label: "Cancelled", value: t.cancelled },
    { label: "Not updated", value: t.notUpdated },
    { label: "Booked ahead", value: t.booked },
    {
      label: `Previous month (${summary.previousMonth.month}) visits attended`,
      value: summary.previousMonth.attended,
    },
  ]);

  sheet(
    workbook,
    "By day",
    [{ header: "Day", key: "day", width: 12 }, ...COUNT_COLUMNS],
    summary.byDay,
  );
  sheet(
    workbook,
    "By doctor",
    [{ header: "Doctor", key: "doctor", width: 32 }, ...COUNT_COLUMNS],
    summary.byDoctor,
  );
  const list = sheet(
    workbook,
    "Visits",
    [
      { header: "Date", key: "day", width: 12 },
      { header: "Time", key: "timeSlot", width: 9 },
      { header: "Patient", key: "patientName", width: 30 },
      { header: "UHID", key: "fileNo", width: 14 },
      { header: "Health ID", key: "healthId", width: 14 },
      { header: "Doctor", key: "doctor", width: 30 },
      { header: "Type", key: "bucketLabel", width: 12 },
      { header: "Status", key: "stateLabel", width: 24 },
    ],
    visits.map((v) => ({ ...v, stateLabel: OPD_STATES[v.state] ?? v.status })),
  );
  if (visits.length >= VISIT_ROW_CAP) {
    list.addRow([]);
    list.addRow([
      `Only the first ${VISIT_ROW_CAP} visits are listed. Narrow the filters to see the rest.`,
    ]);
  }

  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: opdSummaryFileName(summary.month),
  };
}
