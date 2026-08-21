import "../loadEnv.js";
import express from "express";
import router from "../routes/ghm-appointments.js";
import pool from "../config/db.js";
import { LIST_SHEETS, exportWatiWorkbook, isNewVisit } from "../../src/lib/ghmWatiExport.js";

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

const expect = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};

const seeded = [];
try {
  const day =
    (
      await (
        await fetch(
          `http://127.0.0.1:${port}/api/ghm-appointments?date=${date}&limit=100&page=1&export=1`,
        )
      ).json()
    ).data || [];

  for (const [i, st] of ["cancelled", "rescheduled"].entries()) {
    if (!day[i]) continue;
    const prev = await pool.query("SELECT call_status FROM appointments WHERE id=$1", [day[i].id]);
    seeded.push([day[i].id, prev.rows[0]?.call_status ?? null]);
    await pool.query("UPDATE appointments SET call_status=$2 WHERE id=$1", [day[i].id, st]);
  }

  const rows =
    (
      await (
        await fetch(
          `http://127.0.0.1:${port}/api/ghm-appointments?date=${date}&limit=100&page=1&export=1`,
        )
      ).json()
    ).data || [];

  const counts = await exportWatiWorkbook(rows, date, "smoke-sheets");
  console.log("counts:", JSON.stringify(counts));

  const XLSX = (await import("xlsx-js-style")).default;
  const wb = XLSX.readFile(`${outDir}/smoke-sheets_${date}.xlsx`);
  console.log("sheets:", wb.SheetNames.join(" | "));

  expect(
    "workbook has the WATI sheet plus one tab per list",
    wb.SheetNames.length === 1 + LIST_SHEETS.length &&
      LIST_SHEETS.every((l) => wb.SheetNames.includes(l.name)),
    wb.SheetNames.join(","),
  );

  const rowsIn = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }).slice(2);
  const phoned = rows.filter((r) => r.phone);
  const cancelled = phoned.filter((r) => r.call_status_any === "cancelled");
  const rescheduled = phoned.filter((r) => r.call_status_any === "rescheduled");
  const active = phoned.filter(
    (r) => r.call_status_any !== "cancelled" && r.call_status_any !== "rescheduled",
  );

  expect(
    "Cancelled tab holds the cancelled patients",
    rowsIn("Cancelled").length === cancelled.length,
    `${rowsIn("Cancelled").length} vs ${cancelled.length}`,
  );
  expect(
    "Rescheduled tab holds the rescheduled patients",
    rowsIn("Rescheduled").length === rescheduled.length,
    `${rowsIn("Rescheduled").length} vs ${rescheduled.length}`,
  );
  expect(
    "New Patients tab holds active new visits",
    rowsIn("New Patients").length === active.filter((r) => isNewVisit(r.visit_type)).length,
    `${rowsIn("New Patients").length} vs ${active.filter((r) => isNewVisit(r.visit_type)).length}`,
  );
  expect(
    "Follow Up tab holds active follow-ups",
    rowsIn("Follow Up").length === active.filter((r) => !isNewVisit(r.visit_type)).length,
    `${rowsIn("Follow Up").length} vs ${active.filter((r) => !isNewVisit(r.visit_type)).length}`,
  );
  expect(
    "the four tabs together cover every patient with a phone",
    ["New Patients", "Follow Up", "Cancelled", "Rescheduled"].reduce(
      (n, s) => n + rowsIn(s).length,
      0,
    ) === phoned.length,
    `${phoned.length} phoned`,
  );

  const first = wb.Sheets[wb.SheetNames[0]];
  expect(
    "the original WATI sheet is untouched (New at D1, FU at M1)",
    first.D1?.v === "New" && first.M1?.v === "FU",
    `${first.D1?.v} / ${first.M1?.v}`,
  );

  const head = XLSX.utils.sheet_to_json(wb.Sheets["Cancelled"], { header: 1 })[1];
  expect(
    "list tabs carry the WATI column headers",
    head?.[0] === "Name" && head?.[2] === "Phone",
    (head || []).join(","),
  );
} finally {
  for (const [id, prev] of seeded) {
    await pool.query("UPDATE appointments SET call_status=$2 WHERE id=$1", [id, prev]);
  }
  console.log(`Restored ${seeded.length} call statuses`);
  server.close();
  await pool.end();
}
