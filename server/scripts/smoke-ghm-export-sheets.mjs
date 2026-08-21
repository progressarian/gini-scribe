import "../loadEnv.js";
import express from "express";
import router from "../routes/ghm-appointments.js";
import pool from "../config/db.js";
import { LIST_SHEETS, exportWatiWorkbook } from "../../src/lib/ghmWatiExport.js";
import { LIST_PREDICATES } from "../../shared/patientLists.js";

const date = process.argv[2] || new Date().toISOString().split("T")[0];
const outDir =
  process.env.SMOKE_OUT ||
  "/tmp/claude-1000/-home-anshul-Desktop-Ankit-Gurjot-gini-scribe/19aa4973-aa1d-42c6-b635-6e7b8fe70249/scratchpad";
process.chdir(outDir);

const app = express();
app.use(express.json());
app.use("/api", router);
const server = app.listen(0);
const { port } = server.address();

const get = async (qs) =>
  (await (await fetch(`http://127.0.0.1:${port}/api/ghm-appointments?${qs}`)).json()).data || [];

const expect = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};

const restore = [];
try {
  const day = await get(`date=${date}&limit=100&page=1&export=1`);
  for (const [i, seed] of [{ status: "cancelled" }, { preferred_date: "2026-09-01" }].entries()) {
    if (!day[i]) continue;
    const prev = await pool.query("SELECT status, preferred_date FROM appointments WHERE id=$1", [
      day[i].id,
    ]);
    restore.push([day[i].id, prev.rows[0]]);
    const [col, val] = Object.entries(seed)[0];
    await pool.query(`UPDATE appointments SET ${col}=$2 WHERE id=$1`, [day[i].id, val]);
  }

  const rows = await get(`date=${date}&limit=100&page=1&export=1`);
  const counts = await exportWatiWorkbook(rows, date, "smoke-sheets");
  console.log("counts:", JSON.stringify(counts));

  const XLSX = (await import("xlsx-js-style")).default;
  const wb = XLSX.readFile(`${outDir}/smoke-sheets_${date}.xlsx`);
  console.log("sheets:", wb.SheetNames.join(" | "));

  expect(
    "workbook holds exactly the four list tabs",
    wb.SheetNames.length === LIST_SHEETS.length &&
      LIST_SHEETS.every((l, i) => wb.SheetNames[i] === l.name),
    wb.SheetNames.join(","),
  );
  expect(
    "the old combined WATI sheet is gone",
    !wb.SheetNames.some((n) => n.toLowerCase().includes("appt confirmation")),
    wb.SheetNames.join(","),
  );

  const bodyOf = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }).slice(2);
  const phoned = rows.filter((r) => r.phone);
  const byList = {
    "New Patients": "new",
    "Follow Up": "followup",
    Cancelled: "cancelled",
    Rescheduled: "rescheduled",
  };

  let placed = 0;
  for (const [sheet, list] of Object.entries(byList)) {
    const want = phoned.filter(LIST_PREDICATES[list]);
    const got = bodyOf(sheet);
    placed += got.length;
    expect(
      `${sheet.padEnd(13)} tab holds ${want.length} patient(s)`,
      got.length === want.length,
      `sheet ${got.length} vs expected ${want.length}`,
    );
    if (want.length) {
      const names = new Set(got.map((r) => r[0]));
      const absent = want.find((r) => !names.has(r.patient_name || ""));
      expect(
        `${sheet.padEnd(13)} tab lists the right people`,
        !absent,
        absent ? `${absent.patient_name} missing` : "",
      );
    }
    const head = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1 })[1];
    expect(
      `${sheet.padEnd(13)} tab carries the WATI headers`,
      head?.[0] === "Name" && head?.[2] === "Phone",
      (head || []).join(","),
    );
    const title = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1 })[0];
    expect(
      `${sheet.padEnd(13)} tab is titled and counted`,
      title?.[0] === sheet && String(title?.[3] || "").startsWith(String(got.length)),
      (title || []).join(","),
    );
  }
  expect(
    "every patient with a phone lands in exactly one tab",
    placed === phoned.length,
    `${placed} placed vs ${phoned.length} phoned`,
  );
} finally {
  for (const [id, prev] of restore) {
    await pool.query("UPDATE appointments SET status=$2, preferred_date=$3 WHERE id=$1", [
      id,
      prev.status,
      prev.preferred_date,
    ]);
  }
  console.log(`Restored ${restore.length} appointments`);
  server.close();
  await pool.end();
}
