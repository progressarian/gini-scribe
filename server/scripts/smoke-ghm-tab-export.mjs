import "../loadEnv.js";
import express from "express";
import router from "../routes/ghm-appointments.js";
import pool from "../config/db.js";
import { buildWatiBlocks, isNewVisit } from "../../src/lib/ghmWatiExport.js";

const date = process.argv[2] || new Date().toISOString().split("T")[0];
const outDir =
  process.env.SMOKE_OUT ||
  "/tmp/claude-1000/-home-anshul-Desktop-Ankit-Gurjot-gini-scribe/19aa4973-aa1d-42c6-b635-6e7b8fe70249/scratchpad";

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

// Every tab the Export Excel button can be pressed on, with the filters the UI
// sends and the title/label it exports under.
const TABS = [
  { id: "by_date", qs: "", label: "ghm-by-date", title: "" },
  { id: "new_patients", qs: "&visit=new", label: "wati-new-patients", title: "New patients" },
  {
    id: "followups",
    qs: "&visit=followup",
    label: "wati-follow-up-patients",
    title: "Follow-up patients",
  },
  { id: "cancelled", qs: "&call_status=cancelled", label: "wati-cancelled", title: "Cancelled" },
  {
    id: "rescheduled",
    qs: "&call_status=rescheduled",
    label: "wati-rescheduled",
    title: "Rescheduled",
  },
];

const seedIds = [];
try {
  const day = await get(`date=${date}&limit=100&page=1&export=1`);
  for (const [i, st] of ["cancelled", "rescheduled"].entries()) {
    if (!day[i]) continue;
    const prev = await pool.query("SELECT call_status FROM appointments WHERE id=$1", [day[i].id]);
    seedIds.push([day[i].id, prev.rows[0]?.call_status ?? null]);
    await pool.query("UPDATE appointments SET call_status=$2 WHERE id=$1", [day[i].id, st]);
  }

  const XLSX = (await import("xlsx-js-style")).default;
  const { buildWatiSheet } = await import("../../src/lib/ghmWatiExport.js");

  for (const tab of TABS) {
    const rows = await get(`date=${date}&limit=100&page=1&export=1${tab.qs}`);
    const blocks = buildWatiBlocks(rows, date);
    const { ws, counts } = buildWatiSheet(XLSX, rows, date, tab.title);

    expect(
      `${tab.id.padEnd(13)} exports ${rows.length} rows (${counts.fresh} new / ${counts.followUp} FU)`,
      counts.fresh + counts.followUp === rows.filter((r) => r.phone).length,
      `phones ${rows.filter((r) => r.phone).length}`,
    );
    expect(
      `${tab.id.padEnd(13)} splits new vs follow-up correctly`,
      blocks.fresh.length === rows.filter((r) => r.phone && isNewVisit(r.visit_type)).length,
    );

    const wb = XLSX.utils.book_new();
    const name = tab.title ? `For Wati_${tab.title}`.slice(0, 31) : "For Wati_Appt confirmation";
    XLSX.utils.book_append_sheet(wb, ws, name);
    const file = `${outDir}/${tab.label}_${date}.xlsx`;
    XLSX.writeFile(wb, file);
    const { statSync } = await import("fs");
    expect(`${tab.id.padEnd(13)} writes ${tab.label}_${date}.xlsx`, statSync(file).size > 0);

    const back = XLSX.readFile(file);
    expect(
      `${tab.id.padEnd(13)} sheet is named "${name}"`,
      back.SheetNames[0] === name,
      back.SheetNames.join(","),
    );
    if (tab.title) {
      const titleCell = back.Sheets[name][XLSX.utils.encode_cell({ r: 0, c: 9 })];
      expect(
        `${tab.id.padEnd(13)} sheet says "${tab.title}"`,
        titleCell?.v === tab.title,
        titleCell?.v,
      );
    }
  }
} finally {
  for (const [id, prev] of seedIds) {
    await pool.query("UPDATE appointments SET call_status=$2 WHERE id=$1", [id, prev]);
  }
  console.log(`Restored ${seedIds.length} call statuses`);
  server.close();
  await pool.end();
}
