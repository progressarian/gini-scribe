const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const SHEET_NAME = "For Wati_Appt confirmation";

const NEW_BLOCK_COL = 0;
const FU_BLOCK_COL = 12;
const BLOCK_WIDTH = 8;
const TOTAL_COLS = FU_BLOCK_COL + BLOCK_WIDTH;

const COL_WIDTHS = [22, 12, 14, 14, 12, 14, 12, 12];

const HEADERS = [
  "Name",
  "CountryCode",
  "Phone",
  "AllowCampaign",
  "AllowSMS",
  "Appt_Date",
  "Start_Time",
  "End_Time",
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

export const isNewVisit = (visitType) =>
  !visitType || String(visitType).toLowerCase().includes("new");

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
  ];
};

export const buildWatiBlocks = (rows, fallbackDate) => {
  const fresh = [];
  const followUp = [];
  (rows || []).forEach((row) => {
    if (!row?.phone) return;
    (isNewVisit(row.visit_type) ? fresh : followUp).push(toSheetRow(row, fallbackDate));
  });
  return { fresh, followUp };
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

const DUPLICATE_STYLE = {
  font: { bold: true, color: { rgb: "FFFFFF" } },
  fill: { patternType: "solid", fgColor: { rgb: "FF0000" } },
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

const blankRow = () => new Array(TOTAL_COLS).fill("");

const place = (target, values, startCol) => {
  values.forEach((value, i) => {
    target[startCol + i] = value;
  });
};

export const buildWatiSheet = (XLSX, rows, date) => {
  const { fresh, followUp } = buildWatiBlocks(rows, date);

  const titleRow = blankRow();
  titleRow[0] = "Enter Date--->";
  titleRow[1] = fmtSheetDate(date);
  titleRow[NEW_BLOCK_COL + 3] = "New";
  titleRow[NEW_BLOCK_COL + 6] = "Duplicate Phone Number";
  titleRow[FU_BLOCK_COL] = "FU";
  titleRow[FU_BLOCK_COL + 3] = "Duplicate Phone Number";

  const headerRow = blankRow();
  place(headerRow, HEADERS, NEW_BLOCK_COL);
  place(headerRow, HEADERS, FU_BLOCK_COL);

  const body = [];
  for (let i = 0; i < Math.max(fresh.length, followUp.length); i += 1) {
    const line = blankRow();
    if (fresh[i]) place(line, fresh[i], NEW_BLOCK_COL);
    if (followUp[i]) place(line, followUp[i], FU_BLOCK_COL);
    body.push(line);
  }

  const ws = XLSX.utils.aoa_to_sheet([titleRow, headerRow, ...body]);
  ws["!cols"] = new Array(TOTAL_COLS).fill(null).map((_, i) => {
    const inNew = i >= NEW_BLOCK_COL && i < NEW_BLOCK_COL + BLOCK_WIDTH;
    const inFu = i >= FU_BLOCK_COL && i < FU_BLOCK_COL + BLOCK_WIDTH;
    if (inNew) return { wch: COL_WIDTHS[i - NEW_BLOCK_COL] };
    if (inFu) return { wch: COL_WIDTHS[i - FU_BLOCK_COL] };
    return { wch: 4 };
  });

  styleCell(XLSX, ws, 0, 0, TITLE_STYLE);
  styleCell(XLSX, ws, 0, 1, DATE_STYLE);
  styleCell(XLSX, ws, 0, NEW_BLOCK_COL + 3, BLOCK_STYLE);
  styleCell(XLSX, ws, 0, NEW_BLOCK_COL + 6, DUPLICATE_STYLE);
  styleCell(XLSX, ws, 0, FU_BLOCK_COL, BLOCK_STYLE);
  styleCell(XLSX, ws, 0, FU_BLOCK_COL + 3, DUPLICATE_STYLE);
  HEADERS.forEach((_, i) => {
    styleCell(XLSX, ws, 1, NEW_BLOCK_COL + i, HEADER_STYLE);
    styleCell(XLSX, ws, 1, FU_BLOCK_COL + i, HEADER_STYLE);
  });

  return { ws, counts: { fresh: fresh.length, followUp: followUp.length } };
};

export const exportWatiWorkbook = async (rows, date, fileLabel = "wati-appt-confirmation") => {
  const XLSX = (await import("xlsx-js-style")).default;
  const { ws, counts } = buildWatiSheet(XLSX, rows, date);
  if (!counts.fresh && !counts.followUp) return counts;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  XLSX.writeFile(wb, `${fileLabel}_${String(date).slice(0, 10)}.xlsx`);
  return counts;
};
