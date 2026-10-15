import {
  LIST_PREDICATES,
  isNewVisitType,
  isEarlierVisitDue,
  cameOnDate,
} from "../../shared/patientLists.js";
import { callLabel } from "../../shared/callStatuses.js";
import { visitStatus } from "./visitStatus.js";
import { isInvestigationVisit } from "../../shared/labOnly.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const COL_WIDTHS = [
  22, 12, 14, 14, 12, 14, 12, 12, 14, 12, 6, 6, 16, 20, 14, 14, 14, 14, 14, 14, 26, 22, 18, 16, 12,
  16, 22, 30,
];

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
  "Assigned To",
  "Doctor",
  "Last_Visit_Date",
  "Follow_Up_Date",
  "Preferred_Date",
  "Visit Type",
  "Visit Status",
  "Mode",
  "Last Consultant Seen",
  "Prescription Explained By",
  "Call Status",
  "Called By",
  "Call Date",
  "Home Collection",
  "Preferred Time",
  "Notes / Reason",
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

const lastSeenLabel = (visit) =>
  [visit?.doctor, visit?.mo && `MO: ${visit.mo}`].filter(Boolean).join(" · ");

const BOOKING_COLS_AT = HEADERS.indexOf("Doctor") + 1;

const BOOKING_HEADERS = [
  ...HEADERS.slice(0, BOOKING_COLS_AT),
  "Booked By",
  "Booked At",
  ...HEADERS.slice(BOOKING_COLS_AT),
];

const NOT_IN_BOOKINGS = ["CountryCode", "AllowCampaign", "AllowSMS", "Prescription Explained By"];

const withBookingCols = (cells, values, bookings) =>
  bookings
    ? [...cells.slice(0, BOOKING_COLS_AT), ...values, ...cells.slice(BOOKING_COLS_AT)].filter(
        (_, i) => !NOT_IN_BOOKINGS.includes(BOOKING_HEADERS[i]),
      )
    : cells;

const fmtSheetTime = (value) =>
  value
    ? new Date(value).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Kolkata",
      })
    : "";

const toSheetRow = (row, fallbackDate, lastSeen = {}, owners = {}, bookings = false) => {
  const { code, number } = splitCountryCode(row.phone);
  const { start, end } = splitSlot(row.preferred_time_slot);
  return withBookingCols(
    [
      row.patient_name || "",
      code,
      number,
      "True",
      "True",
      fmtSheetDate(
        bookings || cameOnDate(row, fallbackDate)
          ? row.appointment_date || row.preferred_date
          : row.preferred_date || fallbackDate,
      ),
      start,
      end,
      (Array.isArray(row.alt_phone) ? row.alt_phone : [row.alt_phone])
        .filter(Boolean)
        .map((n) => splitCountryCode(n).number)
        .join(", "),
      row.file_no || "",
      row.disp_age ?? row.age ?? "",
      row.disp_sex || row.sex || "",
      owners[row.patient_id]?.assigned_to || "",
      row.doctor_name || row.preferred_doctor || "",
      fmtSheetDate(lastSeen[row.patient_id]?.date),
      isInvestigationVisit(row) ? "" : fmtSheetDate(row.follow_up_date),
      fmtSheetDate(row.preferred_date),
      !bookings && isEarlierVisitDue(row, fallbackDate) && isNewVisitType(row.visit_type)
        ? "Follow-Up"
        : row.visit_type || "",
      visitStatus(
        String(row.appointment_date || "").slice(0, 10) === String(fallbackDate).slice(0, 10)
          ? row.status
          : null,
      ).label,
      row.appointment_type || row.mode_of_appointment || "",
      lastSeenLabel(lastSeen[row.patient_id]),
      row.prescription_explained_by || "",
      // The STORED status, not the day-scoped one. On screen the status resets
      // each morning on purpose — an unreset list would read "already called" and
      // the team would skip patients on today's round. The sheet is the opposite
      // job: it is the record of what happened, read alongside Call Date, so a
      // call logged yesterday must still say so here.
      callLabel(row.call_status_any || "pending"),
      row.call_made_by || "",
      fmtSheetDate(row.call_date),
      row.home_collection ? "Yes" : "No",
      row.preferred_time_slot || "",
      row.notes || "",
    ],
    [row.booked_by_name || "", fmtSheetTime(row.booked_at)],
    bookings,
  );
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
  {
    name: "New Patients",
    pick: LIST_PREDICATES.new,
    omit: ["Preferred Time", "Last_Visit_Date", "Last Consultant Seen", "Start_Time", "End_Time"],
    preferredBookedBy: true,
  },
  { name: "Follow Up", pick: LIST_PREDICATES.followup },
  { name: "Cancelled", pick: LIST_PREDICATES.cancelled },
  { name: "Rescheduled", pick: LIST_PREDICATES.rescheduled },
];

