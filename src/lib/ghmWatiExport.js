import { LIST_PREDICATES, isNewVisitType } from "../../shared/patientLists.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const BLOCK_WIDTH = 16;

const COL_WIDTHS = [22, 12, 14, 14, 12, 14, 12, 12, 14, 12, 6, 6, 20, 14, 14, 14];

const HEADERS = [
  "Name",
  "CountryCode",
  "Phone",
  "AllowCampaign",
  "AllowSMS",
  "Appt_Date",
  "Start_Time",
  "End_Time",
  "Alt_Phone",
  "UHID",
  "Age",
  "Sex",
  "Doctor",
  "Last_Visit_Date",
  "Follow_Up_Date",
  "Preferred_Date",
];

export const fmtSheetDate = (value) => {
  if (!value) return "";
  const iso = String(value).slice(0, 10);
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return String(value);
  const month = MONTHS[Number(m) - 1];
  if (!month) return String(value);
  return `${String(Number(d)).padStart(2, "0")}/${month}/${y}`;
};

export const splitCountryCode = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return { code: "", number: "" };
  if (digits.length > 10 && digits.startsWith("91")) {
    return { code: "91", number: digits.slice(-10) };
  }
  if (digits.length > 10)
    return { code: digits.slice(0, digits.length - 10), number: digits.slice(-10) };
  return { code: "91", number: digits };
};

export const splitSlot = (slot) => {
  const parts = String(slot || "").split(/\s+to\s+/i);
  return { start: (parts[0] || "").trim(), end: (parts[1] || "").trim() };
};

export const isNewVisit = isNewVisitType;

const toSheetRow = (row, fallbackDate) => {
  const { code, number } = splitCountryCode(row.phone);
  const { start, end } = splitSlot(row.preferred_time_slot);
  return [
    row.patient_name || "",
    code,
    number,
    "True",
    "True",
    fmtSheetDate(row.preferred_date || fallbackDate),
    start,
    end,
    (Array.isArray(row.alt_phone) ? row.alt_phone : [row.alt_phone])
      .filter(Boolean)
      .map((n) => splitCountryCode(n).number)
      .join(", "),
    row.file_no || "",
    row.disp_age ?? row.age ?? "",
    row.disp_sex || row.sex || "",
    row.doctor_name || row.preferred_doctor || "",
    fmtSheetDate(row.last_visit_date),
    fmtSheetDate(row.follow_up_date),
    fmtSheetDate(row.preferred_date),
  ];
};

const BORDER = {
  top: { style: "thin", color: { rgb: "000000" } },
  bottom: { style: "thin", color: { rgb: "000000" } },
  left: { style: "thin", color: { rgb: "000000" } },
  right: { style: "thin", color: { rgb: "000000" } },
};

const TITLE_STYLE = {
  font: { bold: true, color: { rgb: "000000" } },
  border: BORDER,
};

const DATE_STYLE = {
  font: { bold: true, color: { rgb: "000000" } },
  fill: { patternType: "solid", fgColor: { rgb: "FFFF00" } },
  alignment: { horizontal: "center" },
  border: BORDER,
};

const BLOCK_STYLE = {
  font: { bold: true, color: { rgb: "000000" } },
  fill: { patternType: "solid", fgColor: { rgb: "FBD5B5" } },
  alignment: { horizontal: "center" },
  border: BORDER,
};

const HEADER_STYLE = {
  font: { bold: true, color: { rgb: "000000" } },
  fill: { patternType: "solid", fgColor: { rgb: "D9D9D9" } },
  alignment: { horizontal: "center" },
  border: BORDER,
};

const styleCell = (XLSX, ws, r, c, style) => {
  const ref = XLSX.utils.encode_cell({ r, c });
  if (!ws[ref]) ws[ref] = { t: "s", v: "" };
  ws[ref].s = style;
};

// One tab per WATI list. Which patient belongs where is decided in
// shared/patientLists.js, the same rules the page's tabs query by.
export const LIST_SHEETS = [
  { name: "New Patients", pick: LIST_PREDICATES.new },
  { name: "Follow Up", pick: LIST_PREDICATES.followup },
  { name: "Cancelled", pick: LIST_PREDICATES.cancelled },
  { name: "Rescheduled", pick: LIST_PREDICATES.rescheduled },
];

// One list, one flat block — no New/FU split, because the sheet IS the split.
export const buildListSheet = (XLSX, rows, date, title) => {
  const body = (rows || []).filter((r) => r?.phone).map((r) => toSheetRow(r, date));

  const titleRow = new Array(BLOCK_WIDTH).fill("");
  titleRow[0] = title;
  titleRow[3] = `${body.length} patient${body.length === 1 ? "" : "s"}`;
  titleRow[5] = fmtSheetDate(date);

  const ws = XLSX.utils.aoa_to_sheet([titleRow, [...HEADERS], ...body]);
  ws["!cols"] = COL_WIDTHS.map((wch) => ({ wch }));

  styleCell(XLSX, ws, 0, 0, BLOCK_STYLE);
  styleCell(XLSX, ws, 0, 3, TITLE_STYLE);
  styleCell(XLSX, ws, 0, 5, DATE_STYLE);
  HEADERS.forEach((_, i) => styleCell(XLSX, ws, 1, i, HEADER_STYLE));

  return { ws, count: body.length };
};

// Hands the finished workbook to the browser. writeFile is the library's own
// one-liner, but it is the part that silently does nothing when a browser
// refuses its synthetic click, so a failure there falls back to a Blob download
// we drive ourselves rather than leaving the button looking dead.
const downloadWorkbook = (XLSX, wb, filename) => {
  try {
    XLSX.writeFile(wb, filename);
    return;
  } catch (err) {
    console.error("[GHM export] writeFile failed, falling back to Blob download", err);
  }
  const data = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const url = URL.createObjectURL(
    new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export const exportWatiWorkbook = async (rows, date, fileLabel = "wati-appt-confirmation") => {
  const mod = await import("xlsx-js-style");
  // Interop: the CJS build lands on `default` through Vite, on the namespace
  // itself elsewhere. Reading only one of them is how the button dies silently.
  const XLSX = mod?.default?.utils ? mod.default : mod;
  if (!XLSX?.utils) throw new Error("Excel library failed to load — check the network tab");

  // One tab per list, always present so the file has the same shape every day —
  // an empty tab says "nobody in this list", which a missing tab does not.
  const built = LIST_SHEETS.map((list) => ({
    name: list.name,
    ...buildListSheet(XLSX, (rows || []).filter(list.pick), date, list.name),
  }));

  const counts = { total: 0, lists: {} };
  for (const sheet of built) {
    counts.lists[sheet.name] = sheet.count;
    counts.total += sheet.count;
  }
  if (!counts.total) return counts;

  const wb = XLSX.utils.book_new();
  for (const sheet of built) XLSX.utils.book_append_sheet(wb, sheet.ws, sheet.name);
  downloadWorkbook(XLSX, wb, `${fileLabel}_${String(date).slice(0, 10)}.xlsx`);
  return counts;
};
