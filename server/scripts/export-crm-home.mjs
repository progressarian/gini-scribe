import "../loadEnv.js";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";
import pool from "../config/db.js";
import { repHome } from "../crm/visits.js";
import { openReferrals } from "../crm/referrals.js";

const out =
  process.argv[2] ||
  path.join(os.homedir(), "Downloads", `crm-home-${new Date().toISOString().slice(0, 10)}.xlsx`);

const { rows: reps } = await pool.query(
  `SELECT id, full_name, role, manager_id
     FROM crm.users
    WHERE is_active AND deleted_at IS NULL
    ORDER BY full_name`,
);

const sheets = {
  Summary: [],
  "Due visits": [],
  "Today's visits": [],
  Doctors: [],
  Referrals: [],
  Tasks: [],
};

const HIDDEN_COLUMNS = ["doctor_id"];
const doctors = new Map();
const DUE_ORDER = { overdue: 0, due: 1, never_visited: 2 };
const PRIORITY_ORDER = { A: 0, B: 1, C: 2 };

const tagged = (rep, rows) =>
  rows.map((row) => ({ rep: rep.full_name, rep_role: rep.role, ...row }));

try {
  for (const rep of reps) {
    const home = await repHome(rep, { limit: 100 });
    const refs = await openReferrals(rep, { limit: 200 });
    sheets.Summary.push({
      rep: rep.full_name,
      rep_role: rep.role,
      to_visit: home.due_summary.total,
      overdue: home.due_summary.overdue,
      never_visited: home.due_summary.never_visited,
      visits_today: home.performance.visits_today,
      visits_week: home.performance.visits_week,
      visits_month: home.performance.visits_month,
      unique_doctors_month: home.performance.unique_doctors_month,
      doctors_assigned: home.performance.doctors_assigned,
      doctors_need_details: home.performance.doctors_incomplete,
      open_leads: refs.summary.open,
      untouched_leads: refs.summary.untouched,
      urgent_leads: refs.summary.urgent,
      open_tasks: home.tasks.length,
    });
    sheets["Today's visits"].push(...tagged(rep, home.todays_visits));
    home.my_doctors.forEach((doctor) => doctors.set(doctor.doctor_id, doctor));
    sheets.Referrals.push(...tagged(rep, refs.referrals));
    sheets.Tasks.push(...tagged(rep, home.tasks));
    console.log(
      `${rep.full_name}: ${home.my_doctors.length} doctors, ${home.due_visits.length} due, ${refs.referrals.length} referrals`,
    );
  }
} finally {
  await pool.end();
}

sheets.Doctors = [...doctors.values()];
sheets["Due visits"] = sheets.Doctors.filter((doctor) => doctor.due_state in DUE_ORDER).sort(
  (a, b) =>
    DUE_ORDER[a.due_state] - DUE_ORDER[b.due_state] ||
    (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3) ||
    (a.last_visit_at ?? 0) - (b.last_visit_at ?? 0),
);

const cell = (value) => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return value;
};

const book = new ExcelJS.Workbook();
for (const [name, rows] of Object.entries(sheets)) {
  const sheet = book.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(
    (key) => !HIDDEN_COLUMNS.includes(key),
  );
  if (keys.length === 0) {
    sheet.addRow(["No rows"]);
    continue;
  }
  sheet.columns = keys.map((key) => ({
    header: key.replace(/_/g, " "),
    key,
    width: Math.min(
      40,
      Math.max(key.length + 2, ...rows.map((row) => String(cell(row[key])).length + 2)),
    ),
  }));
  rows.forEach((row) => sheet.addRow(Object.fromEntries(keys.map((key) => [key, cell(row[key])]))));
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: keys.length } };
  keys.forEach((key, i) => {
    if (rows.some((row) => row[key] instanceof Date)) {
      sheet.getColumn(i + 1).numFmt = "dd-mmm-yyyy hh:mm";
    }
  });
}

await book.xlsx.writeFile(out);
console.log(`wrote ${out}`);