// One list, one flat block — no New/FU split, because the sheet IS the split.
export const buildListSheet = (
  XLSX,
  rows,
  date,
  title,
  lastSeen = {},
  owners = {},
  bookings = false,
  omit = [],
  preferredBookedBy = false,
) => {
  const allHeaders = withBookingCols(HEADERS, ["Booked By", "Booked At"], bookings);
  const keepCols = allHeaders.filter((h) => !omit.includes(h));
  const bookedByAt = preferredBookedBy ? keepCols.indexOf("Preferred_Date") + 1 : -1;
  const keep = (cells, extra) => {
    const kept = cells.filter((_, i) => !omit.includes(allHeaders[i]));
    if (bookedByAt > 0) kept.splice(bookedByAt, 0, extra);
    return kept;
  };
  const body = (rows || [])
    .filter((r) => r?.phone)
    .map((r) =>
      keep(
        toSheetRow(r, date, lastSeen, owners, bookings),
        r.preferred_date ? r.preferred_set_by || r.booked_by_name || "" : "",
      ),
    );
  const headers = keep(allHeaders, "Booked By");

  const titleRow = new Array(headers.length).fill("");
  titleRow[0] = title;
  titleRow[3] = `${body.length} patient${body.length === 1 ? "" : "s"}`;
  titleRow[5] = fmtSheetDate(date);

  const ws = XLSX.utils.aoa_to_sheet([titleRow, headers, ...body]);
  ws["!cols"] = keep(withBookingCols(COL_WIDTHS, [18, 12], bookings), 14).map((wch) => ({ wch }));

  styleCell(XLSX, ws, 0, 0, BLOCK_STYLE);
  styleCell(XLSX, ws, 0, 3, TITLE_STYLE);
  styleCell(XLSX, ws, 0, 5, DATE_STYLE);
  headers.forEach((_, i) => styleCell(XLSX, ws, 1, i, HEADER_STYLE));

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

export const exportWatiWorkbook = async (
  rows,
  date,
  fileLabel = "wati-appt-confirmation",
  lastSeen = {},
  owners = {},
  { bookings = false, singleSheet = null } = {},
) => {
  const mod = await import("xlsx-js-style");
  // Interop: the CJS build lands on `default` through Vite, on the namespace
  // itself elsewhere. Reading only one of them is how the button dies silently.
  const XLSX = mod?.default?.utils ? mod.default : mod;
  if (!XLSX?.utils) throw new Error("Excel library failed to load — check the network tab");

  // One tab per list, always present so the file has the same shape every day —
  // an empty tab says "nobody in this list", which a missing tab does not.
  const sheets = singleSheet ? [{ name: singleSheet, pick: () => true }] : LIST_SHEETS;
  const built = sheets.map((list) => ({
    name: list.name,
    ...buildListSheet(
      XLSX,
      (rows || []).filter((r) => list.pick(r, date)),
      date,
      list.name,
      lastSeen,
      owners,
      bookings,
      list.omit,
      list.preferredBookedBy,
    ),
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
