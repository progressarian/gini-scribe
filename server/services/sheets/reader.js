// ── Google Sheets Reader — reads LIVE View of Today's patients ──────────────

import { google } from "googleapis";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = join(__dirname, "..", "..", "gini-ai-8fc66116e12e.json");
const SPREADSHEET_ID = "19MqkTjVb18KTa1_J0FKETPnEg-U2w7la-JpvR34GM18";
const SHEET_NAME = "LIVE View of Today's patients";

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
