import ExcelJS from "exceljs";
import { withCrmContext } from "./db.js";
import { listAssignees, failedRows } from "./importAssign.js";

const TEMPLATE_COLUMNS = [
  { header: "Doctor ID", key: "id", width: 38, hidden: true },
  { header: "Full name", key: "full_name", width: 30 },
  { header: "Specialty", key: "specialty", width: 22 },
  { header: "Mobile", key: "mobile", width: 14 },
  { header: "Area", key: "area", width: 18 },
  { header: "Territory", key: "territory", width: 16 },
  { header: "Priority", key: "priority", width: 10 },
  { header: "Assigned to", key: "owner", width: 22 },
];

const boldHeader = (sheet, columns) => {
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns } };
};

export async function templateWorkbook(crmUser) {
  const staff = await listAssignees(crmUser);
  const doctors = await withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql(
      `SELECT d.id, d.full_name, d.specialty, d.mobile, d.area, t.name AS territory,
              d.priority, u.full_name AS owner
         FROM crm.doctors d
         LEFT JOIN crm.territories t ON t.id = d.territory_id
         LEFT JOIN crm.doctor_assignments a ON a.doctor_id = d.id AND a.effective_to IS NULL
         LEFT JOIN crm.users u ON u.id = a.executive_id
        WHERE d.deleted_at IS NULL AND d.is_active
        ORDER BY t.name NULLS LAST, d.full_name`,
    );
    return rows;
  });

  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Doctors");
  sheet.columns = TEMPLATE_COLUMNS;
  doctors.forEach((d) => sheet.addRow(d));
  boldHeader(sheet, TEMPLATE_COLUMNS.length);

  const list = book.addWorksheet("Staff", { state: "hidden" });
  staff.forEach((s, i) => (list.getCell(`A${i + 1}`).value = s.full_name));
  const ownerColumn = TEMPLATE_COLUMNS.findIndex((c) => c.key === "owner") + 1;
  if (staff.length) {
    for (let row = 2; row <= doctors.length + 1; row++) {
      sheet.getRow(row).getCell(ownerColumn).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`Staff!$A$1:$A$${staff.length}`],
        showErrorMessage: true,
        errorStyle: "warning",
        errorTitle: "Not a growth team member",
        error: "Pick a name from the list.",
      };
    }
  }
  return { buffer: await book.xlsx.writeBuffer(), count: doctors.length };
}

export async function failedWorkbook(crmUser, batchId) {
  const { fileName, headers, rows } = await failedRows(crmUser, batchId);
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Failed rows");
  const columns = [
    ...headers.map((h) => ({ header: h, key: `col:${h}`, width: Math.min(40, h.length + 12) })),
    { header: "Reason", key: "reason", width: 50 },
    { header: "Suggested staff", key: "suggested", width: 22 },
  ];
  sheet.columns = columns;
  rows.forEach((r) =>
    sheet.addRow({
      ...Object.fromEntries(headers.map((h) => [`col:${h}`, r.raw?.[h] ?? ""])),
      reason: r.fail_reason || "",
      suggested: r.suggested || "",
    }),
  );
  boldHeader(sheet, columns.length);
  const base = String(fileName || "import").replace(/\.[^.]+$/, "");
  return { buffer: await book.xlsx.writeBuffer(), fileName: `${base}-failed-rows.xlsx` };
}
