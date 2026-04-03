// ── Google Sheets Reader — reads appointment tabs ───────────────────────────

import { google } from "googleapis";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = join(__dirname, "..", "..", "gini-ai-8fc66116e12e.json");
const SPREADSHEET_ID = "19MqkTjVb18KTa1_J0FKETPnEg-U2w7la-JpvR34GM18";
const SHEET_NAME = "LIVE View of Today's patients";

const UPCOMING_TABS = ["Tomorrow", "Day After", "Day After + 1"];

let sheetsClient = null;

function getClient() {
  if (sheetsClient) return sheetsClient;
  const creds = JSON.parse(readFileSync(CREDS_PATH, "utf8"));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

/**
 * Parse an upcoming-appointments tab into { date, headers, patients }
 * Layout: Row 0 = labels (Tomorrow/Day After/...), Row 1 = dates,
 *         Row 2 = column headers, Row 3+ = patient data.
 */
function parseSheetRows(rows) {
  if (!rows || rows.length < 3) return { date: null, headers: [], patients: [] };

  // Row 1 col 1 holds the date for this tab (e.g. "4/4/2026")
  const date = (rows[1]?.[1] || rows[1]?.[0] || "").toString().trim() || null;

  // Row 2 is always the header row
  const headers = (rows[2] || []).map((h) => (h || "").replace(/\n/g, " ").trim());

  const patients = [];
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => !(c || "").toString().trim())) continue;

    const patient = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      const val = (row[j] || "").toString().trim();
      if (key && val) patient[key] = val;
    }
    // Only include if at least 2 fields are populated
    if (Object.keys(patient).length >= 2) patients.push(patient);
  }

  return { date, headers, patients };
}

// ── Existing: LIVE View of Today's patients ─────────────────────────────────

export async function readTodaysPatients() {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_NAME,
  });

  const rows = res.data.values || [];
  if (rows.length < 3) return { date: null, patients: [] };

  // Row 0: wait time thresholds
  const waitTimeThresholds = (rows[0] || []).filter(Boolean);

  // Row 1: date + status notes
  const date = rows[1]?.[1] || null;
  const statusNotes = (rows[1] || []).filter((v, i) => i > 1 && v?.trim()).map((v) => v.trim());

  // Row 2: headers
  const headers = (rows[2] || []).map((h) => h.replace(/\n/g, " ").trim());

  // Row 3+: patient data
  const patients = [];
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[1]) continue; // skip empty rows (no file_no)

    const patient = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      const val = (row[j] || "").trim();
      if (key && val) patient[key] = val;
    }
    patients.push(patient);
  }

  return { date, waitTimeThresholds, statusNotes, patients };
}

// ── New: Read a single upcoming tab ─────────────────────────────────────────

export async function readSheetTab(tabName) {
  const sheets = getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: tabName,
  });
  return parseSheetRows(res.data.values || []);
}

// ── New: Read all 3 upcoming tabs in one call ───────────────────────────────

export async function readUpcomingAppointments() {
  const sheets = getClient();

  // Batch-read all 3 tabs in a single API call
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: UPCOMING_TABS,
  });

  const results = {};
  for (let i = 0; i < UPCOMING_TABS.length; i++) {
    const tabName = UPCOMING_TABS[i];
    const rows = res.data.valueRanges?.[i]?.values || [];
    results[tabName] = parseSheetRows(rows);
  }

  return results;
}
